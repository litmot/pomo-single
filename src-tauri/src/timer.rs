use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::db::Db;
use crate::windows;

pub const EV_TICK: &str = "timer://tick";
pub const EV_PHASE: &str = "timer://phase";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Idle,
    Focus,
    ShortBreak,
    LongBreak,
}

impl Phase {
    pub fn kind(&self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Focus => "focus",
            Phase::ShortBreak => "short_break",
            Phase::LongBreak => "long_break",
        }
    }

    pub fn is_break(&self) -> bool {
        matches!(self, Phase::ShortBreak | Phase::LongBreak)
    }
}

/// フロントに渡す表示用スナップショット。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerSnapshot {
    pub phase: Phase,
    pub running: bool,
    pub remaining_ms: i64,
    pub total_ms: i64,
    pub completed_focus_count: u32,
    pub current_task_id: Option<String>,
    pub interrupt_count: u32,
    /// 残り時間を見直しに充てている状態
    pub reviewing: bool,
    /// タスクが早く終わり、残り時間の使い道を待っている状態
    pub awaiting_choice: bool,
}

/// タイマーの内部状態。
///
/// 残り時間は「終了予定の絶対時刻」から毎回引き算して求める。
/// カウンタを 1 秒ずつ減らす実装にすると、スリープ復帰やスレッドの遅延で
/// 静かにずれていくため。
#[derive(Debug)]
pub struct TimerCore {
    pub phase: Phase,
    pub running: bool,
    pub total_ms: i64,
    /// running 中は毎 tick で再計算される。停止中は残量の保管場所。
    pub remaining_ms: i64,
    pub ends_at_ms: i64,
    pub completed_focus_count: u32,
    pub current_task_id: Option<String>,
    pub interrupt_count: u32,
    pub session_id: Option<String>,
    pub reviewing: bool,
    pub awaiting_choice: bool,
    /// このセッション中に 🍅 を付け終えたタスク。
    /// 1 ブロック = 1 ポモドーロを保ちつつ、引き継ぎで二重計上しないための記録。
    pub credited: Vec<String>,
}

impl Default for TimerCore {
    fn default() -> Self {
        TimerCore {
            phase: Phase::Idle,
            running: false,
            total_ms: 0,
            remaining_ms: 0,
            ends_at_ms: 0,
            completed_focus_count: 0,
            current_task_id: None,
            interrupt_count: 0,
            session_id: None,
            reviewing: false,
            awaiting_choice: false,
            credited: Vec::new(),
        }
    }
}

impl TimerCore {
    pub fn snapshot(&self) -> TimerSnapshot {
        TimerSnapshot {
            phase: self.phase,
            running: self.running,
            remaining_ms: self.remaining_ms.max(0),
            total_ms: self.total_ms,
            completed_focus_count: self.completed_focus_count,
            current_task_id: self.current_task_id.clone(),
            interrupt_count: self.interrupt_count,
            reviewing: self.reviewing,
            awaiting_choice: self.awaiting_choice,
        }
    }
}

pub struct Timer(pub Mutex<TimerCore>);

impl Timer {
    pub fn new() -> Self {
        Timer(Mutex::new(TimerCore::default()))
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn snapshot(app: &AppHandle) -> TimerSnapshot {
    app.state::<Timer>().0.lock().expect("timer lock").snapshot()
}

fn emit_phase(app: &AppHandle) {
    let snap = snapshot(app);
    let _ = app.emit(EV_PHASE, &snap);
    windows::sync_for_phase(app, snap.phase);
}

/* ------------------------------------------------------------------ */
/* transitions                                                         */
/* ------------------------------------------------------------------ */

/// 指定フェーズを開始する。セッション行もここで開く。
fn begin(app: &AppHandle, phase: Phase, task_id: Option<String>) -> Result<(), String> {
    let db = app.state::<Db>();
    let settings = db.get_settings()?;

    let minutes = match phase {
        Phase::Focus => settings.focus_minutes,
        Phase::ShortBreak => settings.short_break_minutes,
        Phase::LongBreak => settings.long_break_minutes,
        Phase::Idle => 0,
    };
    let total_ms = minutes as i64 * 60_000;

    let session_id = if phase == Phase::Idle {
        None
    } else {
        Some(db.open_session(task_id.as_deref(), phase.kind(), total_ms)?)
    };

    {
        let timer = app.state::<Timer>();
        let mut core = timer.0.lock().map_err(|e| e.to_string())?;
        core.phase = phase;
        core.running = phase != Phase::Idle;
        core.total_ms = total_ms;
        core.remaining_ms = total_ms;
        core.ends_at_ms = now_ms() + total_ms;
        core.interrupt_count = 0;
        core.session_id = session_id;
        core.reviewing = false;
        core.awaiting_choice = false;
        core.credited.clear();
        if phase == Phase::Focus {
            core.current_task_id = task_id;
        }
    }

    // Idle に戻ったとき、完了済みのタスクが「次にやる」に残っていると
    // そのまま集中を開始できてしまう。ここで一度きれいにする。
    if phase == Phase::Idle {
        let current = snapshot(app).current_task_id;
        let finished = match &current {
            Some(id) => matches!(db.get_task(id), Ok(Some(t)) if t.status == "done"),
            None => false,
        };
        if finished {
            let timer = app.state::<Timer>();
            let mut core = timer.0.lock().map_err(|e| e.to_string())?;
            core.current_task_id = None;
            drop(core);
        }
    }

    // 集中を始めた瞬間にタスクを doing にしておくと、途中で管理画面を見たときに
    // 「どれに着手中か」が状態として残る
    if phase == Phase::Focus {
        let id = snapshot(app).current_task_id;
        if let Some(id) = id {
            let _ = db.set_task_status(&id, "doing");
            let _ = app.emit(crate::EV_TASKS_CHANGED, ());
        }
    }

    emit_phase(app);
    Ok(())
}

/// 現在のフェーズを閉じ、次のフェーズへ進める。
///
/// `completed` が false の場合は「やり切らなかった」記録になり、
/// ポモドーロの実績にも数えない。
fn finish_current(app: &AppHandle, completed: bool, outcome: &str) -> Result<Phase, String> {
    let db = app.state::<Db>();
    let settings = db.get_settings()?;

    let (phase, session_id, interrupts, task_id) = {
        let timer = app.state::<Timer>();
        let core = timer.0.lock().map_err(|e| e.to_string())?;
        (
            core.phase,
            core.session_id.clone(),
            core.interrupt_count,
            core.current_task_id.clone(),
        )
    };

    if let Some(sid) = &session_id {
        db.close_session(sid, completed, interrupts, outcome)?;
    }

    let next = match phase {
        Phase::Focus => {
            if completed {
                let count = {
                    let timer = app.state::<Timer>();
                    let mut core = timer.0.lock().map_err(|e| e.to_string())?;
                    core.completed_focus_count += 1;
                    core.completed_focus_count
                };
                // 着手していたタスクに 🍅 を 1 つ。ただしこのセッション中に
                // 既に付けたタスク (引き継ぎ前に完了した分) には付け直さない。
                if let Some(id) = &task_id {
                    if credit(app, id) {
                        let _ = db.bump_actual_pomodoros(id);
                        let _ = app.emit(crate::EV_TASKS_CHANGED, ());
                    }
                }
                // 長休憩の周期。0 除算を避けるため下限 1
                let every = settings.long_break_every.max(1);
                if count % every == 0 {
                    Phase::LongBreak
                } else {
                    Phase::ShortBreak
                }
            } else {
                Phase::Idle
            }
        }
        // 休憩のあとは自動で次の集中に入らない。始めるかどうかは毎回自分で決める。
        Phase::ShortBreak | Phase::LongBreak => Phase::Idle,
        Phase::Idle => Phase::Idle,
    };

    Ok(next)
}

/// このセッションで初めて 🍅 を付けるタスクなら true を返して記録する。
fn credit(app: &AppHandle, task_id: &str) -> bool {
    let timer = app.state::<Timer>();
    let Ok(mut core) = timer.0.lock() else {
        return false;
    };
    if core.credited.iter().any(|id| id == task_id) {
        return false;
    }
    core.credited.push(task_id.to_string());
    true
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    if app
        .state::<Db>()
        .get_settings()
        .map(|s| s.sound_enabled)
        .unwrap_or(true)
    {
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

/// フェーズが時間切れになったときの遷移。tick スレッドから呼ばれる。
fn on_elapsed(app: &AppHandle) {
    let ended = snapshot(app).phase;
    let next = match finish_current(app, true, "rang") {
        Ok(n) => n,
        Err(_) => Phase::Idle,
    };

    match ended {
        Phase::Focus => notify(app, "集中の終わり", "休憩に入ります。"),
        Phase::ShortBreak | Phase::LongBreak => {
            notify(app, "休憩の終わり", "次にやる 1 件を決めてください。")
        }
        Phase::Idle => {}
    }

    let task_id = snapshot(app).current_task_id;
    let _ = begin(app, next, task_id);
}

/* ------------------------------------------------------------------ */
/* public API (commands から呼ばれる)                                  */
/* ------------------------------------------------------------------ */

pub fn state(app: &AppHandle) -> TimerSnapshot {
    snapshot(app)
}

pub fn start(app: &AppHandle, task_id: Option<String>) -> Result<TimerSnapshot, String> {
    let current = task_id.or_else(|| snapshot(app).current_task_id);
    begin(app, Phase::Focus, current)?;
    Ok(snapshot(app))
}

pub fn pause(app: &AppHandle) -> Result<TimerSnapshot, String> {
    {
        let timer = app.state::<Timer>();
        let mut core = timer.0.lock().map_err(|e| e.to_string())?;
        if core.running {
            core.remaining_ms = (core.ends_at_ms - now_ms()).max(0);
            core.running = false;
        }
    }
    let snap = snapshot(app);
    let _ = app.emit(EV_PHASE, &snap);
    Ok(snap)
}

pub fn resume(app: &AppHandle) -> Result<TimerSnapshot, String> {
    {
        let timer = app.state::<Timer>();
        let mut core = timer.0.lock().map_err(|e| e.to_string())?;
        if !core.running && core.phase != Phase::Idle {
            core.ends_at_ms = now_ms() + core.remaining_ms.max(0);
            core.running = true;
        }
    }
    let snap = snapshot(app);
    let _ = app.emit(EV_PHASE, &snap);
    Ok(snap)
}

/// 現在のフェーズを完了扱いにせず次へ送る。
pub fn skip(app: &AppHandle) -> Result<TimerSnapshot, String> {
    let next = finish_current(app, false, "skipped")?;
    let task_id = snapshot(app).current_task_id;
    begin(app, next, task_id)?;
    Ok(snapshot(app))
}

/// セッションを投げ出して Idle に戻る。管理画面が再び前に出る。
pub fn stop(app: &AppHandle) -> Result<TimerSnapshot, String> {
    let phase = snapshot(app).phase;
    if phase == Phase::Focus {
        // 集中を切ったこと自体を 1 回の中断として残す
        let timer = app.state::<Timer>();
        let mut core = timer.0.lock().map_err(|e| e.to_string())?;
        core.interrupt_count += 1;
        drop(core);
    }
    let _ = finish_current(app, false, "abandoned")?;

    // 着手中だったタスクは todo に戻す。doing のまま放置しない
    let task_id = snapshot(app).current_task_id;
    if let Some(id) = &task_id {
        let db = app.state::<Db>();
        if let Ok(Some(t)) = db.get_task(id) {
            if t.status == "doing" {
                let _ = db.set_task_status(id, "todo");
                let _ = app.emit(crate::EV_TASKS_CHANGED, ());
            }
        }
    }

    begin(app, Phase::Idle, task_id)?;
    Ok(snapshot(app))
}

/// タスク切り替えなどの割り込みを 1 件記録する。
pub fn interrupt(app: &AppHandle, _reason: &str) -> Result<TimerSnapshot, String> {
    {
        let timer = app.state::<Timer>();
        let mut core = timer.0.lock().map_err(|e| e.to_string())?;
        core.interrupt_count += 1;
    }
    let snap = snapshot(app);
    let _ = app.emit(EV_PHASE, &snap);
    Ok(snap)
}

/* ------------------------------------------------------------------ */
/* タスクが早く終わったとき                                             */
/* ------------------------------------------------------------------ */

/// 着手中のタスクを完了にする。
///
/// 集中中なら、タイマーは止めずに「残り時間の使い道」を待つ状態に入る。
/// ポモドーロは分割できない、という原則を崩さないための挙動。
/// 完了は中断ではないので、interrupt_count には触れない。
pub fn complete_current_task(app: &AppHandle) -> Result<TimerSnapshot, String> {
    let db = app.state::<Db>();
    let (phase, task_id) = {
        let snap = snapshot(app);
        (snap.phase, snap.current_task_id)
    };
    let Some(id) = task_id else {
        return Err("no current task".into());
    };

    db.set_task_status(&id, "done")?;
    // 約束を果たしたぶんの 🍅 はその場で付ける。鳴る前に終えたことで
    // 実績が減る設計にすると、終わっても報告しない方向に歪む。
    if phase == Phase::Focus && credit(app, &id) {
        let _ = db.bump_actual_pomodoros(&id);
    }
    let _ = app.emit(crate::EV_TASKS_CHANGED, ());

    if phase == Phase::Focus {
        let timer = app.state::<Timer>();
        let mut core = timer.0.lock().map_err(|e| e.to_string())?;
        core.awaiting_choice = true;
        core.reviewing = false;
        drop(core);
    }

    emit_phase(app);
    Ok(snapshot(app))
}

/// 残り時間を見直しに充てる。原典どおり、鳴るまで走らせる。
pub fn choose_review(app: &AppHandle) -> Result<TimerSnapshot, String> {
    {
        let timer = app.state::<Timer>();
        let mut core = timer.0.lock().map_err(|e| e.to_string())?;
        core.awaiting_choice = false;
        core.reviewing = true;
    }
    emit_phase(app);
    Ok(snapshot(app))
}

/// 同じセッションを引き継いで次の 1 件に着手する。
///
/// 終了予定時刻は動かさない。ここを延ばすと 25 分の枠がタスクの長さに
/// 引きずられ、実績データが意味を失う。
pub fn choose_handoff(app: &AppHandle, task_id: String) -> Result<TimerSnapshot, String> {
    let db = app.state::<Db>();
    {
        let timer = app.state::<Timer>();
        let mut core = timer.0.lock().map_err(|e| e.to_string())?;
        core.awaiting_choice = false;
        core.reviewing = false;
        core.current_task_id = Some(task_id.clone());
    }
    let _ = db.set_task_status(&task_id, "doing");
    // 新しい着手先を先に知らせる。タスク一覧の更新を先に流すと、
    // 受け手が古い ID で取り直しに走る余地が生まれる。
    emit_phase(app);
    let _ = app.emit(crate::EV_TASKS_CHANGED, ());
    Ok(snapshot(app))
}

/// 残り時間を切り上げて休憩に入る。
///
/// ポモドーロは完了として計上する。タスクを終わらせた人が実績で損をする
/// 設計にはしない。
pub fn choose_break(app: &AppHandle) -> Result<TimerSnapshot, String> {
    {
        let timer = app.state::<Timer>();
        let mut core = timer.0.lock().map_err(|e| e.to_string())?;
        core.awaiting_choice = false;
    }
    let next = finish_current(app, true, "done_early_break")?;
    let task_id = snapshot(app).current_task_id;
    begin(app, next, task_id)?;
    Ok(snapshot(app))
}

/// 「次にやる」候補。完了したのがサブタスクなら同じ親の兄弟を優先する。
pub fn next_candidates(app: &AppHandle, limit: i64) -> Result<Vec<crate::db::Task>, String> {
    let db = app.state::<Db>();
    let current = snapshot(app).current_task_id;
    let (exclude, parent) = match &current {
        Some(id) => {
            let parent = db.get_task(id)?.and_then(|t| t.parent_id);
            (id.clone(), parent)
        }
        None => (String::new(), None),
    };
    db.next_candidates(&exclude, parent.as_deref(), limit)
}

pub fn set_current_task(app: &AppHandle, task_id: Option<String>) -> Result<(), String> {
    {
        let timer = app.state::<Timer>();
        let mut core = timer.0.lock().map_err(|e| e.to_string())?;
        core.current_task_id = task_id;
    }
    let _ = app.emit(EV_PHASE, snapshot(app));
    Ok(())
}

/* ------------------------------------------------------------------ */
/* tick loop                                                           */
/* ------------------------------------------------------------------ */

/// 200ms 間隔で残り時間を再計算し、表示秒が変わったときだけ emit する。
/// JS 側の setInterval はウィンドウが隠れるとスロットリングされるため、
/// 計時をフロントに持たせてはいけない。
pub fn spawn_tick_loop(app: AppHandle) {
    thread::spawn(move || {
        let mut last_shown_sec = i64::MIN;
        loop {
            thread::sleep(Duration::from_millis(200));

            let (running, remaining) = {
                let timer = app.state::<Timer>();
                let mut core = match timer.0.lock() {
                    Ok(c) => c,
                    Err(_) => continue,
                };
                if core.running {
                    core.remaining_ms = core.ends_at_ms - now_ms();
                }
                (core.running, core.remaining_ms)
            };

            if !running {
                continue;
            }

            if remaining <= 0 {
                on_elapsed(&app);
                last_shown_sec = i64::MIN;
                continue;
            }

            let sec = (remaining + 999) / 1000;
            if sec != last_shown_sec {
                last_shown_sec = sec;
                let _ = app.emit(EV_TICK, snapshot(&app));
            }
        }
    });
}

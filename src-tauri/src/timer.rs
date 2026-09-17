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
    /// 助走のための短い集中。ポモドーロではない。
    ///
    /// 25 分が重くて着手できないときの着火用。実績には数えない
    /// (🍅 も付かない、長い休憩の周期にも入らない、日次の集計からも外れる)
    /// — 1 🍅 = 標準の集中 1 本という単位を崩さないため。
    ShortFocus,
    ShortBreak,
    LongBreak,
}

impl Phase {
    pub fn kind(&self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Focus => "focus",
            Phase::ShortFocus => "short_focus",
            Phase::ShortBreak => "short_break",
            Phase::LongBreak => "long_break",
        }
    }

    pub fn is_break(&self) -> bool {
        matches!(self, Phase::ShortBreak | Phase::LongBreak)
    }

    /// 手を動かすフェーズか。集中と短い集中の両方。
    pub fn is_work(&self) -> bool {
        matches!(self, Phase::Focus | Phase::ShortFocus)
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
    /// 休憩明けで Idle に戻ったとき、その直前に着手していたタスク。
    /// 「同じタスクでもう一度」を出すかの判断に使う。
    pub after_break_task_id: Option<String>,
    /// この休憩では暗幕を自分で外した
    pub dim_lifted: bool,
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
    /// 休憩明けに Idle へ戻ったときの、直前に着手していたタスク。
    ///
    /// 真偽値ではなく ID を持つのは、休憩明けに別のタスクを選び直した場合に
    /// 「同じタスクでもう一度」と名乗らせないため。次の集中を始めた時点で消える。
    pub after_break_task_id: Option<String>,
    /// この休憩では暗幕を自分で外したか。
    ///
    /// フェーズごとに降ろす。休憩ごとに判断させたいので、一度外したことを
    /// 次の休憩まで引きずらない。
    pub dim_lifted: bool,
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
            after_break_task_id: None,
            dim_lifted: false,
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
            after_break_task_id: self.after_break_task_id.clone(),
            dim_lifted: self.dim_lifted,
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
        Phase::ShortFocus => settings.short_focus_minutes,
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
        // 休憩や短い集中を終えて手が空いた、という事実を次の画面へ持ち越す。
        // どのタスクの続きなのかまで持たないと、選び直したときに嘘になる。
        // 短い集中は助走なので、そのまま本番の 1 本に入れるようにしておく。
        let handing_off = core.phase.is_break() || core.phase == Phase::ShortFocus;
        core.after_break_task_id = if phase == Phase::Idle && handing_off {
            core.current_task_id.clone()
        } else {
            None
        };
        core.dim_lifted = false;
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
        if phase.is_work() {
            core.current_task_id = task_id;
        }
    }

    // Idle に戻ったとき、完了済み・待ちのタスクが「次にやる」に残っていると
    // そのまま集中を開始できてしまう。ここで一度きれいにする。
    if phase == Phase::Idle {
        let current = snapshot(app).current_task_id;
        let finished = match &current {
            Some(id) => {
                matches!(db.get_task(id), Ok(Some(t)) if t.status == "done" || t.status == "waiting")
            }
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
    if phase.is_work() {
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
        // 短い集中のあとに休憩は挟まない。10 分の助走に 5 分の休憩を足すと、
        // せっかく温まった勢いをそこで切ることになる。一覧に戻して、
        // そのまま本番の 1 本に入るか決めさせる。
        Phase::ShortFocus => Phase::Idle,
        // 休憩のあとは自動で次の集中に入らない。始めるかどうかは毎回自分で決める。
        Phase::ShortBreak | Phase::LongBreak => Phase::Idle,
        Phase::Idle => Phase::Idle,
    };

    Ok(next)
}

/// 2 つのタスクが「同じ仕事」に属するか。
///
/// 親を根として比べる。親とその子、同じ親の兄弟同士は同じ仕事。
/// この中での移動は約束した 1 件の内訳を進んでいるだけなので、
/// 集中を切られたことにはしない。
fn same_work(a: &crate::db::Task, b: &crate::db::Task) -> bool {
    let root = |t: &crate::db::Task| t.parent_id.clone().unwrap_or_else(|| t.id.clone());
    root(a) == root(b)
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
        Phase::ShortFocus => notify(app, "短い集中の終わり", "続けるか、ここで区切るか決めてください。"),
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

/// 短い集中を始める。ポモドーロとしては数えない。
pub fn start_short(app: &AppHandle, task_id: Option<String>) -> Result<TimerSnapshot, String> {
    let current = task_id.or_else(|| snapshot(app).current_task_id);
    begin(app, Phase::ShortFocus, current)?;
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
pub fn complete_current_task(app: &AppHandle) -> Result<TimerSnapshot, String> {
    release_current_task(app, |db, id| db.set_task_status(id, "done").map(|_| ()))
}

/// 着手中のタスクを待ちにする。相手待ちで、この枠ではもう進められない状態。
///
/// 完了と同じ流れに乗せる。本人の手がその場で空くという点は同じで、
/// 空いた残り時間の使い道を選ばせないと、ただ手持ち無沙汰になる。
pub fn wait_current_task(
    app: &AppHandle,
    waiting_for: Option<String>,
    waiting_until: Option<String>,
) -> Result<TimerSnapshot, String> {
    release_current_task(app, move |db, id| {
        db.set_waiting(id, waiting_for.as_deref(), waiting_until.as_deref())
            .map(|_| ())
    })
}

/// 着手中のタスクから手を離し、「残り時間の使い道」を待つ状態に入る。
///
/// 集中中でもタイマーは止めない。ポモドーロは分割できない、という原則を
/// 崩さないための挙動。手を離すのは中断ではないので interrupt_count には
/// 触れない。
///
/// 🍅 はその場で付ける。鳴る前に手が空いたことで実績が減る設計にすると、
/// 終わっても・詰まっても報告しない方向に歪む。
fn release_current_task(
    app: &AppHandle,
    change: impl FnOnce(&Db, &str) -> Result<(), String>,
) -> Result<TimerSnapshot, String> {
    let db = app.state::<Db>();
    let (phase, task_id) = {
        let snap = snapshot(app);
        (snap.phase, snap.current_task_id)
    };
    let Some(id) = task_id else {
        return Err("no current task".into());
    };

    change(&db, &id)?;
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

    // 短い集中では残り時間の使い道を聞かない。守るべき 25 分の枠が無いので、
    // 手が空いたらそこで区切り、一覧に戻して続けるか決めさせる。
    if phase == Phase::ShortFocus {
        let _ = finish_current(app, true, "done_early_break")?;
        let next = snapshot(app).current_task_id;
        begin(app, Phase::Idle, next)?;
        return Ok(snapshot(app));
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

/// 休憩中の暗幕を外す / 掛け直す。
///
/// 席で休む (コーヒーを飲む) のと、PC で休む (動画を見る、調べ物をする) のは
/// どちらも休憩。後者を暗幕で潰してしまうと、休憩そのものを避けるように
/// なってしまう。外したことは今の休憩の間だけ覚える。
pub fn set_dim(app: &AppHandle, on: bool) -> Result<TimerSnapshot, String> {
    {
        let timer = app.state::<Timer>();
        let mut core = timer.0.lock().map_err(|e| e.to_string())?;
        core.dim_lifted = !on;
    }
    emit_phase(app);
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

/// 着手先を切り替える。
///
/// 同じ親の下 (兄弟サブタスク、または親と its 子) の移動は「中断」に数えない。
/// 約束した 1 件の内訳を進んでいるだけで、集中を切られたわけではないため。
/// 別の系統へ飛ぶ場合だけ中断として記録する。
pub fn switch_current_task(app: &AppHandle, task_id: String) -> Result<TimerSnapshot, String> {
    let db = app.state::<Db>();
    let previous = snapshot(app).current_task_id;

    let same_tree = match &previous {
        Some(from) if from == &task_id => true,
        Some(from) => match (db.get_task(from)?, db.get_task(&task_id)?) {
            (Some(a), Some(b)) => same_work(&a, &b),
            _ => false,
        },
        None => true,
    };

    {
        let timer = app.state::<Timer>();
        let mut core = timer.0.lock().map_err(|e| e.to_string())?;
        core.current_task_id = Some(task_id.clone());
        if !same_tree && core.phase == Phase::Focus {
            core.interrupt_count += 1;
        }
    }

    let _ = db.set_task_status(&task_id, "doing");
    emit_phase(app);
    let _ = app.emit(crate::EV_TASKS_CHANGED, ());
    Ok(snapshot(app))
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
        // 日付が変わったら、その日の定型をタスクに追加する。起動しっぱなしで
        // 日をまたぐ (会社の PC でスリープ運用) ときのため
        let mut last_day = chrono::Local::now().date_naive();
        let mut ticks: u32 = 0;
        loop {
            thread::sleep(Duration::from_millis(200));
            ticks = ticks.wrapping_add(1);
            if ticks % 50 == 0 {
                let today = chrono::Local::now().date_naive();
                if today != last_day {
                    last_day = today;
                    let db = app.state::<Db>();
                    if let Ok(n) = db.spawn_due_routines(today) {
                        if n > 0 {
                            let _ = app.emit(crate::EV_TASKS_CHANGED, ());
                            let _ = app.emit(crate::EV_ROUTINES_CHANGED, ());
                        }
                    }
                }
            }

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Task;

    fn task(id: &str, parent: Option<&str>) -> Task {
        Task {
            id: id.into(),
            title: id.into(),
            note: None,
            status: "todo".into(),
            parent_id: parent.map(Into::into),
            sort_order: 0.0,
            urgency: None,
            importance: None,
            estimate_pomodoros: None,
            actual_pomodoros: 0,
            due: None,
            waiting_for: None,
            waiting_until: None,
            created_at: String::new(),
            completed_at: None,
            prev_status: None,
            routine_id: None,
        }
    }

    #[test]
    fn siblings_belong_to_the_same_work() {
        let a = task("sub-a", Some("parent"));
        let b = task("sub-b", Some("parent"));
        assert!(same_work(&a, &b), "同じ親の兄弟は同じ仕事");
    }

    #[test]
    fn a_parent_and_its_child_belong_to_the_same_work() {
        let parent = task("parent", None);
        let child = task("sub", Some("parent"));
        assert!(same_work(&parent, &child));
        assert!(same_work(&child, &parent));
    }

    #[test]
    fn tasks_from_different_trees_are_different_work() {
        let a = task("sub-a", Some("parent-a"));
        let b = task("sub-b", Some("parent-b"));
        assert!(!same_work(&a, &b), "別の親の下は別の仕事");

        let lone_a = task("alone-a", None);
        let lone_b = task("alone-b", None);
        assert!(!same_work(&lone_a, &lone_b), "親のない別タスクは別の仕事");
    }
}

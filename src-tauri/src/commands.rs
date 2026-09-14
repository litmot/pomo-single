use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{Db, Settings, Task, TaskPatch, TodayStats};
use crate::timer::{self, TimerSnapshot};
use crate::windows;
use crate::{EV_INBOX_ADDED, EV_SETTINGS_CHANGED, EV_TASKS_CHANGED};

type R<T> = Result<T, String>;

/// 次の予定を置く setting のキー
const NEXT_APPOINTMENT: &str = "next_appointment";

/* ---------------- tasks ---------------- */

#[tauri::command]
pub fn list_tasks(db: State<'_, Db>, statuses: Option<Vec<String>>) -> R<Vec<Task>> {
    db.list_tasks(statuses)
}

#[tauri::command]
pub fn create_task(
    app: AppHandle,
    db: State<'_, Db>,
    title: String,
    status: String,
    parent_id: Option<String>,
    at_top: Option<bool>,
) -> R<Task> {
    let task = db.create_task_at(
        title.trim(),
        &status,
        parent_id.as_deref(),
        at_top.unwrap_or(false),
    )?;
    let _ = app.emit(EV_TASKS_CHANGED, ());
    Ok(task)
}

/// Quick Capture の着地点。必ず inbox に入り、専用イベントを流す。
///
/// 分類も確認もさせないのが要点。Focus View 側はこのイベントを受けて
/// 件数ではなくパルスだけを出す。
#[tauri::command]
pub fn quick_capture(
    app: AppHandle,
    db: State<'_, Db>,
    title: String,
    at_top: Option<bool>,
) -> R<Task> {
    let title = title.trim();
    if title.is_empty() {
        return Err("empty title".into());
    }
    let task = db.create_task_at(title, "inbox", None, at_top.unwrap_or(false))?;
    let _ = app.emit(
        EV_INBOX_ADDED,
        serde_json::json!({ "taskId": task.id, "title": task.title }),
    );
    let _ = app.emit(EV_TASKS_CHANGED, ());
    Ok(task)
}

#[tauri::command]
pub fn update_task(app: AppHandle, db: State<'_, Db>, id: String, patch: TaskPatch) -> R<Task> {
    let task = db.update_task(&id, &patch)?;
    let _ = app.emit(EV_TASKS_CHANGED, ());
    Ok(task)
}

#[tauri::command]
pub fn set_task_status(app: AppHandle, db: State<'_, Db>, id: String, status: String) -> R<Task> {
    let task = db.set_task_status(&id, &status)?;
    let _ = app.emit(EV_TASKS_CHANGED, ());
    Ok(task)
}

/// Inbox の 1 件をタスクにする。貼り付けた文章は 1 行目が名前、全文がメモになる。
#[tauri::command]
pub fn promote_inbox(app: AppHandle, db: State<'_, Db>, id: String) -> R<Task> {
    let task = db.promote_inbox(&id)?;
    let _ = app.emit(EV_TASKS_CHANGED, ());
    Ok(task)
}

/// タスクを待ちにする。相手の動きが要因なので、着手対象からは外す。
#[tauri::command]
pub fn set_waiting(
    app: AppHandle,
    db: State<'_, Db>,
    id: String,
    waiting_for: Option<String>,
    waiting_until: Option<String>,
) -> R<Task> {
    let task = db.set_waiting(&id, waiting_for.as_deref(), waiting_until.as_deref())?;
    // 待ちのタスクは手を動かせない。選んだままにしておく意味がない
    if timer::state(&app).current_task_id.as_deref() == Some(id.as_str()) {
        timer::set_current_task(&app, None)?;
    }
    let _ = app.emit(EV_TASKS_CHANGED, ());
    Ok(task)
}

#[tauri::command]
pub fn clear_waiting(app: AppHandle, db: State<'_, Db>, id: String) -> R<Task> {
    let task = db.clear_waiting(&id)?;
    let _ = app.emit(EV_TASKS_CHANGED, ());
    Ok(task)
}

/// タスクを一時メモに戻す。名前・メモ・サブタスクを 1 つの文章に畳む。
#[tauri::command]
pub fn demote_to_inbox(app: AppHandle, db: State<'_, Db>, id: String) -> R<Task> {
    let memo = db.demote_to_inbox(&id)?;
    // 着手対象だったものが一時メモに戻ったら、選択も外す
    if timer::state(&app).current_task_id.as_deref() == Some(id.as_str()) {
        timer::set_current_task(&app, None)?;
    }
    let _ = app.emit(EV_TASKS_CHANGED, ());
    Ok(memo)
}

/// タスクをゴミ箱へ入れる。誤って消したときに戻せるようにするため、
/// 画面からの「削除」「捨てる」はすべてこちらを通す。
#[tauri::command]
pub fn trash_task(app: AppHandle, db: State<'_, Db>, id: String) -> R<()> {
    db.trash_task(&id)?;
    if timer::state(&app).current_task_id.as_deref() == Some(id.as_str()) {
        timer::set_current_task(&app, None)?;
    }
    let _ = app.emit(EV_TASKS_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn restore_task(app: AppHandle, db: State<'_, Db>, id: String) -> R<Task> {
    let task = db.restore_task(&id)?;
    let _ = app.emit(EV_TASKS_CHANGED, ());
    Ok(task)
}

#[tauri::command]
pub fn list_trash(db: State<'_, Db>) -> R<Vec<Task>> {
    db.list_trash()
}

#[tauri::command]
pub fn empty_trash(app: AppHandle, db: State<'_, Db>) -> R<usize> {
    let removed = db.purge_trash()?;
    let _ = app.emit(EV_TASKS_CHANGED, ());
    Ok(removed)
}

/// ゴミ箱から完全に消す。戻せない。
#[tauri::command]
pub fn delete_task(app: AppHandle, db: State<'_, Db>, id: String) -> R<()> {
    db.delete_task(&id)?;
    // 消したタスクが「次にやる 1 件」だった場合は選択も外す
    if timer::state(&app).current_task_id.as_deref() == Some(id.as_str()) {
        timer::set_current_task(&app, None)?;
    }
    let _ = app.emit(EV_TASKS_CHANGED, ());
    Ok(())
}

/// タスクを別の位置へ動かす。並べ替えと階層の移動を兼ねる。
#[tauri::command]
pub fn move_task(
    app: AppHandle,
    db: State<'_, Db>,
    id: String,
    parent_id: Option<String>,
    after_id: Option<String>,
) -> R<()> {
    db.move_task(&id, parent_id.as_deref(), after_id.as_deref())?;
    let _ = app.emit(EV_TASKS_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn reorder_tasks(app: AppHandle, db: State<'_, Db>, ids: Vec<String>) -> R<()> {
    db.reorder_tasks(&ids)?;
    let _ = app.emit(EV_TASKS_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn inbox_count(db: State<'_, Db>) -> R<i64> {
    db.inbox_count()
}

/* ---------------- timer ---------------- */

#[tauri::command]
pub fn timer_state(app: AppHandle) -> TimerSnapshot {
    timer::state(&app)
}

#[tauri::command]
pub fn timer_start(app: AppHandle, task_id: Option<String>) -> R<TimerSnapshot> {
    timer::start(&app, task_id)
}

/// 短い集中を始める。ポモドーロとしては数えない助走。
#[tauri::command]
pub fn timer_start_short(app: AppHandle, task_id: Option<String>) -> R<TimerSnapshot> {
    timer::start_short(&app, task_id)
}

#[tauri::command]
pub fn timer_pause(app: AppHandle) -> R<TimerSnapshot> {
    timer::pause(&app)
}

#[tauri::command]
pub fn timer_resume(app: AppHandle) -> R<TimerSnapshot> {
    timer::resume(&app)
}

#[tauri::command]
pub fn timer_skip(app: AppHandle) -> R<TimerSnapshot> {
    timer::skip(&app)
}

#[tauri::command]
pub fn timer_stop(app: AppHandle) -> R<TimerSnapshot> {
    timer::stop(&app)
}

#[tauri::command]
pub fn timer_interrupt(app: AppHandle, reason: String) -> R<TimerSnapshot> {
    timer::interrupt(&app, &reason)
}

/// 着手中のタスクを完了にする。集中中はタイマーを止めず、
/// 残り時間の使い道を待つ状態になる。
#[tauri::command]
pub fn complete_current_task(app: AppHandle) -> R<TimerSnapshot> {
    timer::complete_current_task(&app)
}

/// 着手中のタスクを待ちにする。要因と催促の日は管理画面と同じものを取る。
#[tauri::command]
pub fn wait_current_task(
    app: AppHandle,
    waiting_for: Option<String>,
    waiting_until: Option<String>,
) -> R<TimerSnapshot> {
    timer::wait_current_task(&app, waiting_for, waiting_until)
}

/// Focus View をモニタ 1 枚いっぱいに広げる / 小窓に戻す。
///
/// 広げる前に、今その窓が載っているモニタを行き先として覚える。
/// 補助モニタに出したいのに、次からどこに出るか分からないのでは困る。
#[tauri::command]
pub fn set_focus_fullscreen(app: AppHandle, on: bool) -> R<Settings> {
    let db = app.state::<Db>();
    let mut settings = db.get_settings()?;
    settings.focus_fullscreen = on;
    if on {
        windows::remember_focus_monitor(&app);
    }
    db.save_settings(&settings)?;
    windows::apply_focus_fullscreen(&app);
    let _ = app.emit(EV_SETTINGS_CHANGED, ());
    Ok(settings)
}

/// 休憩中の暗幕を外す / 掛け直す。今の休憩の間だけ効く。
#[tauri::command]
pub fn set_break_dim(app: AppHandle, on: bool) -> R<TimerSnapshot> {
    timer::set_dim(&app, on)
}

#[tauri::command]
pub fn choose_review(app: AppHandle) -> R<TimerSnapshot> {
    timer::choose_review(&app)
}

#[tauri::command]
pub fn choose_handoff(app: AppHandle, task_id: String) -> R<TimerSnapshot> {
    timer::choose_handoff(&app, task_id)
}

#[tauri::command]
pub fn choose_break(app: AppHandle) -> R<TimerSnapshot> {
    timer::choose_break(&app)
}

#[tauri::command]
pub fn next_candidates(app: AppHandle, limit: Option<i64>) -> R<Vec<Task>> {
    timer::next_candidates(&app, limit.unwrap_or(3))
}

/// 着手先を切り替える。同じ仕事の内訳の中での移動は中断に数えない。
#[tauri::command]
pub fn switch_current_task(app: AppHandle, task_id: String) -> R<TimerSnapshot> {
    timer::switch_current_task(&app, task_id)
}

#[tauri::command]
pub fn set_current_task(app: AppHandle, task_id: Option<String>) -> R<()> {
    timer::set_current_task(&app, task_id)
}

/* ---------------- settings / stats ---------------- */

#[tauri::command]
pub fn get_settings(db: State<'_, Db>) -> R<Settings> {
    db.get_settings()
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> R<Settings> {
    let previous = app.state::<Db>().get_settings()?;
    app.state::<Db>().save_settings(&settings)?;
    // ホットキーが変わったら登録し直す。ここを忘れると設定が効かない
    if previous.hotkey != settings.hotkey {
        crate::shortcut::rebind(&app, &previous.hotkey, &settings.hotkey)?;
    }
    if previous.always_on_top != settings.always_on_top {
        windows::apply_always_on_top(&app, settings.always_on_top);
    }
    if previous.focus_fullscreen != settings.focus_fullscreen {
        if settings.focus_fullscreen {
            windows::remember_focus_monitor(&app);
        }
        windows::apply_focus_fullscreen(&app);
    }
    // 休憩中に切り替えたなら、その休憩から効かせる
    if previous.break_dim != settings.break_dim
        || previous.break_dim_strength != settings.break_dim_strength
    {
        windows::sync_dim(&app, timer::state(&app).phase);
    }
    let _ = app.emit(EV_SETTINGS_CHANGED, ());
    Ok(settings)
}

/// 次の予定 (会議など) の時刻。RFC3339。
///
/// 過ぎた予定は残さない。翌日に前日の予定が効いたままだと、
/// 理由の分からないまま開始ボタンが止まることになる。
#[tauri::command]
pub fn get_next_appointment(db: State<'_, Db>) -> R<Option<String>> {
    let Some(raw) = db.get_raw_setting(NEXT_APPOINTMENT)? else {
        return Ok(None);
    };
    match chrono::DateTime::parse_from_rfc3339(&raw) {
        Ok(at) if at > chrono::Utc::now() => Ok(Some(raw)),
        _ => {
            db.set_raw_setting(NEXT_APPOINTMENT, None)?;
            Ok(None)
        }
    }
}

#[tauri::command]
pub fn set_next_appointment(app: AppHandle, db: State<'_, Db>, at: Option<String>) -> R<()> {
    db.set_raw_setting(NEXT_APPOINTMENT, at.as_deref())?;
    let _ = app.emit(EV_SETTINGS_CHANGED, ());
    Ok(())
}

#[tauri::command]
pub fn today_stats(db: State<'_, Db>) -> R<TodayStats> {
    db.today_stats()
}

/* ---------------- windows ---------------- */

#[tauri::command]
pub fn show_manage(app: AppHandle) {
    windows::show_manage(&app);
}

/// メモ中のリンクを既定のブラウザで開く。
///
/// webview 内で遷移させるとアプリ自体が別のページに化けるので、必ず外で開く。
/// メモは貼り付けた文章なので、http/https 以外は弾く。file: や custom scheme を
/// そのまま起動させない。
#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> R<()> {
    let ok = url.starts_with("http://") || url.starts_with("https://");
    if !ok {
        return Err(format!("refused to open non-web url: {url}"));
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())
}

/// ローカルまたはネットワークのパスをエクスプローラーで開く。
///
/// 受けるのは `C:\...` のようなドライブ付きのパスと `\\server\share` の
/// UNC パスだけ。それ以外の文字列を Explorer に渡さない。ファイルなら
/// そのフォルダを開いて選択状態にし、フォルダならそのまま開く。
#[tauri::command]
pub fn open_path(path: String) -> R<()> {
    let trimmed = path.trim().trim_matches('"');
    let bytes = trimmed.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    let unc = trimmed.starts_with(r"\\") && trimmed.len() > 2;
    if !(drive || unc) || trimmed.chars().any(|c| c.is_control()) {
        return Err(format!("refused to open non-path: {path}"));
    }

    // 末尾の区切りは取る。`\\server\share\folder\` でも同じ場所
    let normalized = trimmed.trim_end_matches(['\\', '/']).to_string();
    let normalized = if normalized.len() < trimmed.len() && normalized.len() <= 2 {
        trimmed.to_string()
    } else {
        normalized
    };

    // 本文から切り出したパスは、後ろに文の続きが張り付いていることがある
    // (「\\server\share\wolです」)。無ければ、後ろから 1 文字ずつ削って
    // 実在するところまで戻る。それでも無ければ、実在する親まで戻る。
    let resolved = resolve_existing(&normalized)
        .ok_or_else(|| format!("見つかりません: {normalized}"))?;

    let target = std::path::Path::new(&resolved);
    let mut cmd = std::process::Command::new("explorer.exe");
    if target.is_dir() {
        cmd.arg(&resolved);
    } else {
        // /select, とパスは 1 つの引数として渡す。分けると Explorer が読まない
        cmd.arg(format!("/select,{resolved}"));
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// 実在するパスに寄せる。そのまま在ればそれ、無ければ末尾を削りながら探す。
fn resolve_existing(path: &str) -> Option<String> {
    if std::path::Path::new(path).exists() {
        return Some(path.to_string());
    }
    // 末尾に文が張り付いている場合: 1 文字ずつ削る (最大 24 文字)
    let mut cut = path.to_string();
    for _ in 0..24 {
        match cut.char_indices().next_back() {
            Some((i, _)) if i > 2 => cut.truncate(i),
            _ => break,
        }
        if cut.ends_with(['\\', '/']) {
            continue;
        }
        if std::path::Path::new(&cut).exists() {
            return Some(cut);
        }
    }
    // 途中のフォルダ名を打ち間違えた場合: 実在する親まで戻る
    let mut parent = std::path::Path::new(path).parent();
    while let Some(p) = parent {
        let s = p.to_string_lossy();
        if s.len() <= 2 {
            break;
        }
        if p.exists() {
            return Some(s.into_owned());
        }
        parent = p.parent();
    }
    None
}

/// 中身の高さに合わせて Quick Capture を伸縮させる。
/// 貼り付けた文章が複数行になっても、書いている内容が見えるようにする。
#[tauri::command]
pub fn resize_capture(app: AppHandle, height: f64) {
    windows::resize_capture(&app, height.clamp(60.0, 360.0));
}

/// 中身の高さに合わせて Focus View を伸縮させる。
/// 高さの決め打ちはどこかで必ず見切れるので、測った値をそのまま渡してもらう。
#[tauri::command]
pub fn resize_focus(app: AppHandle, height: f64) {
    windows::resize_focus(&app, height.clamp(100.0, 640.0));
}

/// ホットキー以外の入り口。画面のボタンからも同じ入力欄を開けるようにする。
#[tauri::command]
pub fn show_capture(app: AppHandle) {
    windows::show_capture(&app);
}

#[tauri::command]
pub fn hide_capture(app: AppHandle) {
    windows::hide_capture(&app);
}

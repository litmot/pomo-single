use tauri::{AppHandle, Emitter, Manager, State};

use crate::db::{Db, Settings, Task, TaskPatch, TodayStats};
use crate::timer::{self, TimerSnapshot};
use crate::windows;
use crate::{EV_INBOX_ADDED, EV_SETTINGS_CHANGED, EV_TASKS_CHANGED};

type R<T> = Result<T, String>;

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
) -> R<Task> {
    let task = db.create_task(title.trim(), &status, parent_id.as_deref())?;
    let _ = app.emit(EV_TASKS_CHANGED, ());
    Ok(task)
}

/// Quick Capture の着地点。必ず inbox に入り、専用イベントを流す。
///
/// 分類も確認もさせないのが要点。Focus View 側はこのイベントを受けて
/// 件数ではなくパルスだけを出す。
#[tauri::command]
pub fn quick_capture(app: AppHandle, db: State<'_, Db>, title: String) -> R<Task> {
    let title = title.trim();
    if title.is_empty() {
        return Err("empty title".into());
    }
    let task = db.create_task(title, "inbox", None)?;
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

/// Inbox の 1 件を、既にあるタスクのメモへ移す。
#[tauri::command]
pub fn move_inbox_to_note(
    app: AppHandle,
    db: State<'_, Db>,
    inbox_id: String,
    target_id: String,
) -> R<Task> {
    let task = db.move_inbox_to_note(&inbox_id, &target_id)?;
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
    let _ = app.emit(EV_SETTINGS_CHANGED, ());
    Ok(settings)
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
    windows::resize_focus(&app, height.clamp(120.0, 520.0));
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

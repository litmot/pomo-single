use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::windows;

/// 既定のホットキー。
pub const DEFAULT_HOTKEY: &str = "Ctrl+Alt+Space";

/// 既定が他のアプリに取られていたときに順に試す候補。
///
/// Quick Capture が使えないとこのアプリの運用自体が成立しないので、
/// 「登録できませんでした」で終わらせずに空いているキーへ逃がす。
const FALLBACKS: &[&str] = &[
    "Ctrl+Shift+Space",
    "Ctrl+Alt+N",
    "Ctrl+Shift+N",
    "Ctrl+Alt+Q",
];

fn parse(spec: &str) -> Result<Shortcut, String> {
    spec.parse::<Shortcut>()
        .map_err(|e| format!("parse failed: {e}"))
}

/// 1 つのホットキーを登録する。
///
/// 綴りが不正な場合と、他のアプリに既に取られている場合を区別できないと
/// 利用者は手の打ちようがないため、理由を文字列で返す。
pub fn bind(app: &AppHandle, spec: &str) -> Result<(), String> {
    let shortcut = parse(spec)?;
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            // Pressed だけを見る。Released でも発火すると 1 打で 2 回開閉してしまう
            if event.state() == ShortcutState::Pressed {
                windows::toggle_capture(app);
            }
        })
        .map_err(|e| format!("register failed: {e}"))
}

pub struct BindOutcome {
    /// 実際に登録できたホットキー。全滅した場合は None。
    pub active: Option<String>,
    /// 試して駄目だったものと理由。ログに出して原因を追えるようにする。
    pub rejected: Vec<(String, String)>,
}

/// 希望のホットキーを試し、駄目なら候補を順に試す。
pub fn bind_with_fallback(app: &AppHandle, preferred: &str) -> BindOutcome {
    let mut rejected = Vec::new();

    for spec in std::iter::once(preferred).chain(FALLBACKS.iter().copied()) {
        // 希望のキーが候補にも入っていた場合の二重登録を避ける
        if rejected.iter().any(|(s, _): &(String, String)| s == spec) {
            continue;
        }
        match bind(app, spec) {
            Ok(()) => {
                return BindOutcome {
                    active: Some(spec.to_string()),
                    rejected,
                }
            }
            Err(e) => rejected.push((spec.to_string(), e)),
        }
    }

    BindOutcome {
        active: None,
        rejected,
    }
}

pub fn rebind(app: &AppHandle, old: &str, new: &str) -> Result<(), String> {
    if let Ok(shortcut) = parse(old) {
        let _ = app.global_shortcut().unregister(shortcut);
    }
    bind(app, new)
}

/// 「選んでいるタスクで集中を始める」ホットキーを登録する。
///
/// 一時メモのキーと違い、取られていても他の候補へは逃がさない。無くても
/// 管理画面から始められるので、登録できなければ記録に残すだけにする。
pub fn bind_start(app: &AppHandle, spec: &str) -> Result<(), String> {
    if spec.trim().is_empty() {
        return Ok(());
    }
    let shortcut = parse(spec)?;
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                start_from_hotkey(app);
            }
        })
        .map_err(|e| format!("register failed: {e}"))
}

pub fn rebind_start(app: &AppHandle, old: &str, new: &str) -> Result<(), String> {
    if let Ok(shortcut) = parse(old) {
        let _ = app.global_shortcut().unregister(shortcut);
    }
    bind_start(app, new)
}

/// タイマーが止まっていれば、選んでいるタスクで集中を始める。
/// 選んでいなければ管理画面を出す (そこで選んで始める)。
/// 集中・小休止の最中は何もしない — 押し間違えで今の 1 本を壊さない
fn start_from_hotkey(app: &AppHandle) {
    let snap = crate::timer::state(app);
    if snap.phase != crate::timer::Phase::Idle {
        return;
    }
    let open = snap.current_task_id.filter(|id| {
        use tauri::Manager;
        app.state::<crate::db::Db>()
            .get_task(id)
            .ok()
            .flatten()
            .map(|t| t.status == "todo" || t.status == "doing")
            .unwrap_or(false)
    });
    match open {
        Some(id) => {
            if let Err(e) = crate::nudge::start(app, id) {
                crate::log_line(&format!("start hotkey failed: {e}"));
            }
        }
        None => windows::show_manage(app),
    }
}

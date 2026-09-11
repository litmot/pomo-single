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

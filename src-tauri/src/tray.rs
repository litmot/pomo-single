use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

use crate::{timer, windows};

/// トレイに常駐させる。管理画面を閉じてもアプリは生き続け、
/// ホットキーによる Quick Capture だけが動いている状態を作れる。
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "管理画面を開く", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", "一時メモに追加", true, None::<&str>)?;
    let start = MenuItem::with_id(app, "start", "集中を開始", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "集中を中断", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;

    let menu = Menu::with_items(app, &[&open, &capture, &sep, &start, &stop, &sep, &quit])?;

    // アイコンが取れないだけで起動を止めない。トレイが無くても
    // ホットキーと管理画面は動く
    let Some(icon) = app.default_window_icon().cloned() else {
        return Ok(());
    };

    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("PomoSingle")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => windows::show_manage(app),
            "capture" => windows::show_capture(app),
            "start" => {
                let _ = timer::start(app, None);
            }
            "stop" => {
                let _ = timer::stop(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左クリックは管理画面を開く近道
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                windows::show_manage(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

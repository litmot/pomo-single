mod commands;
mod db;
mod paths;
mod shortcut;
mod timer;
mod tray;
mod windows;

use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_notification::NotificationExt;

pub const EV_TASKS_CHANGED: &str = "tasks://changed";
pub const EV_ROUTINES_CHANGED: &str = "routines://changed";
pub const EV_INBOX_ADDED: &str = "inbox://added";
pub const EV_SETTINGS_CHANGED: &str = "settings://changed";

/// 起動時の要点をデータディレクトリに追記する。
///
/// リリースビルドにはコンソールが無いので、これが唯一の手掛かりになる。
/// ホットキーの競合や保存先の判定は環境によって変わるため、
/// 失敗時だけでなく毎回残す。
pub fn log_line(message: &str) {
    use std::io::Write;
    let path = paths::data_dir().join("startup.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{} {}", db::now_iso(), message);
    }
}

pub fn run() {
    // 状態は Builder に登録する。setup() の中で app.manage() すると、
    // WebView2 の初期化中にメッセージループが回った隙にフロントの invoke が
    // 先に処理され、state() called before manage() で落ちることがある。
    let database = match db::Db::open(&paths::db_path()) {
        Ok(d) => d,
        Err(e) => {
            log_line(&format!("FATAL failed to open database: {e}"));
            return;
        }
    };
    // ゴミ箱はアプリをまたいで残さない。強制終了で残った分もここで片付く。
    if let Ok(removed) = database.purge_trash() {
        if removed > 0 {
            log_line(&format!("purged {removed} trashed task(s) from the previous run"));
        }
    }

    // 今日の分の定型を起こす。起動していなかった日の分は取り戻さない
    if let Ok(n) = database.spawn_due_routines(chrono::Local::now().date_naive()) {
        if n > 0 {
            log_line(&format!("spawned {n} routine task(s) for today"));
        }
    }

    let hotkey = database
        .get_settings()
        .map(|s| s.hotkey)
        .unwrap_or_default();
    let hotkey = if hotkey.is_empty() {
        shortcut::DEFAULT_HOTKEY.to_string()
    } else {
        hotkey
    };

    tauri::Builder::default()
        .manage(database)
        .manage(timer::Timer::new())
        // 二重起動を防ぐ。2 つ動くとグローバルホットキーが取り合いになる
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            windows::show_manage(app);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::list_tasks,
            commands::create_task,
            commands::quick_capture,
            commands::update_task,
            commands::set_task_status,
            commands::promote_inbox,
            commands::set_waiting,
            commands::clear_waiting,
            commands::demote_to_inbox,
            commands::trash_task,
            commands::restore_task,
            commands::list_trash,
            commands::empty_trash,
            commands::delete_task,
            commands::move_task,
            commands::reorder_tasks,
            commands::inbox_count,
            commands::timer_state,
            commands::timer_start,
            commands::timer_start_short,
            commands::timer_pause,
            commands::timer_resume,
            commands::timer_skip,
            commands::timer_stop,
            commands::timer_interrupt,
            commands::complete_current_task,
            commands::wait_current_task,
            commands::set_break_dim,
            commands::set_focus_fullscreen,
            commands::choose_review,
            commands::choose_handoff,
            commands::choose_break,
            commands::next_candidates,
            commands::switch_current_task,
            commands::set_current_task,
            commands::get_settings,
            commands::save_settings,
            commands::get_next_appointment,
            commands::set_next_appointment,
            commands::today_stats,
            commands::show_manage,
            commands::show_capture,
            commands::hide_capture,
            commands::resize_focus,
            commands::resize_capture,
            commands::open_url,
            commands::open_path,
            commands::list_routines,
            commands::create_routine,
            commands::update_routine,
            commands::delete_routine,
            commands::spawn_routine,
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            tray::install(&handle)?;
            // 透過の指定は生成時にしかできないので、設定から作る
            windows::create_focus_window(&handle)?;
            windows::place_focus_window(&handle);
            // 暗幕の窓も起動時に作っておく。休憩に入った瞬間に作ると、
            // それがコマンド (メインスレッド) の中だったとき — 「休憩へ」を
            // 押して入る休憩がそう — Windows では窓の生成が固まり、UI ごと
            // 止まる (暗幕が掛からない、ボタンが効かない、一時メモが出ない)
            windows::create_dim_window(&handle);
            timer::spawn_tick_loop(handle.clone());

            // ホットキーが他のアプリに取られていても諦めず、空いている候補に逃がす。
            // Quick Capture が使えないと運用そのものが成立しないため。
            let outcome = shortcut::bind_with_fallback(&handle, &hotkey);
            log_line(&format!(
                "started  data_dir={}  hotkey={hotkey}  active={:?}  rejected={:?}",
                paths::data_dir().display(),
                outcome.active,
                outcome.rejected
            ));

            match &outcome.active {
                Some(active) if active != &hotkey => {
                    // 実際に効いているキーを設定に書き戻す。UI の表示と食い違わせない
                    let db = handle.state::<db::Db>();
                    if let Ok(mut s) = db.get_settings() {
                        s.hotkey = active.clone();
                        let _ = db.save_settings(&s);
                    }
                    // 書き戻しただけではフロントが持っている値は古いまま。
                    // 画面に出ているキーが実際に効くキーと食い違うと嘘の案内になる。
                    let _ = handle.emit(EV_SETTINGS_CHANGED, ());
                    let _ = handle
                        .notification()
                        .builder()
                        .title("ホットキーを変更しました")
                        .body(format!(
                            "{hotkey} は他のアプリが使用中でした。{active} で一時メモに追加できます。"
                        ))
                        .show();
                }
                Some(_) => {}
                None => {
                    let _ = handle
                        .notification()
                        .builder()
                        .title("ホットキーを登録できませんでした")
                        .body(
                            "候補がすべて他のアプリに使用されています。設定から空いているキーを指定してください。",
                        )
                        .show();
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // × では終了せずトレイに残す。終了はトレイメニューから。
                // 集中中に閉じて計時が飛ぶのを防ぐ意図もある。
                if window.label() == windows::MANAGE {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building PomoSingle")
        .run(|handle, event| {
            // 終了時にゴミ箱を空にする。残しても次の起動で消すが、
            // 閉じた時点で消えている方が「一時的な置き場」として筋が通る。
            if let tauri::RunEvent::Exit = event {
                let _ = handle.state::<db::Db>().purge_trash();
            }
        });
}

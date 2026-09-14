use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewWindow};

use crate::db::Db;
use crate::timer::Phase;

pub const MANAGE: &str = "manage";
pub const FOCUS: &str = "focus";
pub const CAPTURE: &str = "capture";
pub const DIM: &str = "dim";

/// 暗幕が明けるまでの時間 (ms)。dim.html の transition と合わせる。
const UNVEIL_MS: u64 = 800;

/// 全画面にするモニタを覚えておく鍵。好みの設定ではなく「この環境では
/// どこに出すか」という機械の事情なので、設定ブロブとは分けて置く。
const FOCUS_MONITOR: &str = "focus_monitor";

/// Focus View の幅は常に一定。現在の幅を引き継ぐ形にすると、何かの拍子に
/// 広がったときその幅が居座り続ける。
const FOCUS_WIDTH: f64 = 380.0;
/// 高さの初期値。実際の高さは中身を測ってフロント側から指定される。
const FOCUS_HEIGHT: f64 = 104.0;
const BREAK_HEIGHT: f64 = 214.0;
/// タスクが早く終わり、残り時間の使い道を選ぶ間の当たり
const CHOICE_HEIGHT: f64 = 248.0;

fn win(app: &AppHandle, label: &str) -> Option<WebviewWindow> {
    app.get_webview_window(label)
}

/// Focus View を生成する。
///
/// 透過は OS 側ではウィンドウ生成時にしか指定できないため、設定から読んで
/// ここで決める。設定を変えた場合は次回起動で反映される。
pub fn create_focus_window(app: &AppHandle) -> tauri::Result<()> {
    let transparent = app
        .state::<Db>()
        .get_settings()
        .map(|s| s.focus_transparent)
        .unwrap_or(true);

    tauri::WebviewWindowBuilder::new(
        app,
        FOCUS,
        tauri::WebviewUrl::App("focus.html".into()),
    )
    .title("Focus")
    .inner_size(FOCUS_WIDTH, FOCUS_HEIGHT)
    .decorations(false)
    .transparent(transparent)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    // ドラッグ領域のダブルクリックは Windows ではタイトルバーと同じ扱いになり、
    // 窓を最大化してしまう。最大化した窓には set_size が効かなくなるため、
    // 以降どのフェーズでも高さが直らなくなる。入り口ごと塞ぐ。
    .maximizable(false)
    .visible(false)
    .build()?;

    Ok(())
}

/// 休憩中の暗幕。
///
/// 全モニタを覆う 1 枚の窓を作り、クリックは素通しさせる。手を縛らないのは
/// わざと — 塞いでしまうと、会社の PC で急ぎの連絡が来たときに逃げ場が無い。
/// 代わりに「続けるなら暗いまま」という居心地の悪さだけを残し、休むのが
/// 既定になるようにする。
fn ensure_dim(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = win(app, DIM) {
        return Some(w);
    }
    // 濃さを URL に載せる。生成直後は中の関数がまだ無く、eval が
    // 空振りするため、最初の 1 回はページ自身に始めさせる。
    let url = format!("dim.html?a={:.2}", dim_alpha(app));
    let w = tauri::WebviewWindowBuilder::new(app, DIM, tauri::WebviewUrl::App(url.into()))
        .title("Break")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .focused(false)
        .visible(false)
        .build()
        .ok()?;
    let _ = w.set_ignore_cursor_events(true);
    Some(w)
}

/// 全モニタを囲む矩形に合わせる。モニタが取れなければ現在の位置のまま出す。
fn cover_all_monitors(app: &AppHandle, w: &WebviewWindow) {
    let Ok(monitors) = app.available_monitors() else {
        return;
    };
    let Some(first) = monitors.first() else {
        return;
    };
    let (mut left, mut top) = (first.position().x, first.position().y);
    let (mut right, mut bottom) = (
        first.position().x + first.size().width as i32,
        first.position().y + first.size().height as i32,
    );
    for m in monitors.iter().skip(1) {
        left = left.min(m.position().x);
        top = top.min(m.position().y);
        right = right.max(m.position().x + m.size().width as i32);
        bottom = bottom.max(m.position().y + m.size().height as i32);
    }
    let _ = w.set_position(tauri::PhysicalPosition::new(left, top));
    let _ = w.set_size(tauri::PhysicalSize::new(
        (right - left).max(1) as u32,
        (bottom - top).max(1) as u32,
    ));
}

/// そのフェーズで暗幕を出すべきか。設定と、この休憩で外したかの両方を見る。
fn dim_wanted(app: &AppHandle, phase: Phase) -> bool {
    if !phase.is_break() {
        return false;
    }
    let on = app
        .state::<Db>()
        .get_settings()
        .map(|s| s.break_dim)
        .unwrap_or(true);
    on && !crate::timer::state(app).dim_lifted
}

/// 暗幕の濃さ。0.0 〜 1.0 に丸めて返す。
fn dim_alpha(app: &AppHandle) -> f64 {
    let pct = app
        .state::<Db>()
        .get_settings()
        .map(|s| s.break_dim_strength)
        .unwrap_or(55);
    (pct.min(100) as f64) / 100.0
}

/// 暗幕を出す / 引く。出すたびに作り直すのは、モニタ構成が変わっていても
/// 覆い直せるようにするため (再生成ではなく測り直し)。
pub fn sync_dim(app: &AppHandle, phase: Phase) {
    if !dim_wanted(app, phase) {
        fade_out_dim(app);
        return;
    }
    let Some(w) = ensure_dim(app) else {
        return;
    };
    cover_all_monitors(app, &w);
    // 濃さと掛け始めは表示の直前に流し込む。窓は作り直さずに使い回すので、
    // ここで叩かないと 2 回目以降の休憩がいきなり暗くなる。
    let _ = w.eval(&format!(
        "window.__veil && window.__veil({:.2})",
        dim_alpha(app)
    ));
    let _ = w.set_always_on_top(true);
    let _ = w.show();
}

/// 暗幕の明けぎわ。引くときも一気に明るくせず、短く送ってから窓を隠す。
///
/// 窓を即座に隠すと、フェードを始める前に消えてしまうので、
/// 明ける時間だけ待ってから隠す。待っている間に掛け直されることが
/// あるので、隠す直前にもう一度確かめる。
fn fade_out_dim(app: &AppHandle) {
    let Some(w) = win(app, DIM) else { return };
    if !w.is_visible().unwrap_or(false) {
        return;
    }
    let _ = w.eval("window.__unveil && window.__unveil()");

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(UNVEIL_MS + 120));
        if dim_wanted(&app, crate::timer::state(&app).phase) {
            return;
        }
        if let Some(w) = win(&app, DIM) {
            let _ = w.hide();
        }
    });
}

/// フェーズに合わせてウィンドウを出し入れする。
///
/// フロント側でやると、管理画面が隠れている間に指示を出せなくなるため
/// 必ず Rust 側から駆動する。
pub fn sync_for_phase(app: &AppHandle, phase: Phase) {
    match phase {
        Phase::Idle => {
            sync_dim(app, phase);
            if let Some(w) = win(app, FOCUS) {
                let _ = w.hide();
            }
            if let Some(w) = win(app, MANAGE) {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }
        Phase::Focus | Phase::ShortFocus | Phase::ShortBreak | Phase::LongBreak => {
            // 暗幕が先。後から出すと Focus View の上に被さる
            sync_dim(app, phase);
            if let Some(w) = win(app, FOCUS) {
                let awaiting = awaiting_choice(app);
                let height = if awaiting {
                    CHOICE_HEIGHT
                } else if phase.is_break() {
                    BREAK_HEIGHT
                } else {
                    FOCUS_HEIGHT
                };
                // 当たりの高さを当てるのは、隠れていた窓を出すときだけ。
                //
                // 出しっぱなしの窓に当て直すと、フロント側が測った高さと
                // 競合する。フロントは phase イベントを受けた時点で中身を
                // 測って寄せてくるので、その後に Rust 側が当たりを書くと
                // 当たりの方が残り、下端固定ゆえに窓が上にずれたままになる。
                // 暗幕の解除のように表示が変わらない操作でも起きていた。
                let full = focus_fullscreen(app);
                if full {
                    expand_focus(app);
                } else if !w.is_visible().unwrap_or(false) {
                    resize_focus(app, height);
                }
                // 暗幕をかけている間だけは最前面を強制する。暗幕の下に
                // 沈むと、休憩の残り時間も一時メモの振り分けも見えなくなる。
                let dimmed = dim_wanted(app, phase);
                // 暗幕も最前面なので、一度降ろしてから上げ直して抜き返す。
                // set_focus は使わない — 集中中に他のアプリから入力を
                // 奪ってしまう。
                let _ = w.set_always_on_top(false);
                let _ = w.set_always_on_top(always_on_top(app) || dimmed || full);
                let _ = w.show();
            }
            // 一覧は視界から外す。これがこのアプリの本題。
            if let Some(w) = win(app, MANAGE) {
                let _ = w.hide();
            }
        }
    }
}

/// Focus View の高さを変える。
///
/// **下端を固定して上に伸ばす。** この窓は画面の右下に置くので、左上を
/// 固定して下に伸ばすと画面外にはみ出し、増えた部分がそのまま見えなくなる。
/// 併せて、モニタからはみ出さない位置に丸める。
pub fn resize_focus(app: &AppHandle, height: f64) {
    // 全画面のあいだは高さを中身に合わせない。合わせたら全画面ではない
    if focus_fullscreen(app) {
        return;
    }
    let Some(w) = win(app, FOCUS) else { return };

    // 最大化されたままだと set_size が素通りし、以降どうやっても高さが直らない。
    // 念のため毎回外しておく。
    if w.is_maximized().unwrap_or(false) {
        let _ = w.unmaximize();
    }

    let scale = w.scale_factor().unwrap_or(1.0);
    let Ok(pos) = w.outer_position() else { return };
    let Ok(size) = w.outer_size() else { return };
    let pos = pos.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);

    let bottom = pos.y + size.height;
    let _ = w.set_size(LogicalSize::new(FOCUS_WIDTH, height));

    let mut x = pos.x;
    let mut y = bottom - height;
    if let Ok(Some(monitor)) = w.current_monitor() {
        let ms = monitor.size().to_logical::<f64>(monitor.scale_factor());
        let mp = monitor.position().to_logical::<f64>(monitor.scale_factor());
        x = x.clamp(mp.x, (mp.x + ms.width - FOCUS_WIDTH).max(mp.x));
        y = y.clamp(mp.y, (mp.y + ms.height - height).max(mp.y));
    }
    let _ = w.set_position(LogicalPosition::new(x, y));
}

fn awaiting_choice(app: &AppHandle) -> bool {
    app.state::<crate::timer::Timer>()
        .0
        .lock()
        .map(|c| c.awaiting_choice)
        .unwrap_or(false)
}

/// 常に最前面にするかどうかは設定次第。既定は有効。
fn always_on_top(app: &AppHandle) -> bool {
    app.state::<Db>()
        .get_settings()
        .map(|s| s.always_on_top)
        .unwrap_or(true)
}

/// 設定変更を、開いている Focus View に即座に反映する。
/// 次のセッション開始まで待たせると、設定を切り替えた手応えが無い。
pub fn apply_always_on_top(app: &AppHandle, on_top: bool) {
    if let Some(w) = win(app, FOCUS) {
        let _ = w.set_always_on_top(on_top);
    }
}

pub fn focus_fullscreen(app: &AppHandle) -> bool {
    app.state::<Db>()
        .get_settings()
        .map(|s| s.focus_fullscreen)
        .unwrap_or(false)
}

/// 全画面にするモニタ。
///
/// 覚えている名前を優先する。補助モニタに出したいのに、小窓が今どこに
/// あるかで行き先が変わっては使えない。見つからなければ窓が載っている
/// モニタ、それも取れなければ主モニタ。
fn target_monitor(app: &AppHandle, w: &WebviewWindow) -> Option<tauri::Monitor> {
    let remembered = app
        .state::<Db>()
        .get_raw_setting(FOCUS_MONITOR)
        .ok()
        .flatten();
    if let Some(name) = remembered {
        if let Ok(monitors) = app.available_monitors() {
            if let Some(m) = monitors
                .into_iter()
                .find(|m| m.name().map(|n| n == &name).unwrap_or(false))
            {
                return Some(m);
            }
        }
    }
    w.current_monitor()
        .ok()
        .flatten()
        .or_else(|| w.primary_monitor().ok().flatten())
}

/// 今このウィンドウが載っているモニタを、全画面の行き先として覚える。
pub fn remember_focus_monitor(app: &AppHandle) {
    let Some(w) = win(app, FOCUS) else { return };
    let name = w
        .current_monitor()
        .ok()
        .flatten()
        .and_then(|m| m.name().cloned());
    let _ = app
        .state::<Db>()
        .set_raw_setting(FOCUS_MONITOR, name.as_deref());
}

/// Focus View をモニタ 1 枚いっぱいに広げる。
///
/// タスクバーごと覆いたいので、作業領域ではなくモニタの矩形そのものに
/// 合わせる。最大化は使わない — 最大化した窓には `set_size` が効かなくなり、
/// 全画面をやめたときに小窓へ戻せなくなる。
fn expand_focus(app: &AppHandle) {
    let Some(w) = win(app, FOCUS) else { return };
    if w.is_maximized().unwrap_or(false) {
        let _ = w.unmaximize();
    }
    let Some(m) = target_monitor(app, &w) else { return };
    let _ = w.set_position(*m.position());
    let _ = w.set_size(*m.size());
    // 覆い隠すのが目的なので、最前面の設定に関係なく前に出す
    let _ = w.set_always_on_top(true);
}

/// Focus View を右下の小窓に戻す。
///
/// 戻す先は全画面に使っていたモニタ。補助モニタで使っていたものが
/// いきなり作業用モニタの隅に現れると、探すことになる。
fn shrink_focus(app: &AppHandle, height: f64) {
    let Some(w) = win(app, FOCUS) else { return };
    let _ = w.set_size(LogicalSize::new(FOCUS_WIDTH, height));
    let Some(m) = target_monitor(app, &w) else { return };
    let scale = m.scale_factor();
    let size = m.size().to_logical::<f64>(scale);
    let pos = m.position().to_logical::<f64>(scale);
    let x = pos.x + size.width - FOCUS_WIDTH - 24.0;
    let y = pos.y + size.height - height - 64.0;
    let _ = w.set_position(LogicalPosition::new(x, y));
    let _ = w.set_always_on_top(always_on_top(app));
}

/// 全画面の設定を、開いている Focus View に即座に反映する。
pub fn apply_focus_fullscreen(app: &AppHandle) {
    if focus_fullscreen(app) {
        expand_focus(app);
    } else {
        // 高さは当たり。フロント側が中身を測って詰め直す
        shrink_focus(app, FOCUS_HEIGHT);
    }
}

/// Focus View を初回だけ置く。全画面の設定が入っていればその形で出す。
pub fn place_focus_window(app: &AppHandle) {
    apply_focus_fullscreen(app);
}

/// Focus View と Quick Capture の間隔
const CAPTURE_GAP: f64 = 12.0;

/// ウィンドウが載っているモニタ内に収まる位置の範囲を返す。
fn bounds(w: &WebviewWindow, width: f64, height: f64) -> Option<(f64, f64, f64, f64)> {
    let monitor = w.current_monitor().ok()??;
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let pos = monitor.position().to_logical::<f64>(scale);
    Some((
        pos.x,
        (pos.x + size.width - width).max(pos.x),
        pos.y,
        (pos.y + size.height - height).max(pos.y),
    ))
}

/// Focus View が出ているとき、その隣で下端を揃えた位置を返す。
///
/// 上ではなく横に置くのは、行が増えたときに伸びてタイマーを覆わないため。
/// 下端を揃えておけば、伸びる向きは上になる。
fn beside_focus(app: &AppHandle, width: f64, height: f64) -> Option<(f64, f64)> {
    let focus = win(app, FOCUS)?;
    if !focus.is_visible().unwrap_or(false) {
        return None;
    }
    let scale = focus.scale_factor().ok()?;
    let fp = focus.outer_position().ok()?.to_logical::<f64>(scale);
    let fs = focus.outer_size().ok()?.to_logical::<f64>(scale);
    let (min_x, max_x, min_y, max_y) = bounds(&focus, width, height)?;

    // 左に置けるならそちら。入らなければ右に回す
    let left = fp.x - width - CAPTURE_GAP;
    let x = if left >= min_x { left } else { fp.x + fs.width + CAPTURE_GAP };
    let y = fp.y + fs.height - height;

    Some((x.clamp(min_x, max_x), y.clamp(min_y, max_y)))
}

/// 集中していないときの定位置。画面中央やや上。
fn centered(w: &WebviewWindow, width: f64, height: f64) -> Option<(f64, f64)> {
    let monitor = w.current_monitor().ok()??;
    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);
    let pos = monitor.position().to_logical::<f64>(scale);
    let x = pos.x + (size.width - width) / 2.0;
    let y = (pos.y + size.height * 0.26).min(pos.y + size.height - height);
    Some((x, y))
}

/// Quick Capture を出してフォーカスを与える。
///
/// 集中中は Focus View の隣に出す。画面が広いと、画面中央に出したのでは
/// タイマーから視線が飛びすぎるため。それ以外は中央やや上の定位置。
pub fn show_capture(app: &AppHandle) {
    let Some(w) = win(app, CAPTURE) else { return };
    let scale = w.scale_factor().unwrap_or(1.0);
    let Ok(size) = w.outer_size() else { return };
    let size = size.to_logical::<f64>(scale);

    let spot = beside_focus(app, size.width, size.height)
        .or_else(|| centered(&w, size.width, size.height));
    if let Some((x, y)) = spot {
        let _ = w.set_position(LogicalPosition::new(x, y));
    }

    let _ = w.show();
    let _ = w.set_always_on_top(true);
    let _ = w.set_focus();
}

/// Quick Capture の高さを中身に合わせる。
///
/// Focus View と同じく下端を固定して上に伸ばす。Focus View の隣に出したとき、
/// 下へ伸ばすとタイマーの下端をはみ出して画面外に出てしまう。
pub fn resize_capture(app: &AppHandle, height: f64) {
    let Some(w) = win(app, CAPTURE) else { return };
    let scale = w.scale_factor().unwrap_or(1.0);
    let Ok(pos) = w.outer_position() else { return };
    let Ok(size) = w.outer_size() else { return };
    let pos = pos.to_logical::<f64>(scale);
    let size = size.to_logical::<f64>(scale);

    let bottom = pos.y + size.height;
    let _ = w.set_size(LogicalSize::new(size.width, height));

    let mut x = pos.x;
    let mut y = bottom - height;
    if let Some((min_x, max_x, min_y, max_y)) = bounds(&w, size.width, height) {
        x = x.clamp(min_x, max_x);
        y = y.clamp(min_y, max_y);
    }
    let _ = w.set_position(LogicalPosition::new(x, y));
}

/// 隠すと Windows が直前のアプリへフォーカスを戻すので、作業に自然に復帰できる。
pub fn hide_capture(app: &AppHandle) {
    if let Some(w) = win(app, CAPTURE) {
        let _ = w.hide();
    }
}

/// ホットキーは開閉のトグルにする。押し間違えても同じキーで畳める。
pub fn toggle_capture(app: &AppHandle) {
    let Some(w) = win(app, CAPTURE) else { return };
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
    } else {
        show_capture(app);
    }
}

pub fn show_manage(app: &AppHandle) {
    if let Some(w) = win(app, MANAGE) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

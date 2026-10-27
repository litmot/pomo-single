//! タイマーを動かさずに作業していたら、控えめに知らせる。
//!
//! 「ポモドーロを起動せずに作業を始めてしまう」のは、押し忘れても何も
//! 起きないから。タイマーが止まったまま PC を使い続けていたら、画面の
//! 右下に小さな窓を出し、ボタン 1 つで集中に入れるようにする。
//!
//! - 数えるのは、平日の決めた時間帯 (家で PC を使うときに鳴らさない) に、
//!   タイマーが止まっていて、PC を操作している間だけ。5 分触らなければ
//!   離席とみなして数え直す。管理画面を前に出している間 (整理している間)
//!   も数えない
//! - 全画面のアプリ・プレゼン中・画面ロック中は出さない (数えるのは続ける)
//! - 「会議中」を押せば 1 時間、× なら 30 分は出さない
//! - 集中に入るとき、それまでのタイマーなしの時間も記録に足す
//!   (ポモドーロには数えない)。押し忘れても実績が消えないように

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

use crate::db::{Db, Settings};
use crate::timer::{self, Phase};
use crate::windows;

pub const EV_NUDGE: &str = "nudge://show";
/// 会議中の状態が変わった (始めた・延ばした・終わった)
pub const EV_MEETING: &str = "meeting://changed";

/// これだけ操作が無ければ離席とみなし、数え直す
const AWAY_MS: u64 = 5 * 60_000;
/// × で閉じたとき、次に出すまでの間
pub const LATER_MS: i64 = 30 * 60_000;

#[derive(Default)]
pub struct NudgeCore {
    /// タイマーなしで PC を使い始めた時刻 (ms)。離席や集中で消える
    active_since: Option<i64>,
    /// この時刻までは出さない (ms)
    quiet_until: i64,
    /// 今、窓を出しているか
    showing: bool,
    /// 会議の終わる時刻 (ms)。会議中はタイマーなしの時間を数えない
    meeting_until: Option<i64>,
    /// この時刻より前からは数えない (ms)。会議が終わった時刻を入れる。
    /// 会議中も PC を触っていると、最後の入力から数え始めてしまい、
    /// 会議の時間までタイマーなしの作業に数えてしまうため
    count_from: i64,
}

pub struct Nudge(pub Mutex<NudgeCore>);

impl Nudge {
    pub fn new() -> Self {
        Nudge(Mutex::new(NudgeCore::default()))
    }
}

/// 窓に出す中身
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NudgeInfo {
    /// タイマーなしで作業を始めた時刻 (RFC3339)
    pub since: Option<String>,
    /// 何分たったか
    pub minutes: i64,
    /// 選んでいるタスク (あれば、その名前でボタンを出す)
    pub current_task: Option<crate::db::Task>,
}

#[cfg(windows)]
mod win {
    #[repr(C)]
    struct LastInputInfo {
        cb_size: u32,
        dw_time: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetLastInputInfo(plii: *mut LastInputInfo) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetTickCount() -> u32;
    }
    #[link(name = "shell32")]
    extern "system" {
        fn SHQueryUserNotificationState(state: *mut i32) -> i32;
    }

    /// 最後にキーかマウスを触ってからの時間 (ms)
    pub fn idle_ms() -> Option<u64> {
        let mut info = LastInputInfo {
            cb_size: std::mem::size_of::<LastInputInfo>() as u32,
            dw_time: 0,
        };
        // SAFETY: 大きさを入れた構造体を渡すだけ
        let ok = unsafe { GetLastInputInfo(&mut info) };
        if ok == 0 {
            return None;
        }
        // どちらも起動からのミリ秒 (49 日で一周する) なので、差は折り返しで取る
        let now = unsafe { GetTickCount() };
        Some(now.wrapping_sub(info.dw_time) as u64)
    }

    /// 知らせを出すと邪魔になる状態か。全画面のアプリ (画面共有・動画)・
    /// プレゼン中・画面ロック中
    pub fn busy() -> bool {
        let mut state = 0i32;
        // SAFETY: 値を 1 つ受け取るだけ
        let hr = unsafe { SHQueryUserNotificationState(&mut state) };
        // 1 = 画面ロック・スクリーンセーバー, 2 = 全画面, 3 = D3D の全画面, 4 = プレゼン
        hr == 0 && matches!(state, 1..=4)
    }
}

#[cfg(not(windows))]
mod win {
    pub fn idle_ms() -> Option<u64> {
        None
    }
    pub fn busy() -> bool {
        false
    }
}

/// "HH:MM" を分にする
fn minutes_of(hhmm: &str) -> Option<u32> {
    let (h, m) = hhmm.trim().split_once(':')?;
    Some(h.parse::<u32>().ok()? * 60 + m.parse::<u32>().ok()?)
}

/// 平日の、決めた時間帯の中か
pub fn within_hours(s: &Settings, now: chrono::DateTime<chrono::Local>) -> bool {
    use chrono::{Datelike, Timelike};
    let wd = now.weekday().num_days_from_sunday();
    if wd == 0 || wd == 6 {
        return false;
    }
    let (Some(a), Some(b)) = (minutes_of(&s.work_start), minutes_of(&s.work_end)) else {
        return true;
    };
    let t = now.hour() * 60 + now.minute();
    if a <= b {
        a <= t && t < b
    } else {
        // 夜をまたぐ時間帯 (22:00〜06:00 など)
        t >= a || t < b
    }
}

/// tick のたびに (1 秒ごとに) 呼ぶ。数えて、時間が来たら窓を出す。
///
/// **ロックを持ったまま窓に問い合わせない。** この関数は tick のスレッドで
/// 動き、窓の状態の問い合わせ (`is_focused` など) はメインスレッドに頼んで
/// 返事を待つ。一方、知らせの窓が呼ぶコマンド (`nudge_info` など) は
/// メインスレッドで動いて同じロックを取りに来る。ロックを持ったまま
/// 返事を待つと互いに待ち合い、アプリごと固まる (実際に、しばらく
/// 起動しているとハングアップした)。窓のことはロックの外で先に調べ、
/// ロックは数を書き換える間だけ取る。窓を出し入れするのもロックを放してから
pub fn check(app: &AppHandle) {
    let settings = match app.state::<Db>().get_settings() {
        Ok(s) => s,
        Err(_) => return,
    };
    let snap = timer::state(app);
    let now = timer::now_ms();

    // ---- 会議中 ----
    // 会議中は数えない。終わる時刻が来たら (または集中を始めたら) 会議を
    // 終えて、その時刻から数え直す。窓の出し入れはロックを放してから
    let meeting = {
        let nudge = app.state::<Nudge>();
        let Ok(mut core) = nudge.0.lock() else { return };
        match core.meeting_until {
            Some(until) if now < until && snap.phase == Phase::Idle => {
                core.active_since = None;
                Some(false)
            }
            Some(_) => {
                core.meeting_until = None;
                core.count_from = now;
                core.active_since = None;
                Some(true)
            }
            None => None,
        }
    };
    match meeting {
        Some(false) => return,
        Some(true) => {
            windows::hide_meeting(app);
            let _ = app.emit(EV_MEETING, ());
            crate::log_line("meeting ended (time up or focus started)");
            return;
        }
        None => {}
    }

    // ---- ロックの外で調べる ----
    let counting = settings.untimed_nudge && snap.phase == Phase::Idle;
    let in_hours = counting && within_hours(&settings, chrono::Local::now());
    let idle = if in_hours { win::idle_ms() } else { None };
    if in_hours && idle.is_none() {
        // 操作の有無が取れなかった。今回は何も変えない
        return;
    }
    let away = idle.map(|i| i >= AWAY_MS).unwrap_or(false);
    // 管理画面を前に出している間は、整理している時間なので数えない
    let organizing = in_hours && !away && windows::manage_focused(app);
    let busy = in_hours && !away && !organizing && win::busy();
    let limit = settings.untimed_nudge_minutes.max(1) as i64 * 60_000;

    // ---- ロックは書き換える間だけ ----
    let mut hide = false;
    let mut shown_after: Option<i64> = None;
    {
        let nudge = app.state::<Nudge>();
        let Ok(mut core) = nudge.0.lock() else { return };
        if !counting {
            // 集中・休憩中、または知らせを切っている。出ていれば引っ込める
            core.active_since = None;
            if core.showing {
                core.showing = false;
                hide = true;
            }
        } else if !in_hours || away {
            // 時間帯の外、または離席。戻ってきたら数え直す
            // (出ている窓はそのまま — 戻ったときに目に入る)
            core.active_since = None;
        } else if organizing {
            if !core.showing {
                core.active_since = None;
            }
        } else if let Some(idle) = idle {
            // 会議が終わってからの分だけを数える
            let from = (now - idle as i64).max(core.count_from);
            let since = *core.active_since.get_or_insert(from);
            if !core.showing && now >= core.quiet_until && now - since >= limit && !busy {
                core.showing = true;
                shown_after = Some(now - since);
            }
        }
    }

    if hide {
        windows::hide_nudge(app);
    }
    if let Some(after) = shown_after {
        windows::show_nudge(app);
        let _ = app.emit(EV_NUDGE, ());
        crate::log_line(&format!("nudge shown after {} min without timer", after / 60_000));
    }
}

/// 窓に出す中身
pub fn info(app: &AppHandle) -> NudgeInfo {
    let since = app
        .state::<Nudge>()
        .0
        .lock()
        .ok()
        .and_then(|c| c.active_since);
    let current_task = timer::state(app)
        .current_task_id
        .and_then(|id| app.state::<Db>().get_task(&id).ok().flatten())
        .filter(|t| t.status == "todo" || t.status == "doing");
    NudgeInfo {
        since: since.and_then(iso_of),
        minutes: since.map(|s| (timer::now_ms() - s) / 60_000).unwrap_or(0),
        current_task,
    }
}

fn iso_of(ms: i64) -> Option<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
        .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// 会議中にする。`until` (ms) までは数えず、知らせも出さない。
/// 会議中は画面の右下に小さな窓を出し続け、延長と終了をそこから行う
pub fn meeting_start(app: &AppHandle, until: i64) {
    if let Ok(mut core) = app.state::<Nudge>().0.lock() {
        core.meeting_until = Some(until);
        core.active_since = None;
        core.showing = false;
    }
    windows::hide_nudge(app);
    windows::show_meeting(app);
    let _ = app.emit(EV_MEETING, ());
    crate::log_line("meeting started");
}

/// 会議を延ばす。もう終わる時刻を過ぎていれば、今から数える
pub fn meeting_extend(app: &AppHandle, ms: i64) {
    let now = timer::now_ms();
    if let Ok(mut core) = app.state::<Nudge>().0.lock() {
        if let Some(until) = core.meeting_until {
            core.meeting_until = Some(until.max(now) + ms);
        }
    }
    let _ = app.emit(EV_MEETING, ());
}

/// 会議が終わった。ここからタイマーなしの時間を数え直す
pub fn meeting_end(app: &AppHandle) {
    let now = timer::now_ms();
    if let Ok(mut core) = app.state::<Nudge>().0.lock() {
        core.meeting_until = None;
        core.count_from = now;
        core.active_since = None;
    }
    windows::hide_meeting(app);
    let _ = app.emit(EV_MEETING, ());
    crate::log_line("meeting ended by user");
}

/// 会議の終わる時刻 (RFC3339)。会議中でなければ None
pub fn meeting_until(app: &AppHandle) -> Option<String> {
    let until = app.state::<Nudge>().0.lock().ok().and_then(|c| c.meeting_until)?;
    iso_of(until)
}

/// しばらく出さない。窓も引っ込める
pub fn snooze(app: &AppHandle, ms: i64) {
    if let Ok(mut core) = app.state::<Nudge>().0.lock() {
        core.showing = false;
        core.active_since = None;
        core.quiet_until = timer::now_ms() + ms;
    }
    windows::hide_nudge(app);
}

/// そのタスクで集中に入る。タイマーなしで作業していた時間も記録に足す
/// (知らせが出ていたとき = 決めた分以上続いていたときだけ。ホットキーで
/// 始めたときも同じ)
pub fn start(app: &AppHandle, task_id: String) -> Result<timer::TimerSnapshot, String> {
    let since = {
        let nudge = app.state::<Nudge>();
        let mut core = nudge.0.lock().map_err(|e| e.to_string())?;
        let since = if core.showing { core.active_since } else { None };
        core.showing = false;
        core.active_since = None;
        since
    };
    if let Some(from) = since.and_then(iso_of) {
        let _ = app
            .state::<Db>()
            .add_untimed_session(Some(&task_id), &from, &crate::db::now_iso());
    }
    windows::hide_nudge(app);
    timer::start(app, Some(task_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> chrono::DateTime<chrono::Local> {
        chrono::Local.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    #[test]
    fn counts_only_on_weekdays_within_hours() {
        let s = Settings::default();
        // 2026-10-19 は月曜
        assert!(within_hours(&s, at(2026, 10, 19, 9, 0)), "始まりの時刻は含む");
        assert!(within_hours(&s, at(2026, 10, 19, 17, 59)));
        assert!(!within_hours(&s, at(2026, 10, 19, 18, 0)), "終わりの時刻は含まない");
        assert!(!within_hours(&s, at(2026, 10, 19, 8, 59)));
        assert!(!within_hours(&s, at(2026, 10, 18, 10, 0)), "日曜は数えない");
        assert!(!within_hours(&s, at(2026, 10, 24, 10, 0)), "土曜は数えない");
    }

    #[test]
    fn hours_may_cross_midnight() {
        let s = Settings {
            work_start: "22:00".into(),
            work_end: "06:00".into(),
            ..Settings::default()
        };
        assert!(within_hours(&s, at(2026, 10, 19, 23, 0)));
        assert!(within_hours(&s, at(2026, 10, 20, 5, 0)));
        assert!(!within_hours(&s, at(2026, 10, 19, 12, 0)));
    }
}

use std::path::Path;
use std::sync::Mutex;

use chrono::{DateTime, Local, SecondsFormat, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, String>;

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

/* ------------------------------------------------------------------ */
/* models                                                              */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub note: Option<String>,
    pub status: String,
    pub parent_id: Option<String>,
    pub sort_order: f64,
    /// Phase 3 の緊急度 / 重要度マトリックス用。0 = 低, 1 = 高。未分類は None。
    /// UI は後から載せるが、後方互換のマイグレーションを避けるため列は最初から持つ。
    pub urgency: Option<i64>,
    pub importance: Option<i64>,
    pub estimate_pomodoros: Option<i64>,
    pub actual_pomodoros: i64,
    pub due: Option<String>,
    /// 待ちの相手・要因 (「A 社の見積もり回答」など)
    pub waiting_for: Option<String>,
    /// いつまで待つか。過ぎたら催促する目安 (YYYY-MM-DD)
    pub waiting_until: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
    /// ゴミ箱に入れる前の状態。一時メモだったのかタスクだったのかを見分ける
    pub prev_status: Option<String>,
}

impl Task {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Task {
            id: row.get("id")?,
            title: row.get("title")?,
            note: row.get("note")?,
            status: row.get("status")?,
            parent_id: row.get("parent_id")?,
            sort_order: row.get("sort_order")?,
            urgency: row.get("urgency")?,
            importance: row.get("importance")?,
            estimate_pomodoros: row.get("estimate_pomodoros")?,
            actual_pomodoros: row.get("actual_pomodoros")?,
            due: row.get("due")?,
            waiting_for: row.get("waiting_for")?,
            waiting_until: row.get("waiting_until")?,
            created_at: row.get("created_at")?,
            completed_at: row.get("completed_at")?,
            prev_status: row.get("prev_status")?,
        })
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    pub title: Option<String>,
    pub note: Option<Option<String>>,
    pub status: Option<String>,
    pub parent_id: Option<Option<String>>,
    pub urgency: Option<Option<i64>>,
    pub importance: Option<Option<i64>>,
    pub estimate_pomodoros: Option<Option<i64>>,
    pub due: Option<Option<String>>,
    pub waiting_for: Option<Option<String>>,
    pub waiting_until: Option<Option<String>>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub focus_minutes: u32,
    /// 助走用の短い集中の長さ (分)。
    ///
    /// 標準の集中とは別の道具なので、こちらを変えても 1 ポモドーロの
    /// 長さは動かない。
    #[serde(default = "default_short_focus_minutes")]
    pub short_focus_minutes: u32,
    pub short_break_minutes: u32,
    pub long_break_minutes: u32,
    pub long_break_every: u32,
    pub show_inbox_count: bool,
    pub sound_enabled: bool,
    pub hotkey: String,
    /// Focus View を常に最前面に出すか。
    ///
    /// 後から足した項目なので serde default を付けておく。これが無いと
    /// 旧バージョンが書いた JSON のパースが失敗し、設定が丸ごと既定値に戻る。
    #[serde(default = "default_true")]
    pub always_on_top: bool,
    /// Focus View を半透明にするか。
    ///
    /// OS 側の透過はウィンドウ生成時にしか指定できないので、変更は次回起動で効く。
    #[serde(default = "default_true")]
    pub focus_transparent: bool,
    /// 次の予定の前に空けておく時間 (分)。
    ///
    /// ポモドーロの終わりと会議の開始をぴったり合わせると、席を立つ時間も
    /// 頭を切り替える時間も無い。
    #[serde(default = "default_buffer_minutes")]
    pub appointment_buffer_minutes: u32,
    /// 休憩中、画面全体に暗幕をかけるか。
    ///
    /// 休憩に入れないまま次の 1 本を始めてしまう人向けの強制力。
    /// クリックは素通しするので手は止まらないが、続けるには画面が暗いまま
    /// になる。「休むのが既定で、続けるのは押し切る行為」に反転させる。
    #[serde(default = "default_true")]
    pub break_dim: bool,
    /// 暗幕の濃さ (%)。0 で透明、100 で真っ暗。
    ///
    /// 好みも作業環境もまるで違うので固定値にはしない。画面の明るさも、
    /// 周りから覗かれる席かどうかも人によって変わる。
    #[serde(default = "default_dim_strength")]
    pub break_dim_strength: u32,
    /// Focus View をモニタ 1 枚いっぱいに広げるか。
    ///
    /// 補助モニタ (ノート側など) の視界情報そのものを覆い隠すための表示。
    /// 常時オンでも成り立つ使い方なので、その場限りの状態ではなく設定として
    /// 持つ。どのモニタに出すかは `focus_monitor` に別で覚える。
    #[serde(default)]
    pub focus_fullscreen: bool,
    /// 一覧のチェックボックスを「次にやる 1 件に選ぶ」に使うか。
    ///
    /// 既定ではチェック = 完了。ただ、チェックボックスを「選ぶ」の意味で
    /// 押してしまう癖はなかなか抜けない。押し間違えて完了にしてしまう人は、
    /// 意味を入れ替えて、完了は行のボタンで行う。
    #[serde(default)]
    pub check_selects: bool,
}

fn default_dim_strength() -> u32 {
    55
}

fn default_buffer_minutes() -> u32 {
    3
}

fn default_short_focus_minutes() -> u32 {
    10
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            focus_minutes: 25,
            short_focus_minutes: default_short_focus_minutes(),
            short_break_minutes: 5,
            long_break_minutes: 15,
            long_break_every: 4,
            // 既定でオフ。残件数が見えること自体が割り込みになるため。
            show_inbox_count: false,
            sound_enabled: true,
            hotkey: "Ctrl+Alt+Space".into(),
            always_on_top: true,
            focus_transparent: true,
            appointment_buffer_minutes: 3,
            break_dim: true,
            break_dim_strength: default_dim_strength(),
            focus_fullscreen: false,
            check_selects: false,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodayStats {
    pub completed_focus_sessions: i64,
    pub completed_tasks: i64,
    pub focus_minutes: i64,
    pub interruptions: i64,
}

/* ------------------------------------------------------------------ */
/* connection                                                          */
/* ------------------------------------------------------------------ */

pub struct Db(pub Mutex<Connection>);

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// ローカル時間の「今日」の 0:00 を UTC の RFC3339 文字列で返す。
/// 保存は UTC、集計はローカル日付という食い違いを 1 箇所に閉じ込める。
fn local_today_start_utc() -> String {
    let today = Local::now().date_naive();
    let start = today.and_hms_opt(0, 0, 0).expect("valid midnight");
    let local: DateTime<Local> = Local
        .from_local_datetime(&start)
        .earliest()
        .unwrap_or_else(|| Local.from_utc_datetime(&start));
    local
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).map_err(map_err)?;
        // journal_mode は結果行 ("wal") を返すため pragma_update では
        // ExecuteReturnedResults になる。返り値を捨てる execute_batch を使う。
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
            .map_err(map_err)?;
        let db = Db(Mutex::new(conn));
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<()> {
        let conn = self.0.lock().map_err(map_err)?;
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(map_err)?;

        if version < 1 {
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS task (
                    id                 TEXT PRIMARY KEY,
                    title              TEXT NOT NULL,
                    note               TEXT,
                    status             TEXT NOT NULL,
                    parent_id          TEXT REFERENCES task(id) ON DELETE CASCADE,
                    sort_order         REAL NOT NULL,
                    urgency            INTEGER,
                    importance         INTEGER,
                    estimate_pomodoros INTEGER,
                    actual_pomodoros   INTEGER NOT NULL DEFAULT 0,
                    due                TEXT,
                    created_at         TEXT NOT NULL,
                    completed_at       TEXT
                );
                CREATE INDEX IF NOT EXISTS idx_task_status ON task(status);
                CREATE INDEX IF NOT EXISTS idx_task_parent ON task(parent_id);

                CREATE TABLE IF NOT EXISTS session (
                    id              TEXT PRIMARY KEY,
                    task_id         TEXT,
                    kind            TEXT NOT NULL,
                    started_at      TEXT NOT NULL,
                    ended_at        TEXT,
                    completed       INTEGER NOT NULL DEFAULT 0,
                    interrupt_count INTEGER NOT NULL DEFAULT 0,
                    planned_ms      INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_session_started ON session(started_at);

                CREATE TABLE IF NOT EXISTS setting (
                    key   TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                PRAGMA user_version = 1;
                "#,
            )
            .map_err(map_err)?;
        }

        if version < 2 {
            // セッションの終わり方を残す。「鳴った」「タスクが早く終わって休憩に入った」
            // 「投げ出した」を区別できないと、見積もりの傾向が読めない。
            conn.execute_batch(
                r#"
                ALTER TABLE session ADD COLUMN outcome TEXT;
                PRAGMA user_version = 2;
                "#,
            )
            .map_err(map_err)?;
        }

        if version < 3 {
            // 削除は一旦ゴミ箱へ入れる。戻すときに元の状態へ返せるよう、
            // 捨てる前の status を控えておく。
            conn.execute_batch(
                r#"
                ALTER TABLE task ADD COLUMN trashed_at TEXT;
                ALTER TABLE task ADD COLUMN prev_status TEXT;
                PRAGMA user_version = 3;
                "#,
            )
            .map_err(map_err)?;
        }

        if version < 4 {
            // 相手の動きを待っている状態。タスクとしては閉じられないが、
            // 自分が手を動かせるわけでもない。
            conn.execute_batch(
                r#"
                ALTER TABLE task ADD COLUMN waiting_for TEXT;
                ALTER TABLE task ADD COLUMN waiting_until TEXT;
                PRAGMA user_version = 4;
                "#,
            )
            .map_err(map_err)?;
        }
        Ok(())
    }

    /* ---------------- tasks ---------------- */

    pub fn list_tasks(&self, statuses: Option<Vec<String>>) -> Result<Vec<Task>> {
        let conn = self.0.lock().map_err(map_err)?;
        // 既定に 'trashed' は含めない。ゴミ箱は専用の一覧から見る
        let statuses = statuses.unwrap_or_else(|| {
            vec![
                "inbox".into(),
                "todo".into(),
                "doing".into(),
                "waiting".into(),
                "done".into(),
            ]
        });
        if statuses.is_empty() {
            return Ok(vec![]);
        }
        // status は列挙値なので、プレースホルダを並べて渡す
        let holes = vec!["?"; statuses.len()].join(",");
        let sql = format!(
            "SELECT * FROM task WHERE status IN ({holes}) \
             ORDER BY (status = 'done'), sort_order, created_at"
        );
        let mut stmt = conn.prepare(&sql).map_err(map_err)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(statuses.iter()), Task::from_row)
            .map_err(map_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(map_err)
    }

    pub fn get_task(&self, id: &str) -> Result<Option<Task>> {
        let conn = self.0.lock().map_err(map_err)?;
        conn.query_row("SELECT * FROM task WHERE id = ?", [id], Task::from_row)
            .optional()
            .map_err(map_err)
    }

    pub fn create_task(
        &self,
        title: &str,
        status: &str,
        parent_id: Option<&str>,
    ) -> Result<Task> {
        self.create_task_at(title, status, parent_id, false)
    }

    /// `at_top` なら先頭に、そうでなければ末尾に積む。
    ///
    /// 見出しの ＋ から足すものは先頭、一覧の余白 (末尾の下) をダブル
    /// クリックして足すものは末尾 — 押した場所に現れるのが自然なため。
    pub fn create_task_at(
        &self,
        title: &str,
        status: &str,
        parent_id: Option<&str>,
        at_top: bool,
    ) -> Result<Task> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = now_iso();
        {
            let conn = self.0.lock().map_err(map_err)?;
            // 並べ替えは間の値を書き込めるよう REAL で持つ
            let sql = if at_top {
                "SELECT COALESCE(MIN(sort_order), 0) - 1024 FROM task"
            } else {
                "SELECT COALESCE(MAX(sort_order), 0) + 1024 FROM task"
            };
            let next: f64 = conn.query_row(sql, [], |r| r.get(0)).map_err(map_err)?;
            conn.execute(
                "INSERT INTO task (id, title, status, parent_id, sort_order, actual_pomodoros, created_at)
                 VALUES (?, ?, ?, ?, ?, 0, ?)",
                params![id, title, status, parent_id, next, now],
            )
            .map_err(map_err)?;
        }
        self.get_task(&id)?.ok_or_else(|| "task not found after insert".to_string())
    }

    pub fn update_task(&self, id: &str, patch: &TaskPatch) -> Result<Task> {
        {
            let conn = self.0.lock().map_err(map_err)?;
            if let Some(v) = &patch.title {
                conn.execute("UPDATE task SET title = ? WHERE id = ?", params![v, id])
                    .map_err(map_err)?;
            }
            if let Some(v) = &patch.note {
                // due と同じく、空文字を「メモなし」として扱う
                let value = v.as_deref().filter(|s| !s.is_empty());
                conn.execute("UPDATE task SET note = ? WHERE id = ?", params![value, id])
                    .map_err(map_err)?;
            }
            if let Some(v) = &patch.parent_id {
                conn.execute("UPDATE task SET parent_id = ? WHERE id = ?", params![v, id])
                    .map_err(map_err)?;
            }
            if let Some(v) = &patch.urgency {
                conn.execute("UPDATE task SET urgency = ? WHERE id = ?", params![v, id])
                    .map_err(map_err)?;
            }
            if let Some(v) = &patch.importance {
                conn.execute("UPDATE task SET importance = ? WHERE id = ?", params![v, id])
                    .map_err(map_err)?;
            }
            if let Some(v) = &patch.estimate_pomodoros {
                conn.execute(
                    "UPDATE task SET estimate_pomodoros = ? WHERE id = ?",
                    params![v, id],
                )
                .map_err(map_err)?;
            }
            for (column, value) in [
                ("waiting_for", &patch.waiting_for),
                ("waiting_until", &patch.waiting_until),
            ] {
                if let Some(v) = value {
                    // due と同じく、空文字は「無し」の意味
                    let text = v.as_deref().filter(|s| !s.is_empty());
                    conn.execute(
                        &format!("UPDATE task SET {column} = ? WHERE id = ?"),
                        params![text, id],
                    )
                    .map_err(map_err)?;
                }
            }
            if let Some(v) = &patch.due {
                // 空文字は「期限なし」。Option<Option<String>> では JSON の null が
                // 「変更しない」と区別できないため、クリアは空文字で表す。
                let value = v.as_deref().filter(|s| !s.is_empty());
                conn.execute("UPDATE task SET due = ? WHERE id = ?", params![value, id])
                    .map_err(map_err)?;
            }
        }
        if let Some(status) = &patch.status {
            return self.set_task_status(id, status);
        }
        self.get_task(id)?.ok_or_else(|| "task not found".to_string())
    }

    pub fn set_task_status(&self, id: &str, status: &str) -> Result<Task> {
        {
            let conn = self.0.lock().map_err(map_err)?;
            let completed_at = if status == "done" { Some(now_iso()) } else { None };
            conn.execute(
                "UPDATE task SET status = ?, completed_at = ? WHERE id = ?",
                params![status, completed_at, id],
            )
            .map_err(map_err)?;
            // 親を完了にしたらサブタスクも畳む。開いたままの子が残ると
            // 「一覧に出続ける未完了」が生まれてノイズになる
            if status == "done" {
                conn.execute(
                    "UPDATE task SET status = 'done', completed_at = ?
                     WHERE parent_id = ? AND status != 'done'",
                    params![now_iso(), id],
                )
                .map_err(map_err)?;
            }
        }
        self.get_task(id)?.ok_or_else(|| "task not found".to_string())
    }

    /// 一覧に並べても読める名前の長さ。これを超える分はメモに回す。
    const TITLE_MAX_CHARS: usize = 80;

    /// Inbox の 1 件をタスクに引き上げる。
    ///
    /// 依頼のメールやチャットを貼り付けたものは、そのまま名前にすると
    /// 一覧が読めなくなる。1 行目を名前に、収まらなかった全文をメモに回す。
    pub fn promote_inbox(&self, id: &str) -> Result<Task> {
        let task = self
            .get_task(id)?
            .ok_or_else(|| "task not found".to_string())?;

        let full = task.title.trim().to_string();
        let first_line = full.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();

        let title: String = if first_line.chars().count() > Self::TITLE_MAX_CHARS {
            let head: String = first_line.chars().take(Self::TITLE_MAX_CHARS).collect();
            format!("{head}…")
        } else {
            first_line.to_string()
        };

        // 名前に収まらなかったものがあるときだけメモを起こす
        let dropped_something = full != title;
        let note = if dropped_something {
            match task.note.as_deref().filter(|n| !n.is_empty()) {
                Some(existing) => Some(format!("{existing}

{full}")),
                None => Some(full),
            }
        } else {
            None
        };

        {
            let conn = self.0.lock().map_err(map_err)?;
            match note {
                Some(note) => conn.execute(
                    "UPDATE task SET title = ?, note = ?, status = 'todo' WHERE id = ?",
                    params![title, note, id],
                ),
                None => conn.execute(
                    "UPDATE task SET title = ?, status = 'todo' WHERE id = ?",
                    params![title, id],
                ),
            }
            .map_err(map_err)?;
        }

        self.get_task(id)?.ok_or_else(|| "task not found".to_string())
    }

    /// タスクを一時メモに戻す。
    ///
    /// 名前・メモ・サブタスクを 1 つの文章に畳む。構造は失われるが、
    /// 書いてあった内容は落とさない。サブタスクの行は畳んだあと削除する。
    pub fn demote_to_inbox(&self, id: &str) -> Result<Task> {
        let task = self
            .get_task(id)?
            .ok_or_else(|| "task not found".to_string())?;

        let mut parts = vec![task.title.trim().to_string()];
        if let Some(note) = task.note.as_deref().filter(|n| !n.trim().is_empty()) {
            parts.push(note.trim().to_string());
        }

        let subs = {
            let conn = self.0.lock().map_err(map_err)?;
            let mut stmt = conn
                .prepare("SELECT * FROM task WHERE parent_id = ? ORDER BY sort_order")
                .map_err(map_err)?;
            let rows = stmt.query_map([id], Task::from_row).map_err(map_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(map_err)?
        };

        if !subs.is_empty() {
            let mut lines = Vec::new();
            for sub in &subs {
                lines.push(format!("- {}", sub.title.trim()));
                if let Some(note) = sub.note.as_deref().filter(|n| !n.trim().is_empty()) {
                    lines.push(note.trim().to_string());
                }
            }
            parts.push(lines.join("
"));
        }

        let text = parts.join("

");

        {
            let conn = self.0.lock().map_err(map_err)?;
            // 畳んだ内容は本文に残っているので、行としては消す
            conn.execute("DELETE FROM task WHERE parent_id = ?", [id])
                .map_err(map_err)?;
            conn.execute(
                "UPDATE task
                 SET title = ?, note = NULL, status = 'inbox', parent_id = NULL,
                     due = NULL, completed_at = NULL
                 WHERE id = ?",
                params![text, id],
            )
            .map_err(map_err)?;
        }

        self.get_task(id)?.ok_or_else(|| "task not found".to_string())
    }

    /// タスクをゴミ箱へ入れる。
    ///
    /// 子も一緒に入れる。親だけ消えて子が宙に浮くのを避けるため。
    /// 戻すときは親をたどって一緒に戻す。
    pub fn trash_task(&self, id: &str) -> Result<()> {
        let now = now_iso();
        let mut conn = self.0.lock().map_err(map_err)?;
        let tx = conn.transaction().map_err(map_err)?;
        for sql in [
            "UPDATE task SET prev_status = status, status = 'trashed', trashed_at = ?1
             WHERE parent_id = ?2 AND status != 'trashed'",
            "UPDATE task SET prev_status = status, status = 'trashed', trashed_at = ?1
             WHERE id = ?2 AND status != 'trashed'",
        ] {
            tx.execute(sql, params![now, id]).map_err(map_err)?;
        }
        tx.commit().map_err(map_err)
    }

    /// ゴミ箱から戻す。捨てる前の状態に返す。
    pub fn restore_task(&self, id: &str) -> Result<Task> {
        {
            let mut conn = self.0.lock().map_err(map_err)?;
            let tx = conn.transaction().map_err(map_err)?;
            for sql in [
                "UPDATE task SET status = COALESCE(prev_status, 'todo'),
                     prev_status = NULL, trashed_at = NULL
                 WHERE parent_id = ?1 AND status = 'trashed'",
                "UPDATE task SET status = COALESCE(prev_status, 'todo'),
                     prev_status = NULL, trashed_at = NULL
                 WHERE id = ?1 AND status = 'trashed'",
            ] {
                tx.execute(sql, [id]).map_err(map_err)?;
            }
            tx.commit().map_err(map_err)?;
        }
        self.get_task(id)?.ok_or_else(|| "task not found".to_string())
    }

    /// ゴミ箱の中身。捨てた順に新しいものから。
    ///
    /// 親ごと捨てられた子は出さない。親と一緒に戻るので、個別に並べても
    /// 選べる操作が増えるだけになる。
    pub fn list_trash(&self) -> Result<Vec<Task>> {
        let conn = self.0.lock().map_err(map_err)?;
        let mut stmt = conn
            .prepare(
                "SELECT * FROM task
                 WHERE status = 'trashed'
                   AND (parent_id IS NULL
                        OR parent_id NOT IN (SELECT id FROM task WHERE status = 'trashed'))
                 ORDER BY trashed_at DESC, created_at DESC",
            )
            .map_err(map_err)?;
        let rows = stmt.query_map([], Task::from_row).map_err(map_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(map_err)
    }

    /// ゴミ箱を空にする。終了時と起動時に呼ぶ。
    pub fn purge_trash(&self) -> Result<usize> {
        let conn = self.0.lock().map_err(map_err)?;
        conn.execute("DELETE FROM task WHERE status = 'trashed'", [])
            .map_err(map_err)
    }

    /// タスクを待ちにする。相手の動きが要因なので、自分では進められない。
    pub fn set_waiting(
        &self,
        id: &str,
        waiting_for: Option<&str>,
        waiting_until: Option<&str>,
    ) -> Result<Task> {
        {
            let conn = self.0.lock().map_err(map_err)?;
            conn.execute(
                "UPDATE task SET status = 'waiting', waiting_for = ?, waiting_until = ?
                 WHERE id = ?",
                params![
                    waiting_for.filter(|s| !s.is_empty()),
                    waiting_until.filter(|s| !s.is_empty()),
                    id
                ],
            )
            .map_err(map_err)?;
        }
        self.get_task(id)?.ok_or_else(|| "task not found".to_string())
    }

    /// 待ちを解いて、また手を付けられる状態に戻す。
    pub fn clear_waiting(&self, id: &str) -> Result<Task> {
        {
            let conn = self.0.lock().map_err(map_err)?;
            conn.execute(
                "UPDATE task SET status = 'todo', waiting_for = NULL, waiting_until = NULL
                 WHERE id = ?",
                [id],
            )
            .map_err(map_err)?;
        }
        self.get_task(id)?.ok_or_else(|| "task not found".to_string())
    }

    pub fn delete_task(&self, id: &str) -> Result<()> {
        let conn = self.0.lock().map_err(map_err)?;
        conn.execute("DELETE FROM task WHERE id = ?", [id])
            .map_err(map_err)?;
        Ok(())
    }

    /// タスクを別の位置へ動かす。並べ替えと階層の移動を兼ねる。
    ///
    /// `parent_id` が None なら最上位、`after_id` の直後に置く
    /// (None なら先頭)。同じ親の下の並びは毎回振り直すので、
    /// 隙間が詰まって順序が壊れることがない。
    pub fn move_task(
        &self,
        id: &str,
        parent_id: Option<&str>,
        after_id: Option<&str>,
    ) -> Result<()> {
        if Some(id) == parent_id {
            return Err("自分自身の下には置けません".into());
        }

        // サブタスクは 1 階層まで。子を持つタスクは誰かの子にできない
        if parent_id.is_some() {
            let has_children: i64 = {
                let conn = self.0.lock().map_err(map_err)?;
                conn.query_row(
                    "SELECT COUNT(*) FROM task WHERE parent_id = ?",
                    [id],
                    |r| r.get(0),
                )
                .map_err(map_err)?
            };
            if has_children > 0 {
                return Err("サブタスクを持つタスクは、サブタスクにできません".into());
            }
        }

        let mut conn = self.0.lock().map_err(map_err)?;
        let tx = conn.transaction().map_err(map_err)?;

        tx.execute(
            "UPDATE task SET parent_id = ? WHERE id = ?",
            params![parent_id, id],
        )
        .map_err(map_err)?;

        // 移動先の兄弟を、動かすもの以外だけ順に取る
        let mut order: Vec<String> = {
            let mut stmt = match parent_id {
                Some(_) => tx.prepare(
                    "SELECT id FROM task WHERE parent_id = ?1 AND id != ?2
                     ORDER BY sort_order, created_at",
                ),
                None => tx.prepare(
                    "SELECT id FROM task WHERE parent_id IS NULL AND id != ?2
                     ORDER BY sort_order, created_at",
                ),
            }
            .map_err(map_err)?;
            let rows = stmt
                .query_map(params![parent_id, id], |r| r.get::<_, String>(0))
                .map_err(map_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(map_err)?
        };

        let at = match after_id {
            Some(after) => order.iter().position(|x| x == after).map(|i| i + 1).unwrap_or(order.len()),
            None => 0,
        };
        order.insert(at.min(order.len()), id.to_string());

        for (i, task_id) in order.iter().enumerate() {
            tx.execute(
                "UPDATE task SET sort_order = ? WHERE id = ?",
                params![(i as f64 + 1.0) * 1024.0, task_id],
            )
            .map_err(map_err)?;
        }

        tx.commit().map_err(map_err)
    }

    pub fn reorder_tasks(&self, ids: &[String]) -> Result<()> {
        let mut conn = self.0.lock().map_err(map_err)?;
        let tx = conn.transaction().map_err(map_err)?;
        for (i, id) in ids.iter().enumerate() {
            tx.execute(
                "UPDATE task SET sort_order = ? WHERE id = ?",
                params![(i as f64 + 1.0) * 1024.0, id],
            )
            .map_err(map_err)?;
        }
        tx.commit().map_err(map_err)
    }

    pub fn inbox_count(&self) -> Result<i64> {
        let conn = self.0.lock().map_err(map_err)?;
        conn.query_row("SELECT COUNT(*) FROM task WHERE status = 'inbox'", [], |r| {
            r.get(0)
        })
        .map_err(map_err)
    }

    /// 「次にやる」候補を並べる。
    ///
    /// 1. 完了したのがサブタスクなら、同じ親の未完了サブタスクを最優先。
    ///    文脈が続いているので切り替えコストが最も低い。
    /// 2. 次に期限が近い順。期限なしは最後。
    /// 3. 同着は一覧の並び順。
    pub fn next_candidates(
        &self,
        exclude_id: &str,
        sibling_parent: Option<&str>,
        limit: i64,
    ) -> Result<Vec<Task>> {
        let conn = self.0.lock().map_err(map_err)?;
        let mut stmt = conn
            .prepare(
                "SELECT * FROM task
                 WHERE status IN ('todo', 'doing') AND id != ?1
                 ORDER BY
                   CASE WHEN ?2 IS NOT NULL AND parent_id = ?2 THEN 0 ELSE 1 END,
                   CASE WHEN due IS NULL OR due = '' THEN 1 ELSE 0 END,
                   due,
                   sort_order
                 LIMIT ?3",
            )
            .map_err(map_err)?;
        let rows = stmt
            .query_map(params![exclude_id, sibling_parent, limit], Task::from_row)
            .map_err(map_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(map_err)
    }

    pub fn bump_actual_pomodoros(&self, task_id: &str) -> Result<()> {
        let conn = self.0.lock().map_err(map_err)?;
        conn.execute(
            "UPDATE task SET actual_pomodoros = actual_pomodoros + 1 WHERE id = ?",
            [task_id],
        )
        .map_err(map_err)?;
        Ok(())
    }

    /* ---------------- sessions ---------------- */

    pub fn open_session(
        &self,
        task_id: Option<&str>,
        kind: &str,
        planned_ms: i64,
    ) -> Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        let conn = self.0.lock().map_err(map_err)?;
        conn.execute(
            "INSERT INTO session (id, task_id, kind, started_at, planned_ms) VALUES (?, ?, ?, ?, ?)",
            params![id, task_id, kind, now_iso(), planned_ms],
        )
        .map_err(map_err)?;
        Ok(id)
    }

    pub fn close_session(
        &self,
        id: &str,
        completed: bool,
        interrupt_count: u32,
        outcome: &str,
    ) -> Result<()> {
        let conn = self.0.lock().map_err(map_err)?;
        conn.execute(
            "UPDATE session SET ended_at = ?, completed = ?, interrupt_count = ?, outcome = ?
             WHERE id = ?",
            params![
                now_iso(),
                completed as i64,
                interrupt_count as i64,
                outcome,
                id
            ],
        )
        .map_err(map_err)?;
        Ok(())
    }

    /* ---------------- settings ---------------- */

    pub fn get_settings(&self) -> Result<Settings> {
        let conn = self.0.lock().map_err(map_err)?;
        let raw: Option<String> = conn
            .query_row("SELECT value FROM setting WHERE key = 'settings'", [], |r| {
                r.get(0)
            })
            .optional()
            .map_err(map_err)?;
        match raw {
            // 壊れた値や旧形式で起動不能になるより、既定値に落ちる方がまし
            Some(json) => Ok(serde_json::from_str(&json).unwrap_or_default()),
            None => Ok(Settings::default()),
        }
    }

    /// 設定ブロブとは別に、単発の値を置くための入れ物。
    /// 「次の予定」は好みの設定ではなく、その日限りの状態なので分けている。
    pub fn get_raw_setting(&self, key: &str) -> Result<Option<String>> {
        let conn = self.0.lock().map_err(map_err)?;
        conn.query_row("SELECT value FROM setting WHERE key = ?", [key], |r| r.get(0))
            .optional()
            .map_err(map_err)
    }

    /// `value` が None ならその行を消す。
    pub fn set_raw_setting(&self, key: &str, value: Option<&str>) -> Result<()> {
        let conn = self.0.lock().map_err(map_err)?;
        match value {
            Some(v) => conn.execute(
                "INSERT INTO setting (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, v],
            ),
            None => conn.execute("DELETE FROM setting WHERE key = ?", [key]),
        }
        .map_err(map_err)?;
        Ok(())
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<()> {
        let json = serde_json::to_string(settings).map_err(map_err)?;
        let conn = self.0.lock().map_err(map_err)?;
        conn.execute(
            "INSERT INTO setting (key, value) VALUES ('settings', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [json],
        )
        .map_err(map_err)?;
        Ok(())
    }

    /* ---------------- stats ---------------- */

    pub fn today_stats(&self) -> Result<TodayStats> {
        let since = local_today_start_utc();
        let conn = self.0.lock().map_err(map_err)?;

        let (sessions, planned): (i64, i64) = conn
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(planned_ms), 0)
                 FROM session
                 WHERE kind = 'focus' AND completed = 1 AND started_at >= ?",
                [&since],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(map_err)?;

        // 中断は完了したセッションだけでなく、投げ出したセッションの分も数える。
        // 「何回集中を切られたか」が見たい数字なので completed で絞らない。
        let interruptions: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(interrupt_count), 0) FROM session
                 WHERE kind = 'focus' AND started_at >= ?",
                [&since],
                |r| r.get(0),
            )
            .map_err(map_err)?;

        let completed_tasks: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM task WHERE status = 'done' AND completed_at >= ?",
                [&since],
                |r| r.get(0),
            )
            .map_err(map_err)?;

        Ok(TodayStats {
            completed_focus_sessions: sessions,
            completed_tasks,
            focus_minutes: planned / 60_000,
            interruptions,
        })
    }
}

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Db {
        let path = std::env::temp_dir().join(format!("pomo-test-{}.db", uuid::Uuid::new_v4()));
        Db::open(&path).expect("open temp db")
    }

    fn with_due(db: &Db, title: &str, parent: Option<&str>, due: Option<&str>) -> Task {
        let t = db.create_task(title, "todo", parent).expect("create");
        if let Some(due) = due {
            db.update_task(
                &t.id,
                &TaskPatch {
                    due: Some(Some(due.to_string())),
                    ..Default::default()
                },
            )
            .expect("set due")
        } else {
            t
        }
    }

    fn titles(tasks: &[Task]) -> Vec<&str> {
        tasks.iter().map(|t| t.title.as_str()).collect()
    }

    #[test]
    fn candidates_put_siblings_first_then_nearest_due() {
        let db = temp_db();
        let parent = with_due(&db, "parent", None, None);
        let s1 = with_due(&db, "sub-done-first", Some(&parent.id), Some("2026-12-01"));
        with_due(&db, "sub-sibling", Some(&parent.id), None);
        with_due(&db, "far", None, Some("2026-09-20"));
        with_due(&db, "near", None, Some("2026-09-15"));
        with_due(&db, "no-due", None, None);

        let got = db
            .next_candidates(&s1.id, Some(&parent.id), 4)
            .expect("candidates");

        // 兄弟サブタスクは期限が無くても最優先。その後は期限の近い順。
        assert_eq!(titles(&got), vec!["sub-sibling", "near", "far", "parent"]);
    }

    #[test]
    fn candidates_order_by_due_and_push_undated_last() {
        let db = temp_db();
        with_due(&db, "no-due", None, None);
        with_due(&db, "far", None, Some("2026-09-20"));
        let done_one = with_due(&db, "done-one", None, Some("2026-09-01"));
        with_due(&db, "near", None, Some("2026-09-15"));

        let got = db.next_candidates(&done_one.id, None, 10).expect("candidates");

        assert_eq!(titles(&got), vec!["near", "far", "no-due"]);
    }

    #[test]
    fn candidates_exclude_done_tasks() {
        let db = temp_db();
        let a = with_due(&db, "a", None, Some("2026-09-10"));
        let b = with_due(&db, "b", None, Some("2026-09-11"));
        db.set_task_status(&b.id, "done").expect("done");

        let got = db.next_candidates(&a.id, None, 10).expect("candidates");

        assert!(got.is_empty(), "完了したタスクは候補に出さない: {:?}", titles(&got));
    }

    #[test]
    fn promoting_a_single_line_leaves_the_note_empty() {
        let db = temp_db();
        let inbox = db.create_task("プリンタのトナーを補充", "inbox", None).unwrap();

        let task = db.promote_inbox(&inbox.id).expect("promote");

        assert_eq!(task.title, "プリンタのトナーを補充");
        assert_eq!(task.note, None);
        assert_eq!(task.status, "todo");
    }

    #[test]
    fn promoting_pasted_text_keeps_the_first_line_as_the_name() {
        let db = temp_db();
        let pasted = "見積書の差し替え依頼

お世話になっております。
添付の見積書ですが、金額に誤りがありました。";
        let inbox = db.create_task(pasted, "inbox", None).unwrap();

        let task = db.promote_inbox(&inbox.id).expect("promote");

        assert_eq!(task.title, "見積書の差し替え依頼");
        // 全文はメモに残る。名前を短くしただけで情報を捨てない
        assert_eq!(task.note.as_deref(), Some(pasted));
    }

    #[test]
    fn promoting_a_very_long_line_truncates_the_name_but_keeps_the_text() {
        let db = temp_db();
        let long = "あ".repeat(200);
        let inbox = db.create_task(&long, "inbox", None).unwrap();

        let task = db.promote_inbox(&inbox.id).expect("promote");

        assert_eq!(task.title.chars().count(), 81, "80 文字 + 省略記号");
        assert!(task.title.ends_with('…'));
        assert_eq!(task.note.as_deref(), Some(long.as_str()));
    }

    #[test]
    fn demoting_folds_note_and_subtasks_into_one_memo() {
        let db = temp_db();
        let parent = db.create_task("請求書の差し替え", "todo", None).unwrap();
        db.update_task(
            &parent.id,
            &TaskPatch {
                note: Some(Some("先方から連絡あり".into())),
                due: Some(Some("2026-09-20".into())),
                ..Default::default()
            },
        )
        .unwrap();
        let sub = db.create_task("金額を確認", "todo", Some(&parent.id)).unwrap();
        db.update_task(
            &sub.id,
            &TaskPatch {
                note: Some(Some("税抜きか税込みか".into())),
                ..Default::default()
            },
        )
        .unwrap();
        db.create_task("再送する", "todo", Some(&parent.id)).unwrap();

        let memo = db.demote_to_inbox(&parent.id).expect("demote");

        assert_eq!(memo.status, "inbox");
        assert_eq!(memo.note, None);
        assert_eq!(memo.due, None);
        assert_eq!(
            memo.title,
            "請求書の差し替え

先方から連絡あり

- 金額を確認
税抜きか税込みか
- 再送する"
        );
        // サブタスクは本文に畳まれたので行としては残さない
        assert!(db.get_task(&sub.id).unwrap().is_none());
    }

    #[test]
    fn creating_at_top_puts_it_before_everything() {
        let db = temp_db();
        db.create_task("a", "todo", None).unwrap();
        db.create_task("b", "todo", None).unwrap();
        db.create_task_at("first", "todo", None, true).unwrap();
        db.create_task_at("last", "todo", None, false).unwrap();

        let listed = db.list_tasks(Some(vec!["todo".into()])).unwrap();
        assert_eq!(titles(&listed), vec!["first", "a", "b", "last"]);
    }

    #[test]
    fn moving_reorders_within_the_same_level() {
        let db = temp_db();
        let a = db.create_task("a", "todo", None).unwrap();
        let b = db.create_task("b", "todo", None).unwrap();
        let c = db.create_task("c", "todo", None).unwrap();

        // c を a の直後へ
        db.move_task(&c.id, None, Some(&a.id)).expect("move");

        let listed = db.list_tasks(Some(vec!["todo".into()])).unwrap();
        assert_eq!(titles(&listed), vec!["a", "c", "b"]);
        assert_eq!(listed[0].id, a.id);
        assert_eq!(listed[2].id, b.id);
    }

    #[test]
    fn moving_to_the_front_puts_it_first() {
        let db = temp_db();
        let a = db.create_task("a", "todo", None).unwrap();
        db.create_task("b", "todo", None).unwrap();
        let c = db.create_task("c", "todo", None).unwrap();

        db.move_task(&c.id, None, None).expect("move");

        let listed = db.list_tasks(Some(vec!["todo".into()])).unwrap();
        assert_eq!(titles(&listed), vec!["c", "a", "b"]);
        assert_eq!(listed[1].id, a.id);
    }

    #[test]
    fn a_task_can_become_a_subtask_and_come_back() {
        let db = temp_db();
        let parent = db.create_task("parent", "todo", None).unwrap();
        let lone = db.create_task("lone", "todo", None).unwrap();

        db.move_task(&lone.id, Some(&parent.id), None).expect("to sub");
        assert_eq!(
            db.get_task(&lone.id).unwrap().unwrap().parent_id.as_deref(),
            Some(parent.id.as_str())
        );

        db.move_task(&lone.id, None, Some(&parent.id)).expect("back");
        assert_eq!(db.get_task(&lone.id).unwrap().unwrap().parent_id, None);
    }

    #[test]
    fn a_task_with_subtasks_cannot_become_a_subtask() {
        let db = temp_db();
        let parent = db.create_task("parent", "todo", None).unwrap();
        db.create_task("child", "todo", Some(&parent.id)).unwrap();
        let other = db.create_task("other", "todo", None).unwrap();

        let err = db.move_task(&parent.id, Some(&other.id), None);

        assert!(err.is_err(), "1 階層までに保つ");
        assert_eq!(db.get_task(&parent.id).unwrap().unwrap().parent_id, None);
    }

    #[test]
    fn a_task_cannot_be_put_under_itself() {
        let db = temp_db();
        let a = db.create_task("a", "todo", None).unwrap();
        assert!(db.move_task(&a.id, Some(&a.id), None).is_err());
    }

    #[test]
    fn waiting_keeps_the_reason_and_the_follow_up_date() {
        let db = temp_db();
        let t = db.create_task("見積もりをもらう", "todo", None).unwrap();

        let waiting = db
            .set_waiting(&t.id, Some("A 社の回答"), Some("2026-09-20"))
            .expect("set");

        assert_eq!(waiting.status, "waiting");
        assert_eq!(waiting.waiting_for.as_deref(), Some("A 社の回答"));
        assert_eq!(waiting.waiting_until.as_deref(), Some("2026-09-20"));
    }

    #[test]
    fn clearing_waiting_returns_it_to_todo_and_drops_the_reason() {
        let db = temp_db();
        let t = db.create_task("見積もりをもらう", "todo", None).unwrap();
        db.set_waiting(&t.id, Some("A 社の回答"), Some("2026-09-20")).unwrap();

        let back = db.clear_waiting(&t.id).expect("clear");

        assert_eq!(back.status, "todo");
        assert_eq!(back.waiting_for, None);
        assert_eq!(back.waiting_until, None);
    }

    #[test]
    fn waiting_tasks_are_not_offered_as_the_next_thing_to_do() {
        let db = temp_db();
        let done_now = db.create_task("いま終えた", "todo", None).unwrap();
        let blocked = db.create_task("返事待ち", "todo", None).unwrap();
        db.create_task("手を付けられる", "todo", None).unwrap();
        db.set_waiting(&blocked.id, Some("先方"), None).unwrap();

        let got = db.next_candidates(&done_now.id, None, 10).expect("candidates");

        assert_eq!(titles(&got), vec!["手を付けられる"]);
    }

    #[test]
    fn demoting_a_plain_task_keeps_just_its_name() {
        let db = temp_db();
        let task = db.create_task("トナーを補充", "todo", None).unwrap();

        let memo = db.demote_to_inbox(&task.id).expect("demote");

        assert_eq!(memo.title, "トナーを補充");
        assert_eq!(memo.status, "inbox");
    }

    #[test]
    fn trashing_a_parent_takes_its_subtasks_and_restore_brings_them_back() {
        let db = temp_db();
        let parent = db.create_task("請求書対応", "todo", None).unwrap();
        let sub = db.create_task("金額を確認", "todo", Some(&parent.id)).unwrap();

        db.trash_task(&parent.id).expect("trash");

        // 通常の一覧からは消える
        let listed = db.list_tasks(None).unwrap();
        assert!(listed.is_empty(), "ゴミ箱の中身は一覧に出さない");
        // ゴミ箱には親だけ並ぶ (子は親と一緒に戻るので個別には出さない)
        let trash = db.list_trash().unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!(trash[0].id, parent.id);
        // 子も一緒にゴミ箱へ入っている
        assert_eq!(db.get_task(&sub.id).unwrap().unwrap().status, "trashed");

        let restored = db.restore_task(&parent.id).expect("restore");

        assert_eq!(restored.status, "todo");
        assert_eq!(db.get_task(&sub.id).unwrap().unwrap().status, "todo");
        assert!(db.list_trash().unwrap().is_empty());
    }

    #[test]
    fn restoring_returns_an_item_to_the_status_it_had() {
        let db = temp_db();
        let memo = db.create_task("あとで調べる", "inbox", None).unwrap();
        let done = db.create_task("片付いた仕事", "todo", None).unwrap();
        db.set_task_status(&done.id, "done").unwrap();

        db.trash_task(&memo.id).unwrap();
        db.trash_task(&done.id).unwrap();

        assert_eq!(db.restore_task(&memo.id).unwrap().status, "inbox");
        assert_eq!(db.restore_task(&done.id).unwrap().status, "done");
    }

    #[test]
    fn purging_empties_the_trash_and_leaves_everything_else() {
        let db = temp_db();
        let keep = db.create_task("残す", "todo", None).unwrap();
        let drop = db.create_task("捨てる", "todo", None).unwrap();
        db.trash_task(&drop.id).unwrap();

        let removed = db.purge_trash().expect("purge");

        assert_eq!(removed, 1);
        assert!(db.get_task(&drop.id).unwrap().is_none());
        assert!(db.get_task(&keep.id).unwrap().is_some());
    }

    #[test]
    fn empty_due_string_clears_the_due_date() {
        let db = temp_db();
        let t = with_due(&db, "t", None, Some("2026-09-15"));
        assert_eq!(t.due.as_deref(), Some("2026-09-15"));

        let cleared = db
            .update_task(
                &t.id,
                &TaskPatch {
                    due: Some(Some(String::new())),
                    ..Default::default()
                },
            )
            .expect("clear due");

        assert_eq!(cleared.due, None);
    }
}

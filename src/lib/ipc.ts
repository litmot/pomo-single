import { invoke } from "@tauri-apps/api/core";
import type { Settings, Task, TaskStatus, TimerSnapshot, TodayStats } from "./types";

export interface TaskPatch {
  title?: string;
  /** 空文字を渡すとメモを外す */
  note?: string;
  status?: TaskStatus;
  parentId?: string | null;
  urgency?: number | null;
  importance?: number | null;
  estimatePomodoros?: number | null;
  /** "YYYY-MM-DD"。空文字を渡すと期限を外す */
  due?: string;
}


/* ---------- tasks ---------- */

export const listTasks = (statuses?: TaskStatus[]) =>
  invoke<Task[]>("list_tasks", { statuses: statuses ?? null });

export const createTask = (title: string, status: TaskStatus, parentId?: string | null) =>
  invoke<Task>("create_task", { title, status, parentId: parentId ?? null });

/** Quick Capture 専用。必ず inbox に入り、inbox://added を emit する */
export const quickCapture = (title: string) => invoke<Task>("quick_capture", { title });

export const updateTask = (id: string, patch: TaskPatch) =>
  invoke<Task>("update_task", { id, patch });

export const setTaskStatus = (id: string, status: TaskStatus) =>
  invoke<Task>("set_task_status", { id, status });

/** Inbox の 1 件をタスクにする。貼り付けた文章は 1 行目が名前、全文がメモになる */
export const promoteInbox = (id: string) => invoke<Task>("promote_inbox", { id });

/** Inbox の 1 件を、既にあるタスクのメモへ移す */
export const moveInboxToNote = (inboxId: string, targetId: string) =>
  invoke<Task>("move_inbox_to_note", { inboxId, targetId });

/** タスクを一時メモに戻す。名前・メモ・サブタスクが 1 つの文章に畳まれる */
export const demoteToInbox = (id: string) => invoke<Task>("demote_to_inbox", { id });

/* ---------- ゴミ箱 ---------- */

/** 画面からの「削除」「捨てる」はこちら。戻せる */
export const trashTask = (id: string) => invoke<void>("trash_task", { id });
export const restoreTask = (id: string) => invoke<Task>("restore_task", { id });
export const listTrash = () => invoke<Task[]>("list_trash");
export const emptyTrash = () => invoke<number>("empty_trash");

/** ゴミ箱から完全に消す。戻せない */
export const deleteTask = (id: string) => invoke<void>("delete_task", { id });

export const reorderTasks = (ids: string[]) => invoke<void>("reorder_tasks", { ids });

export const inboxCount = () => invoke<number>("inbox_count");

/* ---------- timer ---------- */

export const timerState = () => invoke<TimerSnapshot>("timer_state");
export const timerStart = (taskId: string | null) => invoke<TimerSnapshot>("timer_start", { taskId });
export const timerPause = () => invoke<TimerSnapshot>("timer_pause");
export const timerResume = () => invoke<TimerSnapshot>("timer_resume");
/** 現在のフェーズを完了扱いにせず次へ進める */
export const timerSkip = () => invoke<TimerSnapshot>("timer_skip");
/** セッションを中断して Idle に戻す */
export const timerStop = () => invoke<TimerSnapshot>("timer_stop");
/** タスク切り替え等の「割り込み」を記録する */
export const timerInterrupt = (reason: string) =>
  invoke<TimerSnapshot>("timer_interrupt", { reason });

export const setCurrentTask = (taskId: string | null) =>
  invoke<void>("set_current_task", { taskId });

/* ---------- タスクが早く終わったとき ---------- */

/** 着手中のタスクを完了にする。集中中はタイマーを止めず選択待ちに入る */
export const completeCurrentTask = () => invoke<TimerSnapshot>("complete_current_task");
/** 残り時間を見直しに充てる */
export const chooseReview = () => invoke<TimerSnapshot>("choose_review");
/** 同じセッションを引き継いで次の 1 件へ */
export const chooseHandoff = (taskId: string) =>
  invoke<TimerSnapshot>("choose_handoff", { taskId });
/** 残り時間を切り上げて休憩へ。ポモドーロは完了として数える */
export const chooseBreak = () => invoke<TimerSnapshot>("choose_break");
/** 「次にやる」候補。兄弟サブタスク優先、次に期限の近い順 */
export const nextCandidates = (limit = 3) => invoke<Task[]>("next_candidates", { limit });

/* ---------- settings / stats ---------- */

export const getSettings = () => invoke<Settings>("get_settings");
export const saveSettings = (settings: Settings) => invoke<Settings>("save_settings", { settings });
export const todayStats = () => invoke<TodayStats>("today_stats");

/* ---------- windows ---------- */

export const showManage = () => invoke<void>("show_manage");
/** ホットキー以外の入り口。画面のボタンから入力欄を開く */
export const showCapture = () => invoke<void>("show_capture");
export const hideCapture = () => invoke<void>("hide_capture");
/** 中身の高さに合わせて Focus View を伸縮させる (下端固定で上に伸びる) */
export const resizeFocus = (height: number) => invoke<void>("resize_focus", { height });
/** 中身の高さに合わせて Quick Capture を伸縮させる */
export const resizeCapture = (height: number) => invoke<void>("resize_capture", { height });
/** メモ中のリンクを既定のブラウザで開く (http/https のみ) */
export const openUrl = (url: string) => invoke<void>("open_url", { url });

/** メモを保存する。空文字を渡すと「メモなし」になる */
export const setNote = (id: string, note: string) => updateTask(id, { note });

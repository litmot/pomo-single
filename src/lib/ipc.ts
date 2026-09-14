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

/* ---------- 待ち ---------- */

/** タスクを待ちにする。相手の動きが要因で、自分では進められない状態 */
export const setWaiting = (id: string, waitingFor: string, waitingUntil: string) =>
  invoke<Task>("set_waiting", {
    id,
    waitingFor: waitingFor || null,
    waitingUntil: waitingUntil || null,
  });

/** 待ちを解いて、また手を付けられる状態に戻す */
export const clearWaiting = (id: string) => invoke<Task>("clear_waiting", { id });

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

/**
 * タスクを別の位置へ動かす。並べ替えと階層の移動を兼ねる。
 * `parentId` が null なら最上位、`afterId` の直後に置く (null なら先頭)。
 */
export const moveTask = (id: string, parentId: string | null, afterId: string | null) =>
  invoke<void>("move_task", { id, parentId, afterId });

export const inboxCount = () => invoke<number>("inbox_count");

/* ---------- timer ---------- */

export const timerState = () => invoke<TimerSnapshot>("timer_state");
export const timerStart = (taskId: string | null) => invoke<TimerSnapshot>("timer_start", { taskId });
/** 短い集中を始める。助走なのでポモドーロとしては数えない */
export const timerStartShort = (taskId: string | null) =>
  invoke<TimerSnapshot>("timer_start_short", { taskId });
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

/** 着手先を切り替える。同じ仕事の内訳の中での移動は中断に数えない */
export const switchCurrentTask = (taskId: string) =>
  invoke<TimerSnapshot>("switch_current_task", { taskId });

/* ---------- タスクが早く終わったとき ---------- */

/** 着手中のタスクを完了にする。集中中はタイマーを止めず選択待ちに入る */
export const completeCurrentTask = () => invoke<TimerSnapshot>("complete_current_task");
/** 着手中のタスクを待ちにする。完了と同じく、残り時間の使い道を聞く流れに入る */
export const waitCurrentTask = (waitingFor: string, waitingUntil: string) =>
  invoke<TimerSnapshot>("wait_current_task", {
    waitingFor: waitingFor || null,
    waitingUntil: waitingUntil || null,
  });
/** Focus View をモニタ 1 枚いっぱいに広げる / 小窓に戻す */
export const setFocusFullscreen = (on: boolean) =>
  invoke<Settings>("set_focus_fullscreen", { on });
/** 休憩中の暗幕を外す / 掛け直す。今の休憩の間だけ効く */
export const setBreakDim = (on: boolean) => invoke<TimerSnapshot>("set_break_dim", { on });
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

/* ---------- 次の予定 ---------- */

/** 次の予定 (RFC3339)。過ぎた予定は自動で消えて null が返る */
export const getNextAppointment = () => invoke<string | null>("get_next_appointment");
export const setNextAppointment = (at: string | null) =>
  invoke<void>("set_next_appointment", { at });

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
/** ローカル / ネットワークのパスをエクスプローラーで開く */
export const openPath = (path: string) => invoke<void>("open_path", { path });

/** メモを保存する。空文字を渡すと「メモなし」になる */
export const setNote = (id: string, note: string) => updateTask(id, { note });

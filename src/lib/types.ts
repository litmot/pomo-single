/** Rust 側 (serde rename_all = "camelCase") と 1:1 対応する型定義 */

export type TaskStatus = "inbox" | "todo" | "doing" | "done" | "archived" | "trashed";

export interface Task {
  id: string;
  title: string;
  note: string | null;
  status: TaskStatus;
  parentId: string | null;
  sortOrder: number;
  /** Phase 3 のマトリックス用。0 = 低, 1 = 高。未分類は null */
  urgency: number | null;
  importance: number | null;
  estimatePomodoros: number | null;
  actualPomodoros: number;
  due: string | null;
  createdAt: string;
  completedAt: string | null;
}

export type Phase = "idle" | "focus" | "shortBreak" | "longBreak";

export interface TimerSnapshot {
  phase: Phase;
  running: boolean;
  remainingMs: number;
  totalMs: number;
  /** 長休憩の判定に使う、完了したフォーカスセッション数 */
  completedFocusCount: number;
  currentTaskId: string | null;
  /** 現在のフォーカスセッション中に「中断」した回数 */
  interruptCount: number;
  /** 残り時間を見直しに充てている */
  reviewing: boolean;
  /** タスクが早く終わり、残り時間の使い道を待っている */
  awaitingChoice: boolean;
}

export interface Settings {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  longBreakEvery: number;
  /** Focus View に Inbox の件数を出すか。false ならドットのパルスのみ */
  showInboxCount: boolean;
  soundEnabled: boolean;
  hotkey: string;
  /** Focus View を常に最前面に出すか */
  alwaysOnTop: boolean;
  /** Focus View を半透明にするか (OS 側の透過は次回起動で反映) */
  focusTransparent: boolean;
}

export interface TodayStats {
  completedFocusSessions: number;
  completedTasks: number;
  focusMinutes: number;
  interruptions: number;
}

export interface InboxAddedEvent {
  taskId: string;
  title: string;
}

/** Rust 側から emit されるイベント名 */
export const EV = {
  tick: "timer://tick",
  phase: "timer://phase",
  inboxAdded: "inbox://added",
  tasksChanged: "tasks://changed",
  settingsChanged: "settings://changed",
} as const;

export const PHASE_LABEL: Record<Phase, string> = {
  idle: "待機中",
  focus: "集中",
  shortBreak: "休憩",
  longBreak: "長い休憩",
};

export function isBreak(phase: Phase): boolean {
  return phase === "shortBreak" || phase === "longBreak";
}

/** 期限の切迫度。色分けは「過ぎている / 今日か明日 / それ以外」の 3 段階だけ */
export type DueState = "over" | "soon" | "later";

export function dueState(due: string | null): DueState | null {
  if (!due) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${due}T00:00:00`);
  const days = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  if (days < 0) return "over";
  if (days <= 1) return "soon";
  return "later";
}

/** 期限の表示。年は今年なら省く */
export function formatDue(due: string): string {
  const [y, m, d] = due.split("-");
  const thisYear = String(new Date().getFullYear());
  return y === thisYear ? `${Number(m)}/${Number(d)}` : `${y}/${Number(m)}/${Number(d)}`;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

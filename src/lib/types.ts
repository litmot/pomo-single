/** Rust 側 (serde rename_all = "camelCase") と 1:1 対応する型定義 */

export type TaskStatus =
  | "inbox"
  | "todo"
  | "doing"
  /** 相手の動きを待っている。閉じられないが、自分では進められない */
  | "waiting"
  | "done"
  | "archived"
  | "trashed";

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
  /** 待ちの相手・要因 */
  waitingFor: string | null;
  /** いつまで待つか。過ぎたら催促する目安 */
  waitingUntil: string | null;
  createdAt: string;
  completedAt: string | null;
}

export type Phase = "idle" | "focus" | "shortFocus" | "shortBreak" | "longBreak";

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
  /** 休憩明けで Idle に戻ったとき、その直前に着手していたタスク */
  afterBreakTaskId: string | null;
  /** この休憩では暗幕を自分で外した */
  dimLifted: boolean;
}

export interface Settings {
  focusMinutes: number;
  /** 助走用の短い集中の長さ (分)。ポモドーロの長さとは別 */
  shortFocusMinutes: number;
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
  /** 次の予定の前に空けておく時間 (分) */
  appointmentBufferMinutes: number;
  /** 休憩中、画面全体に暗幕をかけるか */
  breakDim: boolean;
  /** 暗幕の濃さ (%)。0 で透明、100 で真っ暗 */
  breakDimStrength: number;
  /** Focus View をモニタ 1 枚いっぱいに広げるか */
  focusFullscreen: boolean;
}

/** 次の予定までに何本入るかの見立て */
export interface AppointmentPlan {
  /** 予定までの残り (分)。表示用なので緩衝時間は引かない */
  minutesLeft: number;
  /** まるごと入るポモドーロの本数 */
  fits: number;
}

/**
 * 次の予定までに、まるごと入るポモドーロが何本あるかを数える。
 *
 * 最後の 1 本のうしろに休憩は要らないので、n 本に必要なのは
 * `n * 集中 + (n - 1) * 休憩`。緩衝時間は予定の手前から差し引く。
 */
export function planUntil(
  appointmentMs: number,
  nowMs: number,
  settings: Pick<Settings, "focusMinutes" | "shortBreakMinutes" | "appointmentBufferMinutes">,
): AppointmentPlan {
  const minutesLeft = Math.max(0, Math.ceil((appointmentMs - nowMs) / 60_000));
  const usable = appointmentMs - settings.appointmentBufferMinutes * 60_000 - nowMs;
  const focus = settings.focusMinutes * 60_000;
  const brk = settings.shortBreakMinutes * 60_000;
  const fits = usable < focus ? 0 : Math.floor((usable + brk) / (focus + brk));
  return { minutesLeft, fits };
}

/** "HH:MM" を次にその時刻になる瞬間として解釈する */
export function nextOccurrence(time: string, nowMs = Date.now()): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const at = new Date(nowMs);
  at.setHours(Number(m[1]), Number(m[2]), 0, 0);
  // 過ぎている時刻を入れたなら翌日のこと
  if (at.getTime() <= nowMs) at.setDate(at.getDate() + 1);
  return at.toISOString();
}

/** ISO 文字列をローカルの "HH:MM" に戻す */
export function toTimeInput(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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
  // ポモドーロではないことが常に分かるように、別の名前で出す
  shortFocus: "短い集中",
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

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/**
 * 期限の表示。年は今年なら省き、曜日を添える。
 *
 * 曜日が要るのは、締切が平日かどうかで動き方が変わるため。「9/14 まで」
 * だけでは、それが月曜なのか土曜なのか毎回頭の中で数えることになる。
 */
export function formatDue(due: string): string {
  const [y, m, d] = due.split("-");
  const thisYear = String(new Date().getFullYear());
  const date = y === thisYear ? `${Number(m)}/${Number(d)}` : `${y}/${Number(m)}/${Number(d)}`;
  // ローカル時刻として解釈させる。末尾に Z を付けると時差の分だけ曜日がずれる
  const weekday = WEEKDAYS[new Date(`${due}T00:00:00`).getDay()];
  return weekday ? `${date}(${weekday})` : date;
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

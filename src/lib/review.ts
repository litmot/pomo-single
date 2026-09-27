/**
 * 振り返りの集計。
 *
 * 記録 (集中 1 本ごとの記録、途中の切り替え、タスク) から、画面に出す
 * 数字と並びを計算する。Rust 側は材料を渡すだけにして、ここでまとめて
 * テストで固定する。
 *
 * 数え方は画面の上の帯 (今日のポモドーロ数) と揃える:
 * - ポモドーロ = 鳴るまで (または鳴る前に終えて) 締めた標準の集中。短い集中は数えない
 * - 集中した時間 = そのポモドーロの長さの合計
 * - 中断 = 標準の集中の中断回数の合計 (投げ出した 1 本の分も数える)
 */
import type { Task } from "./types";

export interface SessionSwitch {
  taskId: string;
  at: string;
}

export interface SessionRecord {
  id: string;
  taskId: string | null;
  kind: string;
  startedAt: string;
  endedAt: string | null;
  completed: boolean;
  interruptCount: number;
  plannedMs: number;
  outcome: string | null;
  switches: SessionSwitch[];
}

export interface ReviewData {
  sessions: SessionRecord[];
  tasks: Task[];
  capturedInFocus: number;
}

/** 1 本の集中の中で、1 つのタスクをやっていた区間 */
export interface Segment {
  sessionId: string;
  taskId: string | null;
  start: number;
  end: number;
  short: boolean;
  /** その 1 本の中断回数。帯に印を付けるため、最後の区間にだけ入れる */
  interrupts: number;
}

/** 集中 1 本を、途中の切り替えで区間に分ける */
export function segmentsOf(s: SessionRecord): Segment[] {
  const start = Date.parse(s.startedAt);
  const end = s.endedAt ? Date.parse(s.endedAt) : start + s.plannedMs;
  const cuts = s.switches
    .map((w) => ({ taskId: w.taskId, at: Date.parse(w.at) }))
    .filter((w) => w.at > start && w.at < end)
    .sort((a, b) => a.at - b.at);
  const out: Segment[] = [];
  let from = start;
  let task = s.taskId;
  for (const c of cuts) {
    if (c.at > from) out.push({ sessionId: s.id, taskId: task, start: from, end: c.at, short: false, interrupts: 0 });
    from = c.at;
    task = c.taskId;
  }
  if (end > from) out.push({ sessionId: s.id, taskId: task, start: from, end, short: false, interrupts: 0 });
  const short = s.kind === "short_focus";
  out.forEach((g) => (g.short = short));
  if (out.length) out[out.length - 1].interrupts = s.interruptCount;
  return out;
}

export type TouchedState = "done" | "continue" | "waiting" | "trashed";

/** 実行した (または完了した) タスクと、その期間の本数 */
export interface Touched {
  task: Task;
  pomodoros: number;
  shortFocus: number;
  state: TouchedState;
}

export interface Summary {
  pomodoros: number;
  focusMs: number;
  interrupts: number;
  captured: number;
  completedTasks: number;
  /** 終わり方ごとの本数 (標準の集中だけ) */
  outcomes: Record<string, number>;
  touched: Touched[];
  segments: Segment[];
}

const isFocus = (s: SessionRecord) => s.kind === "focus";
const countsAsPomodoro = (s: SessionRecord) => isFocus(s) && s.completed;

function completedWithin(t: Task, from: number, to: number) {
  if (!t.completedAt || (t.status !== "done" && t.status !== "archived")) return false;
  const at = Date.parse(t.completedAt);
  return at >= from && at < to;
}

/** 期間 [from, to) の集計 */
export function summarize(data: ReviewData, from: number, to: number): Summary {
  const sessions = data.sessions.filter((s) => {
    const at = Date.parse(s.startedAt);
    return at >= from && at < to;
  });
  const byId = new Map(data.tasks.map((t) => [t.id, t]));

  const pomodoros = sessions.filter(countsAsPomodoro);
  const outcomes: Record<string, number> = {};
  for (const s of sessions.filter(isFocus)) {
    const key = s.outcome ?? "rang";
    outcomes[key] = (outcomes[key] ?? 0) + 1;
  }

  const segments = sessions.flatMap(segmentsOf);
  const pom = new Map<string, number>();
  const shortCount = new Map<string, number>();
  for (const s of sessions) {
    const ids = new Set(segmentsOf(s).map((g) => g.taskId).filter((x): x is string => Boolean(x)));
    const into = countsAsPomodoro(s) ? pom : s.kind === "short_focus" ? shortCount : null;
    if (!into) continue;
    ids.forEach((id) => into.set(id, (into.get(id) ?? 0) + 1));
  }

  const ids = new Set<string>([...pom.keys(), ...shortCount.keys()]);
  for (const t of data.tasks) if (completedWithin(t, from, to)) ids.add(t.id);

  const touched: Touched[] = [];
  ids.forEach((id) => {
    const task = byId.get(id);
    if (!task) return;
    const state: TouchedState = completedWithin(task, from, to)
      ? "done"
      : task.status === "waiting"
        ? "waiting"
        : task.status === "trashed"
          ? "trashed"
          : "continue";
    touched.push({ task, pomodoros: pom.get(id) ?? 0, shortFocus: shortCount.get(id) ?? 0, state });
  });
  // 手を掛けた順 (本数の多い順)。同じなら完了を先に
  const rank: Record<TouchedState, number> = { done: 0, continue: 1, waiting: 2, trashed: 3 };
  touched.sort((a, b) => b.pomodoros - a.pomodoros || rank[a.state] - rank[b.state] || a.task.title.localeCompare(b.task.title));

  return {
    pomodoros: pomodoros.length,
    focusMs: pomodoros.reduce((n, s) => n + s.plannedMs, 0),
    interrupts: sessions.filter(isFocus).reduce((n, s) => n + s.interruptCount, 0),
    captured: data.capturedInFocus,
    completedTasks: data.tasks.filter((t) => completedWithin(t, from, to)).length,
    outcomes,
    touched,
    segments,
  };
}

/* ---------------- 日付 ---------------- */

/** その日の 0:00 (ローカル) */
export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** その週の月曜 0:00 (ローカル) */
export function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const back = (x.getDay() + 6) % 7; // 月曜を 0 にする
  x.setDate(x.getDate() - back);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** "2026-09-25" (ローカル) */
export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

/** "9/25(金)" */
export function mdw(d: Date): string {
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})`;
}

/** 時間 (ms) を "2:55" の形に */
export function hm(ms: number): string {
  const m = Math.round(ms / 60_000);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

/** 終わり方の呼び名 */
export const OUTCOME_LABEL: Record<string, string> = {
  rang: "最後まで集中した",
  done_early_break: "早めに終えて休憩に入った",
  skipped: "途中で切り上げた",
  abandoned: "途中で中止した",
};

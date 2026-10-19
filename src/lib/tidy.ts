/**
 * 朝の整理。
 *
 * タスクが溜まって動かないまま一覧に居座ると、一覧を開くこと自体が億劫に
 * なり、整理を飛ばして作業を始めてしまう。その日最初に管理画面を開いた
 * ときに、動いていないタスクを数件だけ見直し、今日やる 3 件を決める。
 * 3 分で終わる量に抑える。
 */
import type { Task } from "./types";
import { ymd } from "./review";

/** これだけ動きが無ければ「動いていない」 */
export const STALE_DAYS = 7;
/** 1 回の整理で見直す上限。残りは翌日以降に回る (古いものから出る) */
export const TIDY_LIMIT = 5;
/** 今日やるタスクの数 */
export const TODAY_PICKS = 3;

const DAY = 86_400_000;

/**
 * 最後に動いた時刻 (ms)。作った・残すと決めた・集中で手を付けた・
 * 完了した のうち一番新しいもの。サブタスクの動きも親の動きに数える
 * (サブタスクを 1 つ終えたなら、親は止まっていない)
 */
export function lastMovedAt(task: Task, subs: Task[] = []): number {
  const stamps: (string | null)[] = [];
  for (const t of [task, ...subs]) stamps.push(t.createdAt, t.touchedAt, t.lastWorkedAt, t.completedAt);
  const ms = stamps.filter((x): x is string => Boolean(x)).map((x) => Date.parse(x)).filter(Number.isFinite);
  return ms.length ? Math.max(...ms) : 0;
}

/** 動いていない日数。日付で数える (昨日の夜に作ったものは今朝 1 日) */
export function idleDays(task: Task, subs: Task[] = [], now = Date.now()): number {
  const last = new Date(lastMovedAt(task, subs));
  last.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - last.getTime()) / DAY);
}

/**
 * 見直したほうがよいか。
 * - 一覧に出ている親タスクだけ (サブタスクは親ごと見る)
 * - 定型から作ったものは除く (周期が来れば作り直される)
 * - 期限が今日以降にあるものは除く (いつやるかは決まっている)。期限を過ぎたものは見直す
 */
export function isStale(task: Task, subs: Task[] = [], now = Date.now()): boolean {
  if (task.parentId || task.routineId) return false;
  if (task.status !== "todo" && task.status !== "doing") return false;
  if (task.due && task.due >= ymd(new Date(now))) return false;
  return idleDays(task, subs, now) >= STALE_DAYS;
}

export interface StaleItem {
  task: Task;
  subs: Task[];
  days: number;
}

/** 動いていないタスク。古い順 */
export function staleTasks(tasks: Task[], now = Date.now()): StaleItem[] {
  return tasks
    .filter((t) => !t.parentId)
    .map((task) => ({ task, subs: tasks.filter((s) => s.parentId === task.id) }))
    .filter(({ task, subs }) => isStale(task, subs, now))
    .map((x) => ({ ...x, days: idleDays(x.task, x.subs, now) }))
    .sort((a, b) => b.days - a.days || a.task.sortOrder - b.task.sortOrder);
}

/**
 * 今日やる 3 件の初めの選び。選んでいるタスク (振り返りで決めた「明日の
 * 最初の 1 件」もここに入っている) を先頭に、整理で「今日やる」にした
 * ものを続ける。一覧に出ている親タスクだけ。サブタスクを選んでいれば親を選ぶ
 */
export function initialPicks(open: Task[], all: Task[], currentId: string | null, today: string[]): string[] {
  const openIds = new Set(open.map((t) => t.id));
  const parentOf = (id: string) => all.find((t) => t.id === id)?.parentId ?? id;
  const out: string[] = [];
  for (const id of [...(currentId ? [parentOf(currentId)] : []), ...today]) {
    if (openIds.has(id) && !out.includes(id)) out.push(id);
  }
  return out.slice(0, TODAY_PICKS);
}

/** 選んだ 3 件を一覧の先頭に、残りは今の並びのまま後ろに */
export function orderWithPicks(openIds: string[], picks: string[]): string[] {
  return [...picks.filter((id) => openIds.includes(id)), ...openIds.filter((id) => !picks.includes(id))];
}

/** 朝の整理の記録の鍵 (その日の日付) */
export const tidyKey = (now = Date.now()) => ymd(new Date(now));

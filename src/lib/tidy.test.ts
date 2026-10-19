import { describe, expect, it } from "vitest";
import { idleDays, initialPicks, isStale, orderWithPicks, staleTasks, STALE_DAYS } from "./tidy";
import type { Task } from "./types";

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: id,
  note: null,
  status: "todo",
  parentId: null,
  sortOrder: 0,
  urgency: null,
  importance: null,
  estimatePomodoros: null,
  actualPomodoros: 0,
  due: null,
  waitingFor: null,
  waitingUntil: null,
  createdAt: "2026-10-01T09:00:00",
  completedAt: null,
  prevStatus: null,
  routineId: null,
  hideDoneSubs: false,
  touchedAt: null,
  lastWorkedAt: null,
  ...over,
});

/** 2026-10-19 (月) の朝 */
const NOW = new Date("2026-10-19T08:30:00").getTime();

describe("idleDays", () => {
  it("作ってから、日付で数える", () => {
    expect(idleDays(task("a", { createdAt: "2026-10-18T23:50:00" }), [], NOW)).toBe(1);
    expect(idleDays(task("a", { createdAt: "2026-10-19T07:00:00" }), [], NOW)).toBe(0);
  });

  it("手を付けた・残すと決めた・サブタスクの動きのうち、一番新しいものから数える", () => {
    const t = task("a", { lastWorkedAt: "2026-10-10T10:00:00", touchedAt: "2026-10-12T10:00:00" });
    expect(idleDays(t, [], NOW)).toBe(7);
    const sub = task("s", { parentId: "a", completedAt: "2026-10-17T10:00:00" });
    expect(idleDays(t, [sub], NOW)).toBe(2);
  });
});

describe("isStale", () => {
  const old = { createdAt: "2026-10-01T09:00:00" };
  it(`${STALE_DAYS} 日以上動いていない親タスク`, () => {
    expect(isStale(task("a", old), [], NOW)).toBe(true);
    expect(isStale(task("a", { createdAt: "2026-10-13T09:00:00" }), [], NOW)).toBe(false);
  });

  it("期限が今日以降にあるもの・定型・サブタスク・待ち・いつかは見直さない", () => {
    expect(isStale(task("a", { ...old, due: "2026-10-19" }), [], NOW)).toBe(false);
    expect(isStale(task("a", { ...old, due: "2026-10-30" }), [], NOW)).toBe(false);
    expect(isStale(task("a", { ...old, routineId: "r" }), [], NOW)).toBe(false);
    expect(isStale(task("a", { ...old, parentId: "p" }), [], NOW)).toBe(false);
    expect(isStale(task("a", { ...old, status: "waiting" }), [], NOW)).toBe(false);
    expect(isStale(task("a", { ...old, status: "someday" }), [], NOW)).toBe(false);
  });

  it("期限を過ぎたものは見直す", () => {
    expect(isStale(task("a", { ...old, due: "2026-10-18" }), [], NOW)).toBe(true);
  });
});

describe("staleTasks", () => {
  it("古い順に並べ、サブタスクを添える", () => {
    const tasks = [
      task("new", { createdAt: "2026-10-18T09:00:00" }),
      task("mid", { createdAt: "2026-10-05T09:00:00" }),
      task("oldest", { createdAt: "2026-09-01T09:00:00" }),
      task("sub", { parentId: "mid", createdAt: "2026-10-05T09:00:00" }),
    ];
    const got = staleTasks(tasks, NOW);
    expect(got.map((x) => x.task.id)).toEqual(["oldest", "mid"]);
    expect(got[1].subs.map((s) => s.id)).toEqual(["sub"]);
  });
});

describe("initialPicks / orderWithPicks", () => {
  const open = [task("a"), task("b"), task("c"), task("d")];
  const all = [...open, task("a1", { parentId: "a" })];

  it("選んでいるタスクを先頭に、今日やるにしたものを続ける。サブタスクなら親", () => {
    expect(initialPicks(open, all, "a1", ["c", "a"])).toEqual(["a", "c"]);
    expect(initialPicks(open, all, null, ["d", "c", "b", "a"])).toEqual(["d", "c", "b"]);
    expect(initialPicks(open, all, "gone", [])).toEqual([]);
  });

  it("選んだものを先頭に、残りは今の並びのまま", () => {
    expect(orderWithPicks(["a", "b", "c", "d"], ["c", "a"])).toEqual(["c", "a", "b", "d"]);
  });
});

import { describe, expect, it } from "vitest";
import { segmentsOf, startOfWeek, summarize, ymd, type ReviewData, type SessionRecord } from "./review";
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
  createdAt: "2026-09-25T00:00:00.000Z",
  completedAt: null,
  prevStatus: null,
  routineId: null,
  ...over,
});

const at = (hhmm: string) => `2026-09-25T${hhmm}:00.000Z`;
const session = (id: string, over: Partial<SessionRecord>): SessionRecord => ({
  id,
  taskId: "a",
  kind: "focus",
  startedAt: at("01:00"),
  endedAt: at("01:25"),
  completed: true,
  interruptCount: 0,
  plannedMs: 25 * 60_000,
  outcome: "rang",
  switches: [],
  ...over,
});

const from = Date.parse("2026-09-25T00:00:00.000Z");
const to = Date.parse("2026-09-26T00:00:00.000Z");

describe("segmentsOf", () => {
  it("途中の切り替えで区間に分ける", () => {
    const segs = segmentsOf(session("s", { switches: [{ taskId: "b", at: at("01:10") }] }));
    expect(segs.map((g) => g.taskId)).toEqual(["a", "b"]);
    expect(segs[0].end).toBe(Date.parse(at("01:10")));
  });
});

describe("summarize", () => {
  const data: ReviewData = {
    sessions: [
      session("s1", { switches: [{ taskId: "b", at: at("01:10") }] }),
      session("s2", { startedAt: at("02:00"), endedAt: at("02:25"), interruptCount: 1 }),
      // 途中でやめた 1 本はポモドーロに数えないが、中断は数える
      session("s3", { startedAt: at("03:00"), endedAt: at("03:05"), completed: false, outcome: "abandoned", interruptCount: 1 }),
      // 短い集中はポモドーロに数えない
      session("s4", { kind: "short_focus", taskId: "c", startedAt: at("04:00"), endedAt: at("04:10"), plannedMs: 10 * 60_000 }),
    ],
    tasks: [
      task("a"),
      task("b", { status: "done", completedAt: at("01:12") }),
      task("c", { status: "waiting" }),
      // 集中せずにチェックだけ付けたもの
      task("d", { status: "done", completedAt: at("05:00") }),
    ],
    capturedInFocus: 2,
  };
  const sum = summarize(data, from, to);

  it("ポモドーロと集中した時間は、締めた標準の集中だけを数える", () => {
    expect(sum.pomodoros).toBe(2);
    expect(sum.focusMs).toBe(50 * 60_000);
  });

  it("中断は投げ出した 1 本の分も数える", () => {
    expect(sum.interrupts).toBe(2);
  });

  it("1 本の途中で替えた先にも 🍅 を 1 つ付ける", () => {
    const b = sum.touched.find((x) => x.task.id === "b");
    expect(b?.pomodoros).toBe(1);
    expect(sum.touched.find((x) => x.task.id === "a")?.pomodoros).toBe(2);
  });

  it("手を付けたが終わらなかったタスクは「続き」、待ちにしたものは「待ち」", () => {
    expect(sum.touched.find((x) => x.task.id === "a")?.state).toBe("continue");
    const c = sum.touched.find((x) => x.task.id === "c");
    expect(c?.state).toBe("waiting");
    expect(c?.shortFocus).toBe(1);
  });

  it("集中せずに完了したタスクも、🍅 0 の完了として並べる", () => {
    const d = sum.touched.find((x) => x.task.id === "d");
    expect(d?.state).toBe("done");
    expect(d?.pomodoros).toBe(0);
    expect(sum.completedTasks).toBe(2);
  });

  it("終わり方は標準の集中だけを数える", () => {
    expect(sum.outcomes).toEqual({ rang: 2, abandoned: 1 });
  });
});

describe("startOfWeek", () => {
  it("週は月曜から", () => {
    expect(ymd(startOfWeek(new Date(2026, 8, 27)))).toBe("2026-09-21"); // 日曜
    expect(ymd(startOfWeek(new Date(2026, 8, 21)))).toBe("2026-09-21"); // 月曜
  });
});

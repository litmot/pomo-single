import { describe, expect, it } from "vitest";
import { canNest, resolveDrop } from "./dnd";
import type { Task } from "./types";

function task(id: string, parentId: string | null = null): Task {
  return {
    id,
    title: id,
    note: null,
    status: "todo",
    parentId,
    sortOrder: 0,
    urgency: null,
    importance: null,
    estimatePomodoros: null,
    actualPomodoros: 0,
    due: null,
    waitingFor: null,
    waitingUntil: null,
    createdAt: "",
    completedAt: null,
  };
}

/** a, b, c が最上位。b の下に b1, b2 */
const tasks = [task("a"), task("b"), task("b1", "b"), task("b2", "b"), task("c")];

describe("resolveDrop", () => {
  it("行の下端に落とすと、その行の直後に入る", () => {
    expect(resolveDrop(tasks, "c", { id: "a", zone: "after" })).toEqual({
      parentId: null,
      afterId: "a",
    });
  });

  it("先頭の行の上端に落とすと、一番前に入る", () => {
    expect(resolveDrop(tasks, "c", { id: "a", zone: "before" })).toEqual({
      parentId: null,
      afterId: null,
    });
  });

  it("2 番目の行の上端に落とすと、その 1 つ前の直後に入る", () => {
    expect(resolveDrop(tasks, "c", { id: "b", zone: "before" })).toEqual({
      parentId: null,
      afterId: "a",
    });
  });

  it("中央に落とすとサブタスクになり、内訳の末尾に付く", () => {
    expect(resolveDrop(tasks, "a", { id: "b", zone: "into" })).toEqual({
      parentId: "b",
      afterId: "b2",
    });
  });

  it("内訳が空のタスクの中央に落とすと、最初の 1 件になる", () => {
    expect(resolveDrop(tasks, "b1", { id: "c", zone: "into" })).toEqual({
      parentId: "c",
      afterId: null,
    });
  });

  it("サブタスクを最上位の行の端に落とすと、親タスクに戻る", () => {
    expect(resolveDrop(tasks, "b1", { id: "a", zone: "after" })).toEqual({
      parentId: null,
      afterId: "a",
    });
  });

  it("サブタスクの端に落とすと、同じ親の中で並び替わる", () => {
    expect(resolveDrop(tasks, "b2", { id: "b1", zone: "before" })).toEqual({
      parentId: "b",
      afterId: null,
    });
  });

  it("自分自身の上には落とせない", () => {
    expect(resolveDrop(tasks, "a", { id: "a", zone: "after" })).toBeNull();
  });

  it("並びの計算から、動かしているもの自身は外す", () => {
    // b1 を b2 の上端へ。b1 を除いた兄弟は [b2] だけなので先頭になる
    expect(resolveDrop(tasks, "b1", { id: "b2", zone: "before" })).toEqual({
      parentId: "b",
      afterId: null,
    });
  });
});

describe("canNest", () => {
  it("子を持つタスクはサブタスクにできない", () => {
    expect(canNest(tasks, "b")).toBe(false);
  });

  it("子のないタスクはサブタスクにできる", () => {
    expect(canNest(tasks, "a")).toBe(true);
    expect(canNest(tasks, "c")).toBe(true);
  });
});

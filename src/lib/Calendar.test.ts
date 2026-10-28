import { describe, expect, it } from "vitest";
import { addDays, addMonths, monthGrid } from "./Calendar";

describe("addDays", () => {
  it("月をまたいでずらす", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -7)).toBe("2026-02-22");
  });
});

describe("addMonths", () => {
  it("同じ日のまま月をずらす", () => {
    expect(addMonths("2026-10-15", 1)).toBe("2026-11-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
  });
  it("月末を越える日は末日にそろえる", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
  });
});

describe("monthGrid", () => {
  it("日曜から 6 週ぶん並べる", () => {
    // 2026-10-01 は木曜
    const g = monthGrid(2026, 9);
    expect(g).toHaveLength(42);
    expect(g[0]).toBe("2026-09-27");
    expect(g[4]).toBe("2026-10-01");
    expect(g[41]).toBe("2026-11-07");
  });
});

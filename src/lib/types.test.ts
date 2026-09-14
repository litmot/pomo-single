import { describe, expect, it } from "vitest";
import { formatDue, nextOccurrence, planUntil, toTimeInput } from "./types";

const settings = { focusMinutes: 25, shortBreakMinutes: 5, appointmentBufferMinutes: 5 };
const now = new Date("2026-09-11T09:00:00+09:00").getTime();
const at = (minutes: number) => now + minutes * 60_000;

describe("planUntil", () => {
  it("最後の 1 本のうしろに休憩は要らない", () => {
    // 緩衝 5 分を引いて 25 分ちょうど残る
    expect(planUntil(at(30), now, settings).fits).toBe(1);
  });

  it("2 本目には休憩の分だけ余分に要る", () => {
    // 残り 50 分: 25 + 5 + 25 = 55 なので 1 本まで
    expect(planUntil(at(55), now, settings).fits).toBe(1);
    // 残り 55 分: ちょうど 2 本入る
    expect(planUntil(at(60), now, settings).fits).toBe(2);
  });

  it("1 本も入らないときは 0 を返す", () => {
    expect(planUntil(at(29), now, settings).fits).toBe(0);
    expect(planUntil(at(5), now, settings).fits).toBe(0);
  });

  it("過ぎた予定でも残り時間は負にしない", () => {
    const plan = planUntil(at(-10), now, settings);
    expect(plan.fits).toBe(0);
    expect(plan.minutesLeft).toBe(0);
  });

  it("緩衝時間を 0 にすると予定ぎりぎりまで数える", () => {
    const noBuffer = { ...settings, appointmentBufferMinutes: 0 };
    expect(planUntil(at(25), now, noBuffer).fits).toBe(1);
    expect(planUntil(at(25), now, settings).fits).toBe(0);
  });

  it("集中時間の設定を変えれば本数も変わる", () => {
    const short = { ...settings, focusMinutes: 15, shortBreakMinutes: 3 };
    // 残り 55 分: 15 + 3 + 15 + 3 + 15 = 51 で 3 本
    expect(planUntil(at(60), now, short).fits).toBe(3);
  });
});

describe("nextOccurrence", () => {
  it("これから来る時刻はその日のものとして扱う", () => {
    const iso = nextOccurrence("14:30", now);
    expect(iso).not.toBeNull();
    expect(toTimeInput(iso!)).toBe("14:30");
    expect(new Date(iso!).getTime()).toBeGreaterThan(now);
  });

  it("過ぎた時刻は翌日として扱う", () => {
    const iso = nextOccurrence("08:00", now)!;
    // 9:00 に 8:00 と入れたら、24 時間以内の未来になる
    const diffHours = (new Date(iso).getTime() - now) / 3_600_000;
    expect(diffHours).toBeGreaterThan(22);
    expect(diffHours).toBeLessThan(24);
  });

  it("時刻として読めない入力は null", () => {
    expect(nextOccurrence("", now)).toBeNull();
    expect(nextOccurrence("25:99x", now)).toBeNull();
  });
});

describe("formatDue", () => {
  it("今年なら年を省いて曜日を添える", () => {
    const year = new Date().getFullYear();
    // 2026-09-14 は月曜
    expect(formatDue(`${year}-09-14`)).toBe(
      year === 2026 ? "9/14(月)" : `${year}/9/14(${"日月火水木金土"[new Date(`${year}-09-14T00:00:00`).getDay()]})`,
    );
  });

  it("今年でなければ年も出す", () => {
    expect(formatDue("2025-01-03")).toBe("2025/1/3(金)");
  });

  it("日付として読めなければ曜日を付けない", () => {
    expect(formatDue("2025-99-99")).toBe("2025/99/99");
  });
});

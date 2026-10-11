import { describe, expect, it } from "vitest";
import { colorMix, colorName } from "./noise";

describe("colorMix", () => {
  it("左端はブラウン、真ん中はピンク、右端はホワイトだけ", () => {
    expect(colorMix(0)).toEqual({ brown: 1, pink: 0, white: 0 });
    const mid = colorMix(50);
    expect(mid.pink).toBeCloseTo(1);
    expect(mid.brown).toBeCloseTo(0);
    expect(mid.white).toBe(0);
    const right = colorMix(100);
    expect(right.white).toBeCloseTo(1);
    expect(right.pink).toBeCloseTo(0);
  });

  it("どの位置でも、割合の 2 乗の和は 1 (つまみを動かしても大きさが変わらない)", () => {
    for (let v = 0; v <= 100; v += 5) {
      const m = colorMix(v);
      expect(m.brown ** 2 + m.pink ** 2 + m.white ** 2).toBeCloseTo(1);
    }
  });
});

describe("colorName", () => {
  it("位置の呼び名", () => {
    expect(colorName(0)).toBe("ブラウン");
    expect(colorName(25)).toBe("ブラウン寄り");
    expect(colorName(50)).toBe("ピンク");
    expect(colorName(75)).toBe("ホワイト寄り");
    expect(colorName(100)).toBe("ホワイト");
  });
});

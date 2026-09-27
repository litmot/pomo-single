import { describe, expect, it } from "vitest";
import { actionFor, reservedReason, specOf, type KeyLike } from "./keys";

const k = (key: string, over: Partial<KeyLike> = {}): KeyLike => ({
  key,
  code: "",
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...over,
});

describe("specOf", () => {
  it("英字は大文字 1 字、Shift を押していれば Shift+ を付ける", () => {
    expect(specOf(k("d"))).toBe("D");
    expect(specOf(k("T", { shiftKey: true }))).toBe("Shift+T");
  });

  it("記号は Shift の有無を問わずその文字だけ (日本語キーボードの + は Shift+;)", () => {
    expect(specOf(k("+", { shiftKey: true }))).toBe("+");
    expect(specOf(k("+"))).toBe("+");
  });

  it("名前のあるキーはその名前", () => {
    expect(specOf(k("F2"))).toBe("F2");
    expect(specOf(k("Delete"))).toBe("Delete");
    expect(specOf(k("F2", { shiftKey: true }))).toBe("Shift+F2");
  });

  it("Ctrl・Alt 付きと、修飾キーだけのときは読まない", () => {
    expect(specOf(k("c", { ctrlKey: true }))).toBeNull();
    expect(specOf(k("Shift", { shiftKey: true }))).toBeNull();
  });

  it("日本語入力がオンで文字が取れないときは、キーの位置から読む", () => {
    expect(specOf(k("Process", { code: "KeyD" }))).toBe("D");
    expect(specOf(k("Process", { code: "NumpadAdd" }))).toBe("+");
  });
});

describe("reservedReason", () => {
  it("移動・選択・メニューのキーは割り当てられない", () => {
    expect(reservedReason("Enter")).not.toBeNull();
    expect(reservedReason("ArrowUp")).not.toBeNull();
    expect(reservedReason("Shift+F10")).not.toBeNull();
    expect(reservedReason("D")).toBeNull();
  });
});

describe("actionFor", () => {
  const keys = { due: "D", sub: "+", promoteSelect: "Shift+T", demote: "" };

  it("割り当てたキーの操作を返す", () => {
    expect(actionFor(keys, k("d"))).toBe("due");
    expect(actionFor(keys, k("+", { shiftKey: true }))).toBe("sub");
    expect(actionFor(keys, k("T", { shiftKey: true }))).toBe("promoteSelect");
  });

  it("Shift の有無が違う英字は別のキー", () => {
    expect(actionFor(keys, k("t"))).toBeNull();
    expect(actionFor(keys, k("D", { shiftKey: true }))).toBeNull();
  });

  it("割り当てなし (空) には何も当たらない", () => {
    expect(actionFor(keys, k("x"))).toBeNull();
  });
});

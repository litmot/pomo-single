import { describe, expect, it } from "vitest";
import {
  continueListEdit,
  lineEndOffset,
  listEdit,
  parseInline,
  parseLines,
  plainLine,
  toggleCheck,
  wrapEdit,
  type Edit,
} from "./noteMarks";

/** Edit を当てた後の本文と選択 */
const apply = (v: string, e: Edit) => ({
  value: v.slice(0, e.from) + e.text + v.slice(e.to),
  sel: [e.selStart, e.selEnd],
});

describe("parseInline", () => {
  it("太字・斜体・取り消し線", () => {
    expect(parseInline("a **b** c")).toEqual([
      { t: "text", s: "a " },
      { t: "b", c: [{ t: "text", s: "b" }] },
      { t: "text", s: " c" },
    ]);
    expect(parseInline("*斜体*")).toEqual([{ t: "i", c: [{ t: "text", s: "斜体" }] }]);
    expect(parseInline("~~消す~~")).toEqual([{ t: "s", c: [{ t: "text", s: "消す" }] }]);
  });

  it("入れ子にできる", () => {
    expect(parseInline("~~**x**~~")).toEqual([{ t: "s", c: [{ t: "b", c: [{ t: "text", s: "x" }] }] }]);
  });

  it("対にならない記号や、掛け算の * はそのまま", () => {
    expect(parseInline("2 * 3 * 4")).toEqual([{ t: "text", s: "2 * 3 * 4" }]);
    expect(parseInline("**閉じない")).toEqual([{ t: "text", s: "**閉じない" }]);
    expect(parseInline("~~")).toEqual([{ t: "text", s: "~~" }]);
  });
});

describe("parseLines", () => {
  it("箇条書き・チェック・ふつうの行と、段", () => {
    const got = parseLines("見出し\n- 項目\n  - [ ] 下の段\n- [x] 済み");
    expect(got.map((l) => l.kind)).toEqual(["text", "bullet", "check", "check"]);
    expect(got[2]).toMatchObject({ indent: 1, content: "下の段", checked: false });
    expect(got[3]).toMatchObject({ indent: 0, content: "済み", checked: true });
  });
});

describe("plainLine / toggleCheck / lineEndOffset", () => {
  it("要約では記号を外す", () => {
    expect(plainLine("- [ ] **見積**を送る")).toBe("☐ 見積を送る");
    expect(plainLine("- [x] 済み")).toBe("☑ 済み");
    expect(plainLine("- 項目")).toBe("・項目");
    expect(plainLine("~~消した~~ *斜め*")).toBe("消した 斜め");
  });

  it("チェックを付け外しする", () => {
    expect(toggleCheck("a\n- [ ] b", 1)).toBe("a\n- [x] b");
    expect(toggleCheck("a\n- [x] b", 1)).toBe("a\n- [ ] b");
    expect(toggleCheck("a\n- b", 1)).toBe("a\n- b");
  });

  it("行の末尾の位置", () => {
    expect(lineEndOffset("ab\ncde\nf", 1)).toBe(6);
    expect(lineEndOffset("ab", 5)).toBe(2);
  });
});

describe("wrapEdit", () => {
  it("選んだ文字を囲み、もう一度で外す", () => {
    const v = "abc def";
    const once = apply(v, wrapEdit(v, 4, 7, "**"));
    expect(once).toEqual({ value: "abc **def**", sel: [6, 9] });
    const twice = apply(once.value, wrapEdit(once.value, 6, 9, "**"));
    expect(twice).toEqual({ value: "abc def", sel: [4, 7] });
  });

  it("何も選んでいなければ記号の間にカーソル", () => {
    expect(apply("ab", wrapEdit("ab", 1, 1, "~~"))).toEqual({ value: "a~~~~b", sel: [3, 3] });
  });
});

describe("continueListEdit", () => {
  it("箇条書き・チェックの次の行にも頭を付ける", () => {
    const v = "- [x] 済み";
    expect(apply(v, continueListEdit(v, v.length)!)).toEqual({
      value: "- [x] 済み\n- [ ] ",
      sel: [15, 15],
    });
    const b = "  - 下の段";
    expect(apply(b, continueListEdit(b, b.length)!).value).toBe("  - 下の段\n  - ");
  });

  it("頭だけの行で Enter ならリストを抜ける", () => {
    const v = "- a\n- ";
    expect(apply(v, continueListEdit(v, v.length)!)).toEqual({ value: "- a\n", sel: [4, 4] });
  });

  it("リストでない行はふつうの改行", () => {
    expect(continueListEdit("abc", 3)).toBeNull();
  });
});

describe("listEdit", () => {
  it("行をチェックにし、もう一度で外す。箇条書きからは付け替える", () => {
    const v = "a\nb";
    const on = apply(v, listEdit(v, 0, 3, "check"));
    expect(on.value).toBe("- [ ] a\n- [ ] b");
    expect(apply(on.value, listEdit(on.value, 0, on.value.length, "check")).value).toBe("a\nb");
    expect(apply("- a", listEdit("- a", 1, 1, "check")).value).toBe("- [ ] a");
  });

  it("1 行ならカーソルは行末", () => {
    expect(apply("x\nab", listEdit("x\nab", 3, 3, "bullet"))).toEqual({ value: "x\n- ab", sel: [6, 6] });
  });
});

import { describe, expect, it } from "vitest";
import { extractPaths, extractUrls, linkAt, linkSpans } from "./NoteBody";

// バックスラッシュのエスケープで読み違えないよう、パスは String.raw で書く
const r = String.raw;

describe("extractPaths", () => {
  it("ドライブ付きのパスを拾う", () => {
    expect(extractPaths(r`資料は C:\work\report.xlsx にある`)).toEqual([r`C:\work\report.xlsx`]);
  });

  it("ネットワークのパスを拾う", () => {
    expect(extractPaths(r`共有: \\fileserver\share\2026\見積`)).toEqual([
      r`\\fileserver\share\2026\見積`,
    ]);
  });

  it("空白を含むパスは引用符で囲んであれば 1 本として拾う", () => {
    expect(extractPaths(r`"C:\Program Files\App\readme.txt" を参照`)).toEqual([
      r`C:\Program Files\App\readme.txt`,
    ]);
  });

  it("囲んでいなければ空白で切る", () => {
    expect(extractPaths(r`C:\Program Files\App`)).toEqual([r`C:\Program`]);
  });

  it("末尾の句読点は含めない", () => {
    expect(extractPaths(r`D:\data\a.csv。次に`)).toEqual([r`D:\data\a.csv`]);
  });

  it("URL は拾わない", () => {
    expect(extractPaths("https://example.com/a")).toEqual([]);
  });

  it("同じパスは 1 つにまとめる", () => {
    expect(extractPaths(r`C:\a\b と C:\a\b`)).toEqual([r`C:\a\b`]);
  });
});

describe("extractPaths と括弧", () => {
  it("全角の括弧を含むフォルダ名を切らない", () => {
    expect(extractPaths(r`\\nas\share\見積（2026）\a.xlsx を見る`)).toEqual([
      r`\\nas\share\見積（2026）\a.xlsx`,
    ]);
  });

  it("文の側の閉じ括弧は含めない", () => {
    expect(extractPaths(r`（資料は C:\work\a.txt）`)).toEqual([r`C:\work\a.txt`]);
    expect(extractPaths(r`(see C:\work\a.txt)`)).toEqual([r`C:\work\a.txt`]);
  });

  it("引用符で囲んだ半角括弧付きのフォルダ名を切らない", () => {
    expect(extractPaths(r`"C:\Program Files (x86)\App"`)).toEqual([r`C:\Program Files (x86)\App`]);
  });
});

describe("extractUrls", () => {
  it("URL の末尾の括弧は含めない", () => {
    expect(extractUrls("(https://example.com/x)")).toEqual(["https://example.com/x"]);
  });
});

describe("linkSpans", () => {
  it("色を付ける範囲は本文の見た目どおり (引用符を含む)", () => {
    const text = r`見て "C:\Program Files\App" と https://a.example/x です`;
    const spans = linkSpans(text);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual([
      r`"C:\Program Files\App"`,
      "https://a.example/x",
    ]);
    expect(spans[0].target).toBe(r`C:\Program Files\App`);
  });

  it("張り付いた助詞は色を付けない", () => {
    const text = r`C:\work\a.txtです`;
    const [s] = linkSpans(text);
    expect(text.slice(s.start, s.end)).toBe(r`C:\work\a.txt`);
  });

  it("キャレットの位置のリンクを返す", () => {
    const text = "前 https://a.example/x 後";
    expect(linkAt(text, 5)?.target).toBe("https://a.example/x");
    expect(linkAt(text, 0)).toBeNull();
  });
});

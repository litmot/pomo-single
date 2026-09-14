import { describe, expect, it } from "vitest";
import { extractPaths, extractUrls } from "./NoteBody";

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

describe("extractUrls", () => {
  it("URL の末尾の括弧は含めない", () => {
    expect(extractUrls("(https://example.com/x)")).toEqual(["https://example.com/x"]);
  });
});

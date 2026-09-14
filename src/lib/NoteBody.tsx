import * as ipc from "./ipc";

/** 行頭・行末の空白を保ったまま、URL だけを拾う */
const URL_RE = /(https?:\/\/[^\s<>"'）)\]】]+)/g;

/**
 * Windows のパス。`C:\...` のドライブ付きと `\\server\share` の UNC。
 *
 * パスには空白が入ることがある ("C:\Program Files\...")。空白入りは
 * 引用符で囲んだものだけを 1 本と見なし、囲んでいなければ空白で切る。
 * どこまでがパスなのかを本文から当てるのは無理なので、書き手に
 * 引用符で教えてもらう。日本語の文の中に置かれることが多いので、
 * 句読点や括弧でも切る (それらを含むフォルダ名はまず無い)。
 */
const PATH_RE =
  /"((?:[A-Za-z]:\\|\\\\)[^"\n]+)"|((?:[A-Za-z]:\\|\\\\)[^\s<>"|?*。、，．（）「」『』【】]+)/g;

export interface NoteLink {
  kind: "url" | "path";
  /** 押したときに渡す値 (パスは引用符を外したもの) */
  target: string;
  /** 見せる文字 */
  label: string;
}

/** メモに含まれる URL を重複なく取り出す */
export function extractUrls(text: string): string[] {
  return Array.from(new Set(text.match(URL_RE) ?? []));
}

/** メモに含まれるパス (ローカル / ネットワーク) を重複なく取り出す */
export function extractPaths(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(PATH_RE)) {
    const p = (m[1] ?? m[2] ?? "").replace(/[.,、。)]+$/, "");
    if (p) found.push(p);
  }
  return Array.from(new Set(found));
}

/** URL とパスをまとめて、出てきた順に */
export function extractLinks(text: string): NoteLink[] {
  const urls = extractUrls(text).map<NoteLink>((u) => ({ kind: "url", target: u, label: u }));
  const paths = extractPaths(text).map<NoteLink>((p) => ({ kind: "path", target: p, label: p }));
  return [...urls, ...paths];
}

/**
 * メモ本文から拾った URL とパスを押せる形で並べる。
 *
 * 本文そのものは編集できる textarea なので、その中ではリンクを押せない。
 * 別立てにすることで、書きかけでも参照だけはできる。
 *
 * `<a href>` は使わない。webview 内で遷移するとアプリ自体が
 * 別のページに化けるため、URL は必ず既定のブラウザ、パスは
 * エクスプローラーで開く。
 */
export function NoteLinks({ text }: { text: string }) {
  const links = extractLinks(text);
  if (links.length === 0) return null;

  return (
    <div className="note-links">
      {links.map((link) => (
        <button
          key={`${link.kind}:${link.target}`}
          className={`note-link is-${link.kind}`}
          title={
            link.kind === "url"
              ? `ブラウザで開く: ${link.target}`
              : `エクスプローラーで開く: ${link.target}`
          }
          onClick={() =>
            void (link.kind === "url" ? ipc.openUrl(link.target) : ipc.openPath(link.target)).catch(
              () => undefined,
            )
          }
        >
          {link.kind === "path" && <span className="note-link-mark">📁</span>}
          {link.label}
        </button>
      ))}
    </div>
  );
}

/** メモの 1 行目だけを、一覧に添える短い手掛かりとして返す */
export function noteSummary(note: string, max = 60): string {
  const line = note.split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

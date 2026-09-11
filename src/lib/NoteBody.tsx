import * as ipc from "./ipc";

/** 行頭・行末の空白を保ったまま、URL だけを拾う */
const URL_RE = /(https?:\/\/[^\s<>"'）)\]】]+)/g;

/** メモに含まれる URL を重複なく取り出す */
export function extractUrls(text: string): string[] {
  return Array.from(new Set(text.match(URL_RE) ?? []));
}

/**
 * メモ本文から拾った URL を押せる形で並べる。
 *
 * 本文そのものは編集できる textarea なので、その中ではリンクを押せない。
 * 別立てにすることで、書きかけでも参照だけはできる。
 *
 * `<a href>` は使わない。webview 内で遷移するとアプリ自体が
 * 別のページに化けるため、開くのは必ず既定のブラウザ。
 */
export function NoteLinks({ text }: { text: string }) {
  const urls = extractUrls(text);
  if (urls.length === 0) return null;

  return (
    <div className="note-links">
      {urls.map((url) => (
        <button
          key={url}
          className="note-link"
          title={`ブラウザで開く: ${url}`}
          onClick={() => void ipc.openUrl(url).catch(() => undefined)}
        >
          {url}
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

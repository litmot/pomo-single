/**
 * 管理画面の「元に戻す」と「やり直す」。
 *
 * 操作のたびに、その逆を行う関数と、もう一度行う関数を積んでおく。
 * Ctrl+Z で最後の 1 つを戻し、Ctrl+Y (または Ctrl+Shift+Z) で戻したものを
 * やり直す。一番の目的は、完了のチェックを押し間違えたときに慌てず
 * 戻せること。
 *
 * サーバー側に履歴を持たせるのではなく、画面側で「今の状態から戻す手順」を
 * 覚えておく作り。操作の直後に戻すためのものなので、これで足りる。
 * アプリを閉じれば消える。
 */

export interface UndoEntry {
  /** 何を戻すか。戻した後に見せる */
  label: string;
  /** その操作の直前の状態に戻す */
  undo: () => Promise<unknown>;
  /** 戻したものを、もう一度行う */
  redo: () => Promise<unknown>;
}

const LIMIT = 50;
const past: UndoEntry[] = [];
const future: UndoEntry[] = [];
const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

/** 操作を 1 つ積む。新しい操作をしたら、やり直しの列は捨てる */
export function record(label: string, undo: () => Promise<unknown>, redo: () => Promise<unknown>) {
  past.push({ label, undo, redo });
  if (past.length > LIMIT) past.shift();
  future.length = 0;
  notify();
}

/** 最後の操作を戻す。戻したものの名前を返す。何も無ければ null */
export async function undoLast(): Promise<string | null> {
  const entry = past.pop();
  if (!entry) return null;
  await entry.undo();
  future.push(entry);
  notify();
  return entry.label;
}

/** 最後に戻した操作をやり直す。やり直したものの名前を返す。何も無ければ null */
export async function redoLast(): Promise<string | null> {
  const entry = future.pop();
  if (!entry) return null;
  await entry.redo();
  past.push(entry);
  notify();
  return entry.label;
}

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** 入力欄の中なら、ブラウザ自身の Ctrl+Z / Ctrl+Y (文字の取り消し) に任せる */
export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

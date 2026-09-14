/**
 * 管理画面の「元に戻す」。
 *
 * 操作のたびに、その逆を行う関数を積んでおく。Ctrl+Z で最後の 1 つを
 * 取り出して実行する。一番の目的は、完了のチェックを押し間違えたときに
 * 慌てず戻せること。
 *
 * サーバー側に履歴を持たせるのではなく、画面側で「今の状態から戻す手順」を
 * 覚えておく作り。操作の直後に戻すためのものなので、これで足りる。
 * アプリを閉じれば消える。
 */

export interface UndoEntry {
  /** 何を戻すか。戻した後に見せる */
  label: string;
  undo: () => Promise<unknown>;
}

const LIMIT = 50;
const stack: UndoEntry[] = [];
const listeners = new Set<(depth: number) => void>();

function notify() {
  for (const l of listeners) l(stack.length);
}

/** 操作を 1 つ積む。`undo` はその操作の直前の状態に戻す手順 */
export function record(label: string, undo: () => Promise<unknown>) {
  stack.push({ label, undo });
  if (stack.length > LIMIT) stack.shift();
  notify();
}

/** 最後の操作を戻す。戻したものの名前を返す。何も無ければ null */
export async function undoLast(): Promise<string | null> {
  const entry = stack.pop();
  notify();
  if (!entry) return null;
  await entry.undo();
  return entry.label;
}

export function subscribe(listener: (depth: number) => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** 入力欄の中なら、ブラウザ自身の Ctrl+Z (文字の取り消し) に任せる */
export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable;
}

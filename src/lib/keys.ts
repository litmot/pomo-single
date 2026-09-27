/**
 * ショートカットキーの書き方と照合。
 *
 * キーは文字列で持つ: "C" / "Shift+T" / "+" / "F2" / "Delete"。
 * - 英字は大文字 1 字。Shift を押していれば "Shift+" を前に付ける。
 * - 記号と数字はその文字だけ。Shift の有無は問わない — 「+」は日本語
 *   キーボードでは Shift+; 、英語キーボードでは Shift+= 、テンキーでは
 *   Shift なしで出るので、Shift まで見ると押し方によって効かなくなる。
 * - それ以外 (F2・Delete など) はキーの名前。Shift を押していれば前に付ける。
 * Ctrl・Alt との組み合わせは使わない。Ctrl+C (コピー)・Ctrl+Z (元に戻す)
 * など、Windows や他の操作とぶつかりやすいため。
 */

export interface KeyLike {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** 行の移動・選択・メニューに使っているので、割り当てられないキー */
const RESERVED = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Tab",
  "Shift+Tab",
  "Escape",
  "Shift+Escape",
  "Enter",
  "Shift+Enter",
  "Space",
  "Shift+Space",
  "ContextMenu",
  "Shift+F10",
]);

/** 押しただけでは何も決まらないキー。記録中はこれを無視して次を待つ */
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "NumLock", "Process", "Dead"]);

/**
 * 押されたキーを、上の書き方にする。Ctrl・Alt 付きや、修飾キーだけのときは null。
 *
 * 文字は e.key で見る。e.code (キーの位置) は、リモートデスクトップや
 * 入力を送り込むツール経由だと空で届くことがある。日本語入力がオンで
 * e.key が "Process" になったときだけ、位置から英字・数字を読む。
 */
export function specOf(e: KeyLike): string | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  let key = e.key;
  if (key === "Process") {
    const m = /^(?:Key([A-Z])|Digit([0-9])|Numpad([0-9]))$/.exec(e.code);
    if (!m) return e.code === "NumpadAdd" ? "+" : null;
    key = m[1] ?? m[2] ?? m[3];
  }
  if (MODIFIERS.has(key)) return null;
  if (key === " ") key = "Space";
  const shift = e.shiftKey ? "Shift+" : "";
  if (key.length === 1) {
    if (/[a-z]/i.test(key)) return shift + key.toUpperCase();
    return key;
  }
  return shift + key;
}

/** 割り当てられないキーなら、その理由 */
export function reservedReason(spec: string, e?: KeyLike): string | null {
  if (e && (e.ctrlKey || e.altKey || e.metaKey)) return "Ctrl・Alt との組み合わせは使えません";
  if (RESERVED.has(spec)) return `「${spec}」は移動・選択・メニューに使っているので割り当てられません`;
  return null;
}

/** 押されたキーに割り当てた操作の id。無ければ null */
export function actionFor(keys: Record<string, string>, e: KeyLike): string | null {
  const spec = specOf(e);
  if (!spec) return null;
  for (const [id, k] of Object.entries(keys)) {
    if (k && k === spec) return id;
  }
  return null;
}

/** タスクのキーの既定 */
export const DEFAULT_TASK_KEYS: Record<string, string> = {
  done: "C",
  wait: "W",
  rename: "F2",
  due: "D",
  memo: "M",
  important: "I",
  sub: "+",
  demote: "",
  delete: "Delete",
};

/** 一時メモのキーの既定 */
export const DEFAULT_MEMO_KEYS: Record<string, string> = {
  promote: "T",
  promoteSelect: "Shift+T",
  rewrite: "F2",
  delete: "Delete",
};

/** 行に出すボタンの既定 (左から)。「⋯」は常に最後に出すのでここに入れない */
export const DEFAULT_ROW_BUTTONS = ["primary", "due", "memo", "sub"];

/** 保存してある割り当てに、後から足した操作の既定を補う */
export function withDefaults(saved: Record<string, string> | undefined, defaults: Record<string, string>) {
  return { ...defaults, ...(saved ?? {}) };
}

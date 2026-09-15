/**
 * 一覧のキーボード操作。
 *
 * マウスなら行に乗せればボタンが出るが、キーボードだと Tab で
 * 見えないボタンを渡り歩くことになる。そこで行そのものを focus できる
 * ようにし、矢印キーで動けるようにする:
 *
 *   ↑ / ↓   行から行へ (ボタンの上にいても、隣の行へ)
 *   → / ←   行の中のボタンを順に (← で最初のボタンから行に戻る)
 *   Enter   行の上なら「行の既定の操作」(引数で渡す)。ボタンの上なら押す
 *   Esc     ボタンから行に戻る / 行から外れる
 *
 * 行が focus されている間は、マウスを乗せたときと同じ見た目にする
 * (CSS の :focus-within)。
 */

export interface KeyNavOptions {
  /** 行と見なす要素の selector。この中に focus できる行が並ぶ */
  row: string;
  /** 行の中で ← → で渡り歩くもの */
  button: string;
  /** 行の上で Enter を押したとき */
  onEnter?: (row: HTMLElement) => void;
  /** 行の上で ← を押したとき (隣の一覧へ移るなど) */
  onLeft?: (row: HTMLElement) => void;
  /** 最後のボタンの上で → を押したとき (隣の一覧へ移るなど) */
  onRightEnd?: (row: HTMLElement) => void;
}

/** 入力欄の中では矢印キーをカーソル移動に譲る */
function inEditor(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function visible(el: HTMLElement): boolean {
  return el.offsetParent !== null;
}

/** React の合成イベントでも DOM のイベントでも受けられる最小限の形 */
interface KeyLike {
  key: string;
  target: EventTarget | null;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

/** 一覧の入れ物に付ける keydown ハンドラを作る */
export function keyNavHandler(container: HTMLElement, opts: KeyNavOptions) {
  return (e: KeyLike) => {
    if (inEditor(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>(opts.row);
    if (!row || !container.contains(row)) return;

    const rows = Array.from(container.querySelectorAll<HTMLElement>(opts.row)).filter(visible);
    const buttons = Array.from(row.querySelectorAll<HTMLElement>(opts.button)).filter(visible);
    const onRow = target === row;
    const bi = buttons.indexOf(target);

    const focusRow = (r: HTMLElement | undefined) => {
      if (!r) return;
      r.focus();
      r.scrollIntoView({ block: "nearest" });
    };

    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        const i = rows.indexOf(row);
        focusRow(rows[e.key === "ArrowDown" ? i + 1 : i - 1]);
        break;
      }
      case "ArrowRight": {
        const next = onRow ? buttons[0] : buttons[bi + 1];
        if (next) next.focus();
        else opts.onRightEnd?.(row);
        break;
      }
      case "ArrowLeft": {
        if (onRow) opts.onLeft?.(row);
        else if (bi <= 0) focusRow(row);
        else buttons[bi - 1].focus();
        break;
      }
      case "Enter": {
        if (!onRow) return; // ボタンの上なら、ボタン自身の click に任せる
        opts.onEnter?.(row);
        break;
      }
      case "Escape": {
        if (onRow) row.blur();
        else focusRow(row);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
}

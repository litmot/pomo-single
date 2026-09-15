/**
 * 管理画面のキーボード操作。
 *
 * マウスなら行に乗せればボタンが出るが、キーボードだと Tab で
 * 見えないボタンを渡り歩くことになる。そこで行そのものを focus できる
 * ようにし、矢印キーで動けるようにする:
 *
 *   ↑ / ↓   縦の並びを上下に。行から行へだけでなく、その上下にある
 *           もの (設定、＋、引き出しの見出し、開始ボタン、次の予定) へも渡る
 *   → / ←   行の中のボタンを順に (← で最初のボタンから行に戻る)
 *   Enter   行の上なら「行の既定の操作」(引数で渡す)。ボタンの上なら押す
 *   Esc     ボタンから行に戻る / 行から外れる
 *
 * 行が focus されている間は、マウスを乗せたときと同じ見た目にする
 * (CSS の :focus-visible)。
 */

/** React の合成イベントでも DOM のイベントでも受けられる最小限の形 */
export interface KeyLike {
  key: string;
  target: EventTarget | null;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

/**
 * 入力欄の中では矢印キーをカーソル移動に譲る。
 * `data-arrow-nav` を付けた欄 (次の予定の時刻) だけは、矢印を移動に使う
 */
export function inEditor(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.dataset.arrowNav !== undefined) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

function usable(el: HTMLElement): boolean {
  return el.offsetParent !== null && !(el as HTMLButtonElement).disabled;
}

export function focusStop(el: HTMLElement | undefined) {
  if (!el) return;
  el.focus();
  el.scrollIntoView({ block: "nearest" });
}

/* ---- 行の中 (← → Enter Esc) ---- */

export interface RowNavOptions {
  /** 行と見なす要素の selector */
  row: string;
  /** 行の中で ← → で渡り歩くもの */
  button: string;
  /** 行の上で Enter を押したとき */
  onEnter?: (row: HTMLElement) => void;
  /** 行の上で ← を押したとき (隣の一覧へ移るなど) */
  onLeft?: (row: HTMLElement) => void;
  /** 最後のボタンの上で → を押したとき (隣の一覧へ移るなど) */
  onRightEnd?: (row: HTMLElement) => void;
  /** 行の上で Esc を押したとき。true を返せば行に留まる (既定は外れる) */
  onEscape?: (row: HTMLElement) => boolean;
}

/** 一覧の入れ物に付ける keydown ハンドラ。上下は縦の並び (verticalNav) に任せる */
export function rowNavHandler(container: HTMLElement, opts: RowNavOptions) {
  return (e: KeyLike) => {
    if (inEditor(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>(opts.row);
    if (!row || !container.contains(row)) return;

    const buttons = Array.from(row.querySelectorAll<HTMLElement>(opts.button)).filter(usable);
    const onRow = target === row;
    const bi = buttons.indexOf(target);

    switch (e.key) {
      case "ArrowRight": {
        const next = onRow ? buttons[0] : buttons[bi + 1];
        if (next) next.focus();
        else opts.onRightEnd?.(row);
        break;
      }
      case "ArrowLeft": {
        if (onRow) opts.onLeft?.(row);
        else if (bi <= 0) focusStop(row);
        else buttons[bi - 1].focus();
        break;
      }
      case "Enter":
      case " ": {
        if (!onRow) return; // ボタンの上なら、ボタン自身の click に任せる
        opts.onEnter?.(row);
        break;
      }
      case "Escape": {
        if (!onRow) focusStop(row);
        else if (!opts.onEscape?.(row)) row.blur();
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
}

/* ---- 縦の並び (↑ ↓) ---- */

/**
 * 画面を縦の「列」に分け、それぞれの列で上から順に止まれる場所を
 * selector で並べておく。↑ ↓ は今いる場所の前後へ移る。行の中の
 * ボタンにいるときも、その行を今いる場所と見なす。
 */
export interface Column {
  /** この列に属するかの判定 (target がこの中にあれば) */
  within: string;
  /** 止まれる場所。document 順に並べる */
  stops: string;
  /** 一番下からさらに ↓ を押したときの行き先 (無ければ止まる) */
  belowEnd?: string;
}

export interface VerticalNavOptions {
  /** どこにも focus が無いときに矢印を押したら、まずここへ */
  first: string;
}

export function verticalNavHandler(columns: Column[], opts: VerticalNavOptions) {
  return (e: KeyLike) => {
    if (!e.key.startsWith("Arrow")) return;
    if (inEditor(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement;
    // どこにも止まっていなければ、まず一番上へ
    if (target === document.body || target === document.documentElement) {
      focusStop(document.querySelector<HTMLElement>(opts.first) ?? undefined);
      e.preventDefault();
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const col = columns.find((c) => target.closest(c.within)) ?? columns[columns.length - 1];
    const stops = Array.from(document.querySelectorAll<HTMLElement>(col.stops)).filter(usable);
    // 今いる場所 = target 自身か、target を含む一番内側の止まれる場所
    let i = -1;
    for (let k = stops.length - 1; k >= 0; k--) {
      if (stops[k] === target || stops[k].contains(target)) {
        i = k;
        break;
      }
    }
    if (i < 0) return;
    let next: HTMLElement | undefined = stops[e.key === "ArrowDown" ? i + 1 : i - 1];
    if (!next && e.key === "ArrowDown" && col.belowEnd) {
      next = document.querySelector<HTMLElement>(col.belowEnd) ?? undefined;
    }
    if (!next) return;
    focusStop(next);
    e.preventDefault();
    e.stopPropagation();
  };
}

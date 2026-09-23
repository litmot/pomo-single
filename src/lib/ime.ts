import { useRef } from "react";

/**
 * IME が変換中かどうかを自前で追う。
 *
 * `KeyboardEvent.isComposing` は当てにならない。Focus View (装飾なし・
 * 常時最前面の窓) では、日本語を確定した後の Enter でも true のままになる
 * ことがあり、その場合「Enter で次へ進む」が永久に動かない。
 *
 * `compositionstart` / `compositionend` は確実に届くので、こちらで持つ。
 * 変換を確定する Enter は composition の終了より先に keydown が来るため、
 * その 1 回は変換中として扱われ、次の Enter で進む。日本語入力では
 * 「1 回目で文字を確定、2 回目で次へ」が普通の運びなので、これで合う。
 */
export function useComposition() {
  const composing = useRef(false);
  return {
    /** keydown の中で参照する。true の間は確定キーを自分の用途に使わない */
    composing,
    /** 入力要素にそのまま展開する */
    handlers: {
      onCompositionStart: () => {
        composing.current = true;
      },
      onCompositionEnd: () => {
        composing.current = false;
      },
    },
  };
}

/**
 * 日付入力のカレンダーを開く。
 *
 * ユーザー操作の直後でないとブラウザに拒否される。弾かれても手入力は
 * できるので、失敗は無視してよい。
 */
/**
 * 直前の操作がマウスだったか。
 *
 * カレンダーが開いている間、矢印キーはブラウザのカレンダーが受け取って
 * しまい、ページ側には届かない。届くのは「日付が変わった」という同じ
 * change だけなので、押して選んだのか矢印で 1 日動かしたのかは、その
 * change からは見分けられない。見分けられるのは欄を開いた時点の操作で、
 * マウスで開いたならカレンダーも押して選ぶ、キーボードで開いたなら
 * 矢印で歩いて Enter で決める、と考えてよい。
 */
let pointerLast = true;
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", () => (pointerLast = true), true);
  window.addEventListener("keydown", () => (pointerLast = false), true);
}

export function lastInputWasPointer(): boolean {
  return pointerLast;
}

export function openPicker(el: HTMLInputElement | null) {
  if (!el) return;
  try {
    (el as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
  } catch {
    /* 手入力に任せる */
  }
}

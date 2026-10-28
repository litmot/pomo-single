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
export function openPicker(el: HTMLInputElement | null) {
  if (!el) return;
  try {
    (el as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
  } catch {
    /* 手入力に任せる */
  }
}

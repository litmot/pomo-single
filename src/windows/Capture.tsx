import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import * as ipc from "../lib/ipc";
import "../styles/app.css";
import "../styles/capture.css";

/** 送信アニメーションの尺。これを待ってからウィンドウを隠す */
const SEND_ANIM_MS = 340;
/** 何も書いていないときの高さ */
const BASE_HEIGHT = 76;

/**
 * Quick Capture — グローバルホットキーで呼び出される入力だけのウィンドウ。
 * 確認も分類もさせず Inbox へ落として即座に消え、直前のアプリへフォーカスを返す。
 *
 * 依頼のメールやチャットを貼り付ける用途があるので複数行を受ける。
 * Enter は送信、改行は Shift+Enter。貼り付けた改行はそのまま残る。
 */
export default function Capture() {
  const [value, setValue] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "reject">("idle");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const busy = useRef(false);

  // ウィンドウは破棄せず hide/show で使い回すので、表示ごとに状態を初期化する
  useEffect(() => {
    const w = getCurrentWindow();
    const reset = () => {
      busy.current = false;
      setValue("");
      setState("idle");
      requestAnimationFrame(() => inputRef.current?.focus());
    };
    reset();
    const unlisten = w.onFocusChanged(({ payload: focused }) => {
      if (focused) reset();
      else if (!busy.current) void ipc.hideCapture(); // 取りこぼし防止: フォーカスを失ったら閉じる
    });
    return () => void unlisten.then((f) => f());
  }, []);

  // 行が増えたら窓も伸ばす。書いている内容が見えないまま Enter は押させない
  useLayoutEffect(() => {
    const input = inputRef.current;
    const shell = shellRef.current;
    if (!input || !shell) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
    void ipc.resizeCapture(Math.max(BASE_HEIGHT, Math.round(shell.scrollHeight) + 2));
  }, [value]);

  const submit = async () => {
    const title = value.trim();
    if (busy.current) return;
    if (!title) {
      setState("reject");
      window.setTimeout(() => setState("idle"), 240);
      return;
    }
    busy.current = true;
    setState("sending");
    await ipc.quickCapture(title);
    window.setTimeout(() => void ipc.hideCapture(), SEND_ANIM_MS);
  };

  return (
    <div className={`capture-shell${state === "idle" ? "" : ` ${state}`}`} ref={shellRef}>
      <div className="capture-mark" />
      <textarea
        ref={inputRef}
        className="capture-input"
        rows={1}
        value={value}
        placeholder="書いて Enter"
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            void ipc.hideCapture();
          }
        }}
      />
      <div className="capture-hint">
        {value.includes("\n") || value.length > 40 ? "Shift+Enter で改行" : "一時メモへ"}
      </div>
    </div>
  );
}

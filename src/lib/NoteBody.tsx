import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type MutableRefObject,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from "react";
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

/** 本文の中でリンクが占める範囲 */
export interface LinkSpan extends NoteLink {
  start: number;
  end: number;
}

/** 囲んでいないパスから、張り付いた助詞と句読点を落とす */
function cleanPath(raw: string, quoted: boolean): string {
  // 囲んでいないパスは、文の続き (「〜です」「〜に」) が張り付きやすい。
  // 末尾のひらがなは助詞と見なして落とす。ひらがなだけのフォルダ名は
  // まず無く、あれば引用符で囲めばよい
  const p = quoted ? raw : raw.replace(/[ぁ-ゖ]+$/, "");
  return p.replace(/[.,、。)]+$/, "");
}

/** 本文の中の URL とパスを、位置つきで出てきた順に */
export function linkSpans(text: string): LinkSpan[] {
  const spans: LinkSpan[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    spans.push({ kind: "url", target: m[0], label: m[0], start, end: start + m[0].length });
  }
  for (const m of text.matchAll(PATH_RE)) {
    const start = m.index ?? 0;
    const quoted = m[1] !== undefined;
    const target = cleanPath(m[1] ?? m[2] ?? "", quoted);
    if (!target) continue;
    // 色を付ける範囲は、引用符を含めた見た目どおりの範囲。
    // 囲んでいなければ、落とした助詞ぶんを縮める
    const end = quoted ? start + m[0].length : start + target.length;
    spans.push({ kind: "path", target, label: target, start, end });
  }
  spans.sort((a, b) => a.start - b.start);
  // URL の中にパスめいたものが混ざることはまず無いが、重なったら先のものを採る
  const out: LinkSpan[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) continue;
    out.push(s);
  }
  return out;
}

/** メモに含まれる URL を重複なく取り出す */
export function extractUrls(text: string): string[] {
  return Array.from(new Set(text.match(URL_RE) ?? []));
}

/** メモに含まれるパス (ローカル / ネットワーク) を重複なく取り出す */
export function extractPaths(text: string): string[] {
  const found = linkSpans(text)
    .filter((s) => s.kind === "path")
    .map((s) => s.target);
  return Array.from(new Set(found));
}

/** 本文の中の位置 `index` に掛かっているリンク。Ctrl+クリックで使う */
export function linkAt(text: string, index: number): NoteLink | null {
  return linkSpans(text).find((s) => index >= s.start && index <= s.end) ?? null;
}

/**
 * リンクを開く。`<a href>` は使わない。webview 内で遷移すると
 * アプリ自体が別のページに化けるため、URL は必ず既定のブラウザ、
 * パスはエクスプローラーで開く。失敗したら理由を返す
 */
export async function openLink(link: NoteLink): Promise<string | null> {
  try {
    await (link.kind === "url" ? ipc.openUrl(link.target) : ipc.openPath(link.target));
    return null;
  } catch (e) {
    // 黙って何も起きないのが一番困る。何が開けなかったかだけ返す
    return typeof e === "string" ? e : String(e);
  }
}

/** 本文を、リンクだけ色の付いた断片の並びにする */
function Pieces({ text, onOpen }: { text: string; onOpen?: (link: NoteLink) => void }) {
  const spans = linkSpans(text);
  const out: ReactNode[] = [];
  let cursor = 0;
  spans.forEach((s, i) => {
    if (s.start > cursor) out.push(text.slice(cursor, s.start));
    out.push(
      <span
        key={i}
        className={`lk-link is-${s.kind}`}
        title={onOpen ? (s.kind === "url" ? "ブラウザで開く" : "エクスプローラーで開く") : undefined}
        onClick={
          onOpen
            ? (e) => {
                e.stopPropagation();
                onOpen(s);
              }
            : undefined
        }
      >
        {text.slice(s.start, s.end)}
      </span>,
    );
    cursor = s.end;
  });
  if (cursor < text.length) out.push(text.slice(cursor));
  return <>{out}</>;
}

/**
 * 読むだけの本文に、リンクの色を付ける。リンクは押せば開く。
 * 一時メモの行で使う。
 */
export function LinkedText({ text, className }: { text: string; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <>
      <span className={className}>
        <Pieces text={text} onOpen={(l) => void openLink(l).then(setFailed)} />
      </span>
      {failed && <div className="note-link-error">開けませんでした — {failed}</div>}
    </>
  );
}

/**
 * 中のリンクに色が付く textarea。Ctrl+クリックかダブルクリックで開く。
 *
 * textarea は文字に色を付けられないので、同じ字送りの下敷きを後ろに敷き、
 * textarea 側の文字を透明にする。見えている文字は下敷きのもの、
 * 打っているのは textarea。字送り・余白・折り返しを textarea から
 * そのまま写して、ずれないようにしている。
 */
export function LinkedTextarea({
  value,
  areaRef,
  onOpenFailed,
  ...rest
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onClick" | "onMouseMove"> & {
  value: string;
  areaRef?: Ref<HTMLTextAreaElement>;
  /** Ctrl+クリックで開けなかったとき。省略すると下に赤字で出す */
  onOpenFailed?: (reason: string | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const setArea = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (typeof areaRef === "function") areaRef(el);
    else if (areaRef) (areaRef as MutableRefObject<HTMLTextAreaElement | null>).current = el;
  };

  /** textarea の寸法と字送りを下敷きに写す */
  const fit = () => {
    const ta = innerRef.current;
    const back = backRef.current;
    const wrap = wrapRef.current;
    if (!ta || !back || !wrap) return;
    const cs = getComputedStyle(ta);
    // 枠線の内側、スクロールバーを除いた領域にぴったり重ねる
    back.style.top = `${ta.offsetTop + ta.clientTop}px`;
    back.style.left = `${ta.offsetLeft + ta.clientLeft}px`;
    back.style.width = `${ta.clientWidth}px`;
    back.style.height = `${ta.clientHeight}px`;
    back.style.padding = cs.padding;
    back.style.font = cs.font;
    back.style.letterSpacing = cs.letterSpacing;
    back.style.lineHeight = cs.lineHeight;
    back.style.wordBreak = cs.wordBreak;
    back.style.tabSize = cs.tabSize;
    back.style.borderRadius = cs.borderRadius;
    // 地の色は下敷きの後ろ (枠線の内側まで) に敷く
    wrap.style.borderRadius = cs.borderRadius;
    back.scrollTop = ta.scrollTop;
  };

  useLayoutEffect(fit);
  useEffect(() => {
    const ta = innerRef.current;
    if (!ta) return;
    const ro = new ResizeObserver(fit);
    ro.observe(ta);
    return () => ro.disconnect();
  }, []);

  const report = (reason: string | null) => {
    if (onOpenFailed) onOpenFailed(reason);
    else setFailed(reason);
  };

  /**
   * 画面上の点に掛かっているリンク。下敷きの色付き部分の矩形で当てる。
   * textarea の文字位置は点から引けないので、下敷きを物差しにする
   */
  const linkAtPoint = (x: number, y: number): NoteLink | null => {
    const back = backRef.current;
    if (!back) return null;
    const spans = linkSpans(value);
    const els = back.querySelectorAll<HTMLElement>(".lk-link");
    for (let i = 0; i < els.length; i++) {
      for (const r of els[i].getClientRects()) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return spans[i] ?? null;
      }
    }
    return null;
  };

  // Ctrl を押しながらリンクの上に来たら、指のカーソルにして押せると伝える。
  // Ctrl の押し放しはマウスが動かなくても起きるので、最後の位置を覚えておく
  const mouse = useRef({ x: 0, y: 0, inside: false });
  const updateCursor = (ctrl: boolean) => {
    const ta = innerRef.current;
    if (!ta) return;
    const m = mouse.current;
    ta.style.cursor = ctrl && m.inside && linkAtPoint(m.x, m.y) ? "pointer" : "";
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Control") updateCursor(e.type === "keydown");
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  });

  const openAt = (e: MouseEvent<HTMLTextAreaElement>) => {
    const link =
      linkAtPoint(e.clientX, e.clientY) ?? linkAt(e.currentTarget.value, e.currentTarget.selectionStart);
    if (link) void openLink(link).then(report);
    return link !== null;
  };

  return (
    <div className="lk-wrap" ref={wrapRef}>
      <div className="lk-back" ref={backRef} aria-hidden>
        {/* 末尾の改行は div だと行にならないので、幅ゼロの文字で行を作る */}
        <Pieces text={value} />
        {"\u200b"}
      </div>
      <textarea
        {...rest}
        ref={setArea}
        className={`lk-area ${rest.className ?? ""}`}
        value={value}
        onScroll={fit}
        // 本文の中の URL やパスは Ctrl+クリックか、ダブルクリックで開く
        onClick={(e: MouseEvent<HTMLTextAreaElement>) => {
          if (e.ctrlKey) openAt(e);
        }}
        onDoubleClick={(e: MouseEvent<HTMLTextAreaElement>) => {
          if (openAt(e)) e.stopPropagation();
          rest.onDoubleClick?.(e);
        }}
        onMouseMove={(e: MouseEvent<HTMLTextAreaElement>) => {
          mouse.current = { x: e.clientX, y: e.clientY, inside: true };
          updateCursor(e.ctrlKey);
        }}
        onMouseLeave={(e: MouseEvent<HTMLTextAreaElement>) => {
          mouse.current.inside = false;
          updateCursor(false);
          rest.onMouseLeave?.(e);
        }}
      />
      {failed && <div className="note-link-error">開けませんでした — {failed}</div>}
    </div>
  );
}

/** メモの 1 行目だけを、一覧に添える短い手掛かりとして返す */
export function noteSummary(note: string, max = 60): string {
  const line = note.split("\n").find((l) => l.trim().length > 0) ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

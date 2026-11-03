import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { LinkedTextarea, openLink, Pieces, type NoteLink } from "./NoteBody";
import { useComposition } from "./ime";
import {
  continueListEdit,
  lineEndOffset,
  listEdit,
  parseInline,
  parseLines,
  toggleCheck,
  wrapEdit,
  type Edit,
  type Inline,
} from "./noteMarks";

/** 本文を書き換える。ブラウザの入力として行い、欄の中の Ctrl+Z で戻せるようにする */
export function applyEdit(ta: HTMLTextAreaElement, e: Edit, onChange: (value: string) => void) {
  ta.focus();
  ta.setSelectionRange(e.from, e.to);
  const ok =
    e.text === "" && e.from !== e.to
      ? document.execCommand("delete")
      : document.execCommand("insertText", false, e.text);
  if (!ok) {
    onChange(ta.value.slice(0, e.from) + e.text + ta.value.slice(e.to));
    requestAnimationFrame(() => ta.setSelectionRange(e.selStart, e.selEnd));
    return;
  }
  ta.setSelectionRange(e.selStart, e.selEnd);
}

/** 本文と選択から、書き換えを作る */
export type MakeEdit = (value: string, start: number, end: number) => Edit;

const wrapWith =
  (mark: string): MakeEdit =>
  (v, a, b) =>
    wrapEdit(v, a, b, mark);
const listOf =
  (kind: "bullet" | "check"): MakeEdit =>
  (v, a, b) =>
    listEdit(v, a, b, kind);

/** 書式のボタン。タスクのメモと一時メモで同じものを並べる */
const FORMAT_TOOLS: { id: string; face: ReactNode; title: string; make: MakeEdit }[] = [
  { id: "b", face: <b>B</b>, title: "太字 (Ctrl+B)", make: wrapWith("**") },
  { id: "i", face: <i>I</i>, title: "斜体 (Ctrl+I)", make: wrapWith("*") },
  { id: "s", face: <span className="rn-s">S</span>, title: "取り消し線 (Ctrl+-)", make: wrapWith("~~") },
  { id: "ul", face: "•", title: "箇条書き", make: listOf("bullet") },
  { id: "check", face: "☑", title: "チェック付きの箇条書き", make: listOf("check") },
];

/** 書式のキー (Ctrl+B / Ctrl+I / Ctrl+-)。当たらなければ null */
export function formatKey(e: KeyboardEvent): MakeEdit | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null;
  const key = e.key.toLowerCase();
  if (key === "b") return wrapWith("**");
  if (key === "i") return wrapWith("*");
  if (key === "-") return wrapWith("~~");
  return null;
}

/**
 * 書式のボタンの帯。押しても入力欄から focus を奪わない (選んだ範囲が
 * 消えないように。欄の blur で確定してしまわないように)
 */
export function FormatBar({ onRun, barRef }: { onRun: (make: MakeEdit) => void; barRef?: Ref<HTMLDivElement> }) {
  return (
    <div className="rn-tools" ref={barRef}>
      {FORMAT_TOOLS.map((t) => (
        <button
          key={t.id}
          type="button"
          tabIndex={-1}
          title={t.title}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onRun(t.make)}
        >
          {t.face}
        </button>
      ))}
    </div>
  );
}

/**
 * 装飾を付けて読む形で並べる。行ごとに、箇条書き・チェック・ふつうの行。
 * onToggle を渡せばチェックを押せる (渡さなければ押せない印だけ)
 */
export function MarkedLines({
  value,
  onOpen,
  onToggle,
}: {
  value: string;
  onOpen?: (link: NoteLink) => void;
  onToggle?: (index: number) => void;
}) {
  const lines = useMemo(() => parseLines(value), [value]);
  const inline = (xs: Inline[], key = ""): ReactNode =>
    xs.map((x, i) => {
      const k = `${key}${i}`;
      if (x.t === "text") return <Pieces key={k} text={x.s} onOpen={onOpen} />;
      const inner = inline(x.c, `${k}-`);
      if (x.t === "b") return <strong key={k}>{inner}</strong>;
      if (x.t === "i") return <em key={k}>{inner}</em>;
      return (
        <span key={k} className="rn-s">
          {inner}
        </span>
      );
    });
  return (
    <>
      {lines.map((l) => {
        if (l.kind === "text") {
          return (
            <div key={l.index} className="rn-line" data-line={l.index}>
              {l.content ? inline(parseInline(l.content)) : "\u200b"}
            </div>
          );
        }
        return (
          <div
            key={l.index}
            className={`rn-li is-${l.kind}`}
            data-line={l.index}
            style={{ paddingLeft: `${l.indent * 1.3}em` }}
          >
            {l.kind === "check" ? (
              <input
                type="checkbox"
                className="rn-box"
                checked={l.checked}
                disabled={!onToggle}
                tabIndex={-1}
                onChange={() => onToggle?.(l.index)}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="rn-dot">•</span>
            )}
            <span className={`rn-c${l.kind === "check" && l.checked ? " is-done" : ""}`}>
              {l.content ? inline(parseInline(l.content)) : "\u200b"}
            </span>
          </div>
        );
      })}
    </>
  );
}

/**
 * 装飾できるメモ。読むときは装飾を付けて見せ、本文を押すと記号のまま
 * 書ける入力欄に替わる (欄を離れると読む形に戻る)。
 *
 * - チェックボックスは読む形のまま押せる。押した時点で保存する
 * - URL やパスは読む形では押せば開く (書くときは今までどおり Ctrl+クリック)
 * - 上の小さなボタンと Ctrl+B / Ctrl+I / Ctrl+- で記号を付け外しする。
 *   複数行を選んだときは行ごとに付ける。書いている途中も装飾が見える (記号は薄く)。
 *   付け外しはブラウザの入力として行うので、欄の中の Ctrl+Z で戻せる
 * - 箇条書き・チェックの行で Enter を押すと、次の行にも頭が付く
 *
 * 書く形と読む形で枠の大きさを揃え、切り替えても窓や行の高さが跳ねない
 * ようにしてある (同じ className を両方に当てる)。
 */
export function RichNote({
  value,
  onChange,
  onCommit,
  onEscape,
  className,
  placeholder,
  startEditing,
  autoFocus,
  grow,
}: {
  value: string;
  onChange: (value: string) => void;
  /** 書き終えた (欄を離れた) / チェックを付け外しした。その時点の本文で保存する */
  onCommit: (value: string) => void;
  /** Esc を押した (書いている途中でも、読む形でも) */
  onEscape?: (value: string) => void;
  /** 本文の枠 (読む形と書く形の両方) に当てる */
  className?: string;
  placeholder?: string;
  /** 書く形で始める (空のメモを開いたとき) */
  startEditing?: boolean;
  autoFocus?: boolean;
  /**
   * 書く形の欄を中身の高さまで伸ばす (上限は CSS の max-height)。読む形と
   * 同じ高さになるので、押して書く形に替えても枠の高さが跳ねない。
   * 高さを固定している所 (Focus View) では使わない
   */
  grow?: boolean;
}) {
  const [editing, setEditing] = useState(Boolean(startEditing));
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  /** 書く形に替わった直後に行うこと (カーソルを置く・記号を付ける) */
  const pending = useRef<((ta: HTMLTextAreaElement) => void) | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const ime = useComposition();

  useEffect(() => {
    if (!editing) return;
    const ta = areaRef.current;
    if (!ta) return;
    ta.focus();
    const run = pending.current;
    pending.current = null;
    run?.(ta);
  }, [editing]);

  useLayoutEffect(() => {
    const ta = areaRef.current;
    if (!grow || !editing || !ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight + ta.offsetHeight - ta.clientHeight}px`;
  }, [grow, editing, value]);

  useEffect(() => {
    if (autoFocus && !startEditing) viewRef.current?.focus();
    // 開いたときに 1 回だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 書く形にして、then を行う。もう書く形なら、その場で行う */
  const edit = (then?: (ta: HTMLTextAreaElement) => void) => {
    if (editing && areaRef.current) {
      areaRef.current.focus();
      then?.(areaRef.current);
      return;
    }
    pending.current = then ?? ((ta) => ta.setSelectionRange(ta.value.length, ta.value.length));
    setEditing(true);
  };

  const apply = (ta: HTMLTextAreaElement, e: Edit) => applyEdit(ta, e, onChange);
  const run = (make: MakeEdit) => (ta: HTMLTextAreaElement) =>
    apply(ta, make(ta.value, ta.selectionStart, ta.selectionEnd));

  const lines = useMemo(() => parseLines(value), [value]);
  const open = (l: NoteLink) => void openLink(l).then(setFailed);

  const toggle = (index: number) => {
    const next = toggleCheck(value, index);
    onChange(next);
    onCommit(next);
  };

  const view = (
    <div
      ref={viewRef}
      className={`rn-view ${className ?? ""}`}
      tabIndex={0}
      onClick={(e) => {
        const el = e.target as HTMLElement;
        if (el.closest(".rn-box, .lk-link")) return;
        // 文字を選んでコピーしようとしているときは、書く形に替えない
        if (window.getSelection()?.toString()) return;
        const row = el.closest<HTMLElement>("[data-line]");
        const index = row ? Number(row.dataset.line) : lines.length - 1;
        edit((ta) => {
          const p = lineEndOffset(ta.value, index);
          ta.setSelectionRange(p, p);
        });
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          edit();
        } else if (e.key === "Escape" && onEscape) {
          e.preventDefault();
          e.stopPropagation();
          onEscape(value);
        }
      }}
    >
      {!value.trim() ? (
        <span className="rn-placeholder">{placeholder}</span>
      ) : (
        <MarkedLines value={value} onOpen={open} onToggle={toggle} />
      )}
    </div>
  );

  return (
    <div className="rn">
      <FormatBar
        barRef={toolsRef}
        onRun={(make) =>
          edit((ta) => {
            // 読む形から押したときは、末尾に付ける
            if (!editing) ta.setSelectionRange(ta.value.length, ta.value.length);
            run(make)(ta);
          })
        }
      />
      {editing ? (
        <LinkedTextarea
          areaRef={(el) => {
            areaRef.current = el;
          }}
          className={className}
          value={value}
          marks
          spellCheck={false}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          {...ime.handlers}
          onBlur={(e) => {
            if (toolsRef.current?.contains(e.relatedTarget as Node | null)) return;
            onCommit(e.currentTarget.value);
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (ime.composing.current || e.nativeEvent.isComposing) return;
            const ta = e.currentTarget;
            const make = formatKey(e);
            if (make) {
              e.preventDefault();
              run(make)(ta);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && ta.selectionStart === ta.selectionEnd) {
              const next = continueListEdit(ta.value, ta.selectionStart);
              if (next) {
                e.preventDefault();
                apply(ta, next);
              }
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              const v = ta.value;
              onCommit(v);
              setEditing(false);
              onEscape?.(v);
            }
          }}
        />
      ) : (
        view
      )}
      {failed && <div className="note-link-error">開けませんでした — {failed}</div>}
    </div>
  );
}

/**
 * メモの装飾。
 *
 * 本文はただの文字のまま持ち、装飾は記号で書く (Markdown の一部):
 *   **太字**  *斜体*  ~~取り消し線~~ (二重線で見せる)
 *   - 箇条書き   - [ ] チェック付き   - [x] 済んだもの
 * 行頭の空白 2 つで 1 段下げる。
 *
 * 読むときは記号を外して装飾を付け、書くときは記号のまま書く。
 * 文字のまま持つので、今までのメモも、一覧の要約や一時メモへの戻しも
 * そのまま使える。ここは解釈と、書くときの補助 (記号の付け外し・
 * 箇条書きの続き) だけを受け持つ。画面は RichNote.tsx。
 */

export type Inline =
  | { t: "text"; s: string }
  | { t: "b" | "i" | "s"; c: Inline[] };

export type Line =
  | { kind: "text"; index: number; indent: number; content: string }
  | { kind: "bullet"; index: number; indent: number; content: string }
  | { kind: "check"; index: number; indent: number; content: string; checked: boolean };

const CHECK_RE = /^(\s*)- \[([ xX])\] ?(.*)$/;
const BULLET_RE = /^(\s*)- (.*)$/;

/** 行頭の空白から段を数える (空白 2 つ、またはタブ 1 つで 1 段) */
function depth(space: string): number {
  return Math.floor(space.replace(/\t/g, "  ").length / 2);
}

/** 1 行ずつ、箇条書き・チェック・ふつうの行に分ける */
export function parseLines(text: string): Line[] {
  return text.split("\n").map((raw, index) => {
    const c = CHECK_RE.exec(raw);
    if (c) return { kind: "check", index, indent: depth(c[1]), content: c[3], checked: c[2] !== " " };
    const b = BULLET_RE.exec(raw);
    if (b) return { kind: "bullet", index, indent: depth(b[1]), content: b[2] };
    return { kind: "text", index, indent: 0, content: raw };
  });
}

/**
 * 行の中の装飾を読む。** と ~~ は対になっていれば効く。* は対で、
 * 内側の端が空白でないときだけ (「a * b * c」のような掛け算を斜体にしない)。
 * 対にならない記号は、そのまま文字として残す
 */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", s: buf });
    buf = "";
  };
  let i = 0;
  while (i < s.length) {
    const pair = s.startsWith("**", i) ? "**" : s.startsWith("~~", i) ? "~~" : null;
    if (pair) {
      const close = s.indexOf(pair, i + 2);
      if (close > i + 2) {
        flush();
        out.push({ t: pair === "**" ? "b" : "s", c: parseInline(s.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    } else if (s[i] === "*" && s[i + 1] && s[i + 1] !== " ") {
      let close = -1;
      for (let j = i + 2; j < s.length; j++) {
        if (s[j] === "*" && s[j + 1] !== "*" && s[j - 1] !== "*" && s[j - 1] !== " ") {
          close = j;
          break;
        }
      }
      if (close > 0) {
        flush();
        out.push({ t: "i", c: parseInline(s.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }
    buf += s[i];
    i++;
  }
  flush();
  return out;
}

/** 装飾を外した文字だけ */
export function plainInline(s: string): string {
  const walk = (xs: Inline[]): string => xs.map((x) => (x.t === "text" ? x.s : walk(x.c))).join("");
  return walk(parseInline(s));
}

/** 1 行を記号なしの文字にする。箇条書きは「・」、チェックは ☐ / ☑ を頭に */
export function plainLine(raw: string): string {
  const [line] = parseLines(raw);
  const body = plainInline(line.content);
  if (line.kind === "bullet") return `・${body}`;
  if (line.kind === "check") return `${line.checked ? "☑" : "☐"} ${body}`;
  return body;
}

/** その行のチェックを付け外しした本文 */
export function toggleCheck(text: string, index: number): string {
  const lines = text.split("\n");
  const m = CHECK_RE.exec(lines[index] ?? "");
  if (!m) return text;
  lines[index] = lines[index].replace(/- \[([ xX])\]/, (_, c: string) => (c === " " ? "- [x]" : "- [ ]"));
  return lines.join("\n");
}

/** その行の終わりの位置 (本文の中の文字数)。読む画面で押した行の末尾にカーソルを置く */
export function lineEndOffset(text: string, index: number): number {
  const lines = text.split("\n");
  let pos = 0;
  for (let i = 0; i < Math.min(index, lines.length - 1); i++) pos += lines[i].length + 1;
  return pos + (lines[Math.min(index, lines.length - 1)]?.length ?? 0);
}

/* ---- 書くときの補助 ---- */

/** 本文の [from, to) を text に置き換え、選択を [selStart, selEnd) にする */
export interface Edit {
  from: number;
  to: number;
  text: string;
  selStart: number;
  selEnd: number;
}

/**
 * 選んだ文字を記号で囲む。もう囲んであれば外す。何も選んでいなければ
 * 記号を 2 つ置いて、その間にカーソルを置く
 */
export function wrapEdit(value: string, start: number, end: number, mark: string): Edit {
  const m = mark.length;
  const inner = value.slice(start, end);
  // 選んだ範囲のすぐ外側が記号なら外す
  if (start >= m && value.slice(start - m, start) === mark && value.slice(end, end + m) === mark) {
    return { from: start - m, to: end + m, text: inner, selStart: start - m, selEnd: end - m };
  }
  // 記号ごと選んでいれば外す
  if (inner.length >= m * 2 && inner.startsWith(mark) && inner.endsWith(mark)) {
    const body = inner.slice(m, inner.length - m);
    return { from: start, to: end, text: body, selStart: start, selEnd: start + body.length };
  }
  return { from: start, to: end, text: mark + inner + mark, selStart: start + m, selEnd: end + m };
}

function lineStart(value: string, pos: number): number {
  return value.lastIndexOf("\n", pos - 1) + 1;
}

function lineEnd(value: string, pos: number): number {
  const i = value.indexOf("\n", pos);
  return i < 0 ? value.length : i;
}

/**
 * 箇条書き・チェックの行で Enter を押したとき。次の行にも同じ頭を付ける
 * (チェックは済んでいても「- [ ] 」で始める)。頭だけで中身が空の行なら、
 * 頭を外してリストを抜ける。リストの行でなければ null (ふつうの改行)
 */
export function continueListEdit(value: string, caret: number): Edit | null {
  const ls = lineStart(value, caret);
  const le = lineEnd(value, caret);
  const line = value.slice(ls, le);
  const c = CHECK_RE.exec(line);
  const b = c ? null : BULLET_RE.exec(line);
  if (!c && !b) return null;
  const space = (c ?? b)![1];
  const content = c ? c[3] : b![2];
  if (!content.trim()) {
    return { from: ls, to: le, text: "", selStart: ls, selEnd: ls };
  }
  // 頭の途中で Enter を押したときは、ふつうの改行にする
  const head = line.length - content.length;
  if (caret - ls < head) return null;
  const next = `\n${space}${c ? "- [ ] " : "- "}`;
  return { from: caret, to: caret, text: next, selStart: caret + next.length, selEnd: caret + next.length };
}

/**
 * 選んだ行 (カーソルの行) を箇条書き / チェックにする。全部がもうその形
 * なら外す。別の形 (箇条書き ⇄ チェック) なら付け替える
 */
export function listEdit(value: string, start: number, end: number, kind: "bullet" | "check"): Edit {
  const from = lineStart(value, start);
  const to = lineEnd(value, Math.max(start, end - (end > start && value[end - 1] === "\n" ? 1 : 0)));
  const lines = value.slice(from, to).split("\n");
  const isKind = (l: string) => (kind === "check" ? CHECK_RE.test(l) : !CHECK_RE.test(l) && BULLET_RE.test(l));
  const all = lines.every((l) => !l.trim() || isKind(l));
  const out = lines.map((l) => {
    if (!l.trim()) return l;
    const c = CHECK_RE.exec(l);
    const b = c ? null : BULLET_RE.exec(l);
    const space = c ? c[1] : b ? b[1] : (/^\s*/.exec(l)?.[0] ?? "");
    const body = c ? c[3] : b ? b[2] : l.slice(space.length);
    if (all) return space + body;
    return space + (kind === "check" ? "- [ ] " : "- ") + body;
  });
  const text = out.join("\n");
  // 1 行だけなら、カーソルは行末に。複数行なら全体を選んだまま
  const single = lines.length === 1;
  return {
    from,
    to,
    text,
    selStart: single ? from + text.length : from,
    selEnd: from + text.length,
  };
}

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

const pad = (v: number) => String(v).padStart(2, "0");

/** "2026-10-29" を、その日の 0 時 (ローカル) に */
function parse(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

function fmt(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function today(): string {
  return fmt(new Date());
}

/** n 日ずらす。空なら今日から */
export function addDays(iso: string, n: number): string {
  const d = parse(iso) ?? parse(today())!;
  d.setDate(d.getDate() + n);
  return fmt(d);
}

/** n か月ずらす。月末を越える日は、その月の末日にそろえる (1/31 → 2/28) */
export function addMonths(iso: string, n: number): string {
  const d = parse(iso) ?? parse(today())!;
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return fmt(d);
}

/** その月を含む 6 週ぶん (42 日) の日付。日曜始まり */
export function monthGrid(year: number, month: number): string[] {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => fmt(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)));
}

/**
 * 日付欄の下に出すカレンダー。
 *
 * 標準のカレンダーは、月を送っただけでも選んでいる日を 1 か月ずらし、
 * 日を押したときと同じ change を送る。ページの側ではどちらの操作か
 * 見分けられないので、押したら確定する欄では月送りで閉じてしまう。
 * ここでは月送りは表示だけを変え、日を押したときだけ onChoose を呼ぶ。
 *
 * 押しても欄からフォーカスを外さない (mousedown を止める)。欄の blur で
 * 確定する作りのまま使える。行の一覧はスクロールし、行には切り取りも
 * かかるので、body の直下に窓に対して固定の位置で出す。下に入らなければ
 * 上に開く。
 */
export function Calendar({
  value,
  anchor,
  onChoose,
}: {
  /** 選んでいる日。空なら今日の月を出す */
  value: string;
  /** 位置を合わせる相手 (日付欄の箱) */
  anchor: React.RefObject<HTMLElement | null>;
  onChoose: (iso: string) => void;
}) {
  const shown = () => {
    const d = parse(value) ?? parse(today())!;
    return { year: d.getFullYear(), month: d.getMonth() };
  };
  const [view, setView] = useState(shown);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // 矢印や手入力で日が別の月へ移ったら、その月を出す
  useEffect(() => {
    setView(shown());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const el = ref.current;
      if (!a || !el) return;
      const h = el.offsetHeight;
      const w = el.offsetWidth;
      const below = a.bottom + 4;
      const top = below + h <= window.innerHeight - 4 ? below : Math.max(4, a.top - 4 - h);
      const left = Math.max(4, Math.min(a.left, window.innerWidth - w - 4));
      setPos({ left, top });
    };
    place();
    // 箱の ref は親の側で付くので、子のこの時点ではまだ無いことがある。次の描画で合わせ直す
    const raf = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  const step = (n: number) =>
    setView((v) => {
      const d = new Date(v.year, v.month + n, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });

  const now = today();
  const days = monthGrid(view.year, view.month);

  return createPortal(
    <div
      ref={ref}
      className="cal"
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
      // 欄のフォーカスを奪わない。奪うと blur で確定して閉じてしまう
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="cal-head">
        <span className="cal-title">
          {view.year}年{view.month + 1}月
        </span>
        <button type="button" tabIndex={-1} className="cal-nav" title="前の月" onClick={() => step(-1)}>
          ▲
        </button>
        <button type="button" tabIndex={-1} className="cal-nav" title="次の月" onClick={() => step(1)}>
          ▼
        </button>
      </div>
      <div className="cal-grid">
        {WEEKDAYS.map((w, i) => (
          <span key={w} className={`cal-wd${i === 0 ? " is-sun" : ""}`}>
            {w}
          </span>
        ))}
        {days.map((d) => {
          const out = Number(d.slice(5, 7)) - 1 !== view.month;
          const cls = ["cal-day", out && "is-out", d === now && "is-today", d === value && "is-on"]
            .filter(Boolean)
            .join(" ");
          return (
            <button key={d} type="button" tabIndex={-1} className={cls} onClick={() => onChoose(d)}>
              {Number(d.slice(8))}
            </button>
          );
        })}
      </div>
      <div className="cal-foot">
        <button type="button" tabIndex={-1} className="cal-today" onClick={() => onChoose(now)}>
          今日
        </button>
      </div>
    </div>,
    document.body,
  );
}

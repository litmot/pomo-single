import { useEffect, useMemo, useRef, useState } from "react";

/** 選択肢の刻み (分)。時と分が 1 つの並びで出るので、細かいと探す手間が増える */
const STEP_MINUTES = 15;
/** 選択肢を並べる範囲 (時間) */
const RANGE_HOURS = 10;

/**
 * 時刻の入力。次の予定と、会議・休憩の終わる時刻で使う。
 *
 * 標準の時刻ピッカーは `step` を無視して分を 1 分刻みで並べるので、
 * 選択肢は自前で出す。会議の時刻はたいてい 5 分の倍数で、1 分単位の
 * 選択肢は探す手間が増えるだけ。手入力は 1 分単位のまま通す。
 *
 * onChoose は、一覧から選んだときと、手入力のあと Enter を押したときに呼ぶ
 * (打っている途中の時刻では呼ばない)
 */
export function TimeInput({
  id,
  value,
  onPick,
  onChoose,
}: {
  id?: string;
  value: string;
  onPick: (time: string) => void;
  onChoose?: (time: string) => void;
}) {
  const [open, setOpen] = useState(false);
  /** キーボードで一覧を上下しているときの位置。-1 は未選択 */
  const [cursor, setCursor] = useState(-1);
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 上下した先が見える位置まで一覧を送る
  useEffect(() => {
    if (cursor < 0) return;
    listRef.current?.children[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 開くたびに今の時刻から作り直す。次の区切りから並べる
  const options = useMemo(() => {
    if (!open) return [];
    const at = new Date();
    at.setSeconds(0, 0);
    at.setMinutes(Math.ceil((at.getMinutes() + 1) / STEP_MINUTES) * STEP_MINUTES);
    const count = (RANGE_HOURS * 60) / STEP_MINUTES;
    return Array.from({ length: count }, () => {
      const label = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
      at.setMinutes(at.getMinutes() + STEP_MINUTES);
      return label;
    });
  }, [open]);

  return (
    <div className="time-box" ref={boxRef}>
      {/* 欄を押せば刻みの一覧が開く。そのまま打てば 1 分単位で入る */}
      <input
        id={id}
        type="time"
        value={value}
        title={`押すか Space で ${STEP_MINUTES} 分刻みの一覧 (手入力は 1 分単位)`}
        onChange={(e) => onPick(e.target.value)}
        onMouseDown={() => setOpen(true)}
        // 矢印は時刻の増減ではなく、画面の移動に使う。一覧が開いていれば
        // その中を上下し、Space で開く、Enter で決める
        data-arrow-nav=""
        onKeyDown={(e) => {
          if (e.key === " ") {
            e.preventDefault();
            setOpen(true);
            setCursor(-1);
            return;
          }
          if (!open || (e.key === "Enter" && cursor < 0)) {
            // 閉じているときの ↑ ↓ は画面の移動 (親に任せる)。時刻の増減はさせない
            if (e.key === "ArrowDown" || e.key === "ArrowUp") e.preventDefault();
            if (e.key === "Enter" && value && onChoose) {
              e.preventDefault();
              setOpen(false);
              onChoose(value);
            }
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            setCursor((c) => {
              const n = e.key === "ArrowDown" ? c + 1 : c - 1;
              return Math.max(0, Math.min(options.length - 1, n));
            });
          } else if (e.key === "Enter" && cursor >= 0) {
            e.preventDefault();
            onPick(options[cursor]);
            setOpen(false);
            onChoose?.(options[cursor]);
          }
        }}
      />
      {open && (
        <div className="time-list" ref={listRef}>
          {options.map((t, i) => (
            <button
              key={t}
              tabIndex={-1}
              className={`${t === value ? "is-on" : ""}${i === cursor ? " is-cursor" : ""}`}
              onClick={() => {
                onPick(t);
                setOpen(false);
                onChoose?.(t);
              }}
            >
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

import { useState } from "react";
import * as ipc from "./ipc";
import { TimeInput } from "./TimeInput";
import { AWAY_LABEL, type AwayKind, nextOccurrence } from "./types";

/** 長さの選択肢 (分)。休憩は会議より短いものが多い */
const LENGTHS: Record<AwayKind, { minutes: number; label: string }[]> = {
  meeting: [
    { minutes: 30, label: "30分" },
    { minutes: 60, label: "1時間" },
    { minutes: 90, label: "1時間半" },
    { minutes: 120, label: "2時間" },
  ],
  rest: [
    { minutes: 10, label: "10分" },
    { minutes: 15, label: "15分" },
    { minutes: 30, label: "30分" },
    { minutes: 45, label: "45分" },
  ],
};

/**
 * 会議か休憩かと、その長さを選んで始める。タイマーなしの知らせの窓と、
 * 管理画面の「次の予定」の横、小休止中の Focus View で使う。
 *
 * 長さで選んだときの終わる時刻は、5 分の区切りにそろう (Rust 側。基本は
 * 切り上げで、区切りを過ぎて 1 分半未満なら切り捨て)。
 *
 * 長さを押せばその場で始まる。終わる時刻は、次の予定と同じ欄で入れる。
 * 一覧から選べばその場で始まり、手で打ったときは「開始」(Enter でも)。
 * 過ぎた時刻なら翌日のことになるので、その場合は始めない
 */
export function AwayPicker({
  onStarted,
  initialKind = "meeting",
  inlineList,
  onLayout,
}: {
  onStarted?: () => void;
  /** 最初に選んでおく種類。小休止からなら休憩のほうが多い */
  initialKind?: AwayKind;
  /** 時刻の一覧を欄の下に並べる (Focus View) */
  inlineList?: boolean;
  /** 一覧の開け閉めで高さが変わった (窓を中身に合わせるとき) */
  onLayout?: () => void;
}) {
  const [kind, setKind] = useState<AwayKind>(initialKind);
  const [time, setTime] = useState("");
  const [error, setError] = useState<string | null>(null);

  const start = async (minutes: number | null, until: string | null) => {
    try {
      await ipc.awayStart(kind, minutes, until);
      setError(null);
      onStarted?.();
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  };

  const startUntil = (time: string) => {
    const at = nextOccurrence(time);
    if (!at) return;
    // 翌日に回るほど先 (= 過ぎた時刻を入れた) なら、打ち間違いとみなして始めない
    if (new Date(at).getTime() - Date.now() > 12 * 3_600_000) {
      setError("過ぎた時刻です");
      return;
    }
    void start(null, at);
  };

  return (
    <div className={`mt-pick is-${kind}`}>
      <div className="mt-kinds" role="tablist">
        {(["meeting", "rest"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            className={`mt-kind is-${k}${kind === k ? " is-on" : ""}`}
            onClick={() => setKind(k)}
          >
            {AWAY_LABEL[k]}
          </button>
        ))}
      </div>
      <div className="mt-lengths">
        {LENGTHS[kind].map((l) => (
          <button key={l.minutes} type="button" className="mt-len" onClick={() => void start(l.minutes, null)}>
            {l.label}
          </button>
        ))}
      </div>
      <div className="mt-until">
        <TimeInput value={time} onPick={setTime} onChoose={startUntil} inline={inlineList} onOpenChange={() => onLayout && requestAnimationFrame(onLayout)} />
        <span className="mt-until-label">まで</span>
        <button type="button" className="mt-len" disabled={!time} onClick={() => startUntil(time)}>
          開始
        </button>
      </div>
      {error && <div className="mt-error">{error}</div>}
    </div>
  );
}

/** 終わる時刻の表示 ("14:30") */
export function clockOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

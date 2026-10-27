import { useState } from "react";
import * as ipc from "./ipc";
import { nextOccurrence } from "./types";

/** 会議の長さの選択肢 (分) */
const LENGTHS: { minutes: number; label: string }[] = [
  { minutes: 30, label: "30分" },
  { minutes: 60, label: "1時間" },
  { minutes: 90, label: "1時間半" },
  { minutes: 120, label: "2時間" },
];

/**
 * 会議の長さを選んで「会議中」にする。タイマーなしの知らせの窓と、
 * 管理画面の「次の予定」の横で使う。
 *
 * 長さを押せばその場で始まる。終わる時刻を入れたいときは右の欄に打って
 * 「開始」(Enter でも)。過ぎた時刻なら翌日のことになるので、その場合は始めない
 */
export function MeetingPicker({ onStarted }: { onStarted?: () => void }) {
  const [time, setTime] = useState("");
  const [error, setError] = useState<string | null>(null);

  const start = async (minutes: number | null, until: string | null) => {
    try {
      await ipc.meetingStart(minutes, until);
      setError(null);
      onStarted?.();
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  };

  const startUntil = () => {
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
    <div className="mt-pick">
      <div className="mt-lengths">
        {LENGTHS.map((l) => (
          <button key={l.minutes} type="button" className="mt-len" onClick={() => void start(l.minutes, null)}>
            {l.label}
          </button>
        ))}
      </div>
      <div className="mt-until">
        <input
          type="time"
          value={time}
          aria-label="終わる時刻"
          title="終わる時刻を指定"
          onChange={(e) => setTime(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && time) {
              e.preventDefault();
              startUntil();
            }
          }}
        />
        <span className="mt-until-label">まで</span>
        <button type="button" className="mt-len" disabled={!time} onClick={startUntil}>
          開始
        </button>
      </div>
      {error && <div className="mt-error">{error}</div>}
    </div>
  );
}

/** 会議の終わる時刻の表示 ("14:30") */
export function clockOf(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

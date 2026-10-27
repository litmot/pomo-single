import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import * as ipc from "../lib/ipc";
import { clockOf } from "../lib/MeetingPicker";
import { EV } from "../lib/types";
import "../styles/app.css";
import "../styles/meeting.css";

/**
 * 会議中の小窓。画面の右下に 1 行だけ出しておく。
 *
 * 会議中だと目に見えるので、延長も早めの終了もここからすぐできる。
 * 会議中はタイマーなしの時間を数えず、終わったところ (時刻が来たか、
 * 「終了」を押したところ) から数え直す。入力は奪わない
 */
export default function Meeting() {
  const [until, setUntil] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const load = () => void ipc.meetingInfo().then(setUntil);
    load();
    const unlisten = listen(EV.meeting, load);
    // 残り分数を進める
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      window.clearInterval(id);
      void unlisten.then((f) => f());
    };
  }, []);

  const left = until ? Math.max(0, Math.ceil((new Date(until).getTime() - now) / 60_000)) : 0;

  return (
    <div className="mt">
      <span className="mt-dot" />
      <span className="mt-text">
        会議中{until && <> 〜{clockOf(until)}</>}
        {until && <small>（あと {left} 分）</small>}
      </span>
      <button className="mt-btn" title="15 分延ばす" onClick={() => void ipc.meetingExtend(15)}>
        ＋15分
      </button>
      <button className="mt-btn is-end" title="会議が終わった。ここからタイマーなしの時間を数え直す" onClick={() => void ipc.meetingEnd()}>
        終了
      </button>
    </div>
  );
}

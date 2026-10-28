import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Menu } from "@tauri-apps/api/menu";
import * as ipc from "../lib/ipc";
import { clockOf } from "../lib/AwayPicker";
import { AWAY_LABEL, EV } from "../lib/types";
import "../styles/app.css";
import "../styles/meeting.css";

/**
 * 会議中・休憩中の小窓。画面の右下に 1 行だけ出しておく。
 *
 * 会議中・休憩中だと目に見えるので、延長も早めの終了もここからすぐできる。
 * その間はタイマーなしの時間を数えず、終わったところ (時刻が来たか、
 * 「終了」を押したところ) から数え直す。入力は奪わない。
 * 点の色は、会議がポモドーロと同じ橙、休憩が小休止と同じ緑
 */
export default function Meeting() {
  const [info, setInfo] = useState<ipc.AwayInfo | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const load = () => void ipc.awayInfo().then(setInfo);
    load();
    const unlisten = listen(EV.away, load);
    // 残り分数を進める
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => {
      window.clearInterval(id);
      void unlisten.then((f) => f());
    };
  }, []);

  // 右クリックで「小窓を隠す」。小窓は 1 行しかないので、窓の外まで出せる OS のメニューを使う。
  // 隠したあとは、管理画面の「会議 / 休憩」から出し直せる
  const openMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    const menu = await Menu.new({
      items: [{ id: "hide", text: "小窓を隠す", action: () => void ipc.awayPill(false) }],
    });
    await menu.popup();
  };

  const kind = info?.kind ?? "meeting";
  const until = info?.until ?? null;
  const left = until ? Math.max(0, Math.ceil((new Date(until).getTime() - now) / 60_000)) : 0;

  return (
    <div className={`mt is-${kind}`} onContextMenu={(e) => void openMenu(e)}>
      <span className="mt-dot" />
      <span className="mt-text">
        {AWAY_LABEL[kind]}中{until && <> 〜{clockOf(until)}</>}
        {until && <small>（あと {left} 分）</small>}
      </span>
      <button className="mt-btn" title="15 分延ばす" onClick={() => void ipc.awayExtend(15)}>
        ＋15分
      </button>
      <button
        className="mt-btn is-end"
        title={`${AWAY_LABEL[kind]}が終わった。ここからタイマーなしの時間を数え直す`}
        onClick={() => void ipc.awayEnd()}
      >
        終了
      </button>
    </div>
  );
}

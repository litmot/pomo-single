import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import * as ipc from "../lib/ipc";
import { useComposition } from "../lib/ime";
import { EV } from "../lib/types";
import "../styles/app.css";
import "../styles/nudge.css";

/**
 * タイマーなしで作業していたときの知らせ。画面の右下に出る小さな窓。
 *
 * 責めずに、始めるまでの手数を減らすのが役目。選んでいるタスクがあれば
 * ボタン 1 つで集中に入れる。違うことをしていたなら、それを 1 行書けば
 * そのタスクで始まる。どちらで始めても、ここまでのタイマーなしの時間は
 * 記録に足される (ポモドーロには数えない)。
 */
export default function Nudge() {
  const [info, setInfo] = useState<ipc.NudgeInfo | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const ime = useComposition();

  const load = () => void ipc.nudgeInfo().then(setInfo);

  useEffect(() => {
    load();
    const unlisten = Promise.all([
      // 出るたびに中身を取り直し、書きかけを消す
      listen(EV.nudge, () => {
        setText("");
        setBusy(false);
        load();
      }),
      // 選んでいるタスクが変わったら、ボタンの名前も変える
      listen(EV.phase, load),
      listen(EV.tasksChanged, load),
    ]);
    // 経った分数を進める
    const id = window.setInterval(load, 30_000);
    return () => {
      window.clearInterval(id);
      void unlisten.then((fns) => fns.forEach((f) => f()));
    };
  }, []);

  // 中身の高さに窓を合わせる (下端を固定して上に伸びる)
  useLayoutEffect(() => {
    const el = shellRef.current;
    if (el) void ipc.resizeNudge(Math.ceil(el.getBoundingClientRect().height) + 2);
  }, [info]);

  const start = async (taskId: string | null, title: string | null) => {
    if (busy) return;
    setBusy(true);
    try {
      await ipc.nudgeStart(taskId, title);
    } finally {
      setBusy(false);
    }
  };

  const task = info?.currentTask ?? null;
  const minutes = info?.minutes ?? 0;

  return (
    <div className="nd" ref={shellRef}>
      <div className="nd-head">
        <span className="nd-mark" />
        <span className="nd-title">
          タイマーなしで <b>{minutes}</b> 分たちました
        </span>
        <button className="nd-x" title="閉じる (30 分は出しません)" onClick={() => void ipc.nudgeSnooze(false)}>
          ×
        </button>
      </div>

      {task ? (
        <button className="nd-go" disabled={busy} onClick={() => void start(task.id, null)} title={task.title}>
          <span className="nd-go-label">集中を開始</span>
          <span className="nd-go-task">{task.title}</span>
        </button>
      ) : (
        <div className="nd-none">選んでいるタスクはありません</div>
      )}

      <input
        className="nd-input"
        value={text}
        placeholder={task ? "別のことをしていたら、書いて Enter" : "今やっていることを書いて Enter"}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        {...ime.handlers}
        onKeyDown={(e) => {
          if (ime.composing.current) return;
          if (e.key === "Enter" && text.trim()) {
            e.preventDefault();
            void start(null, text.trim());
          } else if (e.key === "Escape") {
            e.preventDefault();
            void ipc.nudgeSnooze(false);
          }
        }}
      />

      <div className="nd-foot">
        <span className="nd-note">ここまでの {minutes} 分も記録に残ります</span>
        <span className="nd-sp" />
        <button className="nd-link" onClick={() => void ipc.nudgeOpenManage()}>
          一覧で選ぶ
        </button>
        <button className="nd-link" title="1 時間は出しません" onClick={() => void ipc.nudgeSnooze(true)}>
          会議中
        </button>
      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import * as ipc from "../lib/ipc";
import { NoteLinks } from "../lib/NoteBody";
import {
  EV,
  PHASE_LABEL,
  dueState,
  formatClock,
  formatDue,
  isBreak,
  type Settings,
  type Task,
  type TimerSnapshot,
} from "../lib/types";
import "../styles/app.css";
import "../styles/focus.css";

/**
 * Focus View — ポモドーロ実行中に常時最前面で表示する小型ウィンドウ。
 * 集中フェーズでは「今やること」1 件のみを描画し、Inbox に溜まった内容は
 * 意図的に一切見せない。休憩フェーズに入ると triage 表示へ切り替わる。
 */
export default function Focus() {
  const [snap, setSnap] = useState<TimerSnapshot | null>(null);
  const [task, setTask] = useState<Task | null>(null);
  const [nextSubtask, setNextSubtask] = useState<Task | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [inbox, setInbox] = useState(0);
  const [pulse, setPulse] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const pulseTimer = useRef<number | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  /** 最後に描画を頼まれたタスク。取得の応答が前後しても取り違えないための番号札 */
  const wantedTaskId = useRef<string | null>(null);
  /** 最新のスナップショット。イベントハンドラから同期的に読むために持つ */
  const snapRef = useRef<TimerSnapshot | null>(null);

  const refreshTask = useCallback(async (taskId: string | null) => {
    wantedTaskId.current = taskId;
    if (!taskId) {
      setTask(null);
      setNextSubtask(null);
      return;
    }
    const all = await ipc.listTasks(["todo", "doing", "done"]);
    // 引き継ぎ時は tasks://changed と timer://phase が続けて飛ぶ。
    // 古い ID での応答が後から届いて新しい表示を上書きするのを防ぐ。
    if (wantedTaskId.current !== taskId) return;
    setTask(all.find((t) => t.id === taskId) ?? null);
    // サブタスクは「次の 1 件」だけ添える。残りは見せない
    setNextSubtask(all.find((t) => t.parentId === taskId && t.status !== "done") ?? null);
  }, []);

  const applySnap = useCallback((s: TimerSnapshot) => {
    snapRef.current = s;
    setSnap(s);
  }, []);

  useEffect(() => {
    void (async () => {
      const [s, st, n] = await Promise.all([
        ipc.timerState(),
        ipc.getSettings(),
        ipc.inboxCount(),
      ]);
      applySnap(s);
      setSettings(st);
      setInbox(n);
      await refreshTask(s.currentTaskId);
    })();
  }, [refreshTask, applySnap]);

  // タイマーの権威は Rust 側。ここは受信して描画するだけ
  useEffect(() => {
    const unlisten = Promise.all([
      listen<TimerSnapshot>(EV.tick, (e) => applySnap(e.payload)),
      listen<TimerSnapshot>(EV.phase, (e) => {
        applySnap(e.payload);
        void refreshTask(e.payload.currentTaskId);
        void ipc.inboxCount().then(setInbox);
      }),
      listen(EV.inboxAdded, () => {
        setInbox((n) => n + 1);
        setPulse(true);
        if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
        pulseTimer.current = window.setTimeout(() => setPulse(false), 640);
      }),
      listen(EV.settingsChanged, () => void ipc.getSettings().then(setSettings)),
      listen(EV.tasksChanged, () => {
        void ipc.inboxCount().then(setInbox);
        void refreshTask(snapRef.current?.currentTaskId ?? null);
      }),
    ]);
    return () => {
      void unlisten.then((fns) => fns.forEach((f) => f()));
      if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
    };
  }, [refreshTask, applySnap]);

  /** 中身の高さをウィンドウに反映する */
  const fitWindow = useCallback(() => {
    const el = shellRef.current;
    if (!el) return;
    const height = Math.round(el.getBoundingClientRect().height);
    if (height > 0) void ipc.resizeFocus(height);
  }, []);

  // 表示する中身は状況で変わる (1 行 / triage / 3 択 / 候補 / メモ)。
  // 高さを決め打ちにすると必ずどこかで見切れるので、中身の高さに追従させる。
  //
  // 監視だけに頼らないのは、ウィンドウが隠れている間は WebView2 が
  // レイアウトを走らせず ResizeObserver が発火しないため。表示や切り替えの
  // たびに明示的にも測る。
  useEffect(() => {
    const el = shellRef.current;
    if (!el) return;
    let last = 0;
    const observer = new ResizeObserver(() => {
      const height = Math.round(el.getBoundingClientRect().height);
      if (height > 0 && Math.abs(height - last) > 1) {
        last = height;
        void ipc.resizeFocus(height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // フェーズが変わったらメモは畳む。次の仕事に持ち越さない
  useEffect(() => {
    setNoteOpen(false);
  }, [snap?.phase, snap?.currentTaskId]);

  // 表示する中身が切り替わった直後に、描画を待ってから測る
  useEffect(() => {
    const id = requestAnimationFrame(fitWindow);
    return () => cancelAnimationFrame(id);
  }, [fitWindow, noteOpen, snap?.phase, snap?.awaitingChoice, snap?.reviewing, task?.id]);

  if (!snap) return null;

  const breaking = isBreak(snap.phase);
  const progress = snap.totalMs > 0 ? 1 - snap.remainingMs / snap.totalMs : 0;

  return (
    <div
      className={[
        "focus-shell",
        breaking ? "is-break" : "",
        // OS 側の窓の透過と CSS の地の濃さを食い違わせない
        settings && !settings.focusTransparent ? "is-opaque" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={shellRef}
    >
      <div className="focus-progress">
        <i style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }} />
      </div>

      {snap.awaitingChoice ? (
        <Choice snap={snap} doneTitle={task?.title ?? null} />
      ) : breaking ? (
        <Triage snap={snap} />
      ) : (
        <div className="focus-body drag-region">
          <div className={`focus-clock${snap.running ? "" : " is-paused"}`}>
            {formatClock(snap.remainingMs)}
          </div>

          {/* ボタンをこれ以上増やさずに、ホットキー以外の入り口を作る。
              ドラッグはこの外側 (時計や余白) で受ける。 */}
          <div
            className="focus-main no-drag"
            title="ダブルクリックで一時メモに追加"
            onDoubleClick={() => void ipc.showCapture()}
          >
            <div className="focus-phase">
              {snap.reviewing ? "見直し" : PHASE_LABEL[snap.phase]}
              {!snap.running && snap.phase !== "idle" ? " · 一時停止" : ""}
              {snap.interruptCount > 0 ? ` · 中断 ${snap.interruptCount}` : ""}
            </div>
            <div className={`focus-task${task ? "" : " is-empty"}`}>
              {task ? task.title : "タスク未選択"}
            </div>
            {nextSubtask && <div className="focus-subtask">{nextSubtask.title}</div>}
          </div>

          <div className="focus-actions no-drag">
            <InboxIndicator count={inbox} pulse={pulse} showCount={settings?.showInboxCount ?? false} />
            {task && (
              <button
                className={`icon-btn${noteOpen ? " is-on" : ""}${task.note ? " has-note" : ""}`}
                title={task.note ? "このタスクのメモ" : "このタスクにメモを書く"}
                onClick={() => setNoteOpen((v) => !v)}
              >
                <NoteIcon />
              </button>
            )}
            {task && task.status !== "done" && (
              <button
                className="icon-btn is-done"
                title="このタスクを完了にする"
                onClick={() => void ipc.completeCurrentTask()}
              >
                <CheckIcon />
              </button>
            )}
            {snap.running ? (
              <button className="icon-btn" title="一時停止" onClick={() => void ipc.timerPause()}>
                <PauseIcon />
              </button>
            ) : (
              <button className="icon-btn" title="再開" onClick={() => void ipc.timerResume()}>
                <PlayIcon />
              </button>
            )}
            <button
              className="icon-btn is-danger"
              title="中断して管理画面へ戻る"
              onClick={() => void ipc.timerStop()}
            >
              <StopIcon />
            </button>
          </div>
        </div>
      )}

      {/* 集中中でも、今やっている仕事の資料には手が届くようにする。
          既定では畳んでおき、開いたぶんだけウィンドウが伸びる。 */}
      {noteOpen && !breaking && !snap.awaitingChoice && task && (
        <FocusNote key={task.id} task={task} />
      )}
    </div>
  );
}

/** 入力が止まってから保存するまでの間 */
const NOTE_SAVE_DELAY_MS = 700;

/**
 * 集中中のメモ。読むだけでなく書ける。
 *
 * 枠の高さは固定にしてある。入力に合わせて伸び縮みさせると、打つたびに
 * ウィンドウが動いて落ち着かない。溢れた分はこの中でスクロールさせる。
 */
function FocusNote({ task }: { task: Task }) {
  const [value, setValue] = useState(task.note ?? "");
  const saved = useRef(task.note ?? "");

  // 集中中は画面を閉じずに時間切れになることもあるので、
  // フォーカスが外れるのを待たずに、入力が止まった時点で保存する。
  useEffect(() => {
    if (value === saved.current) return;
    const id = window.setTimeout(() => {
      saved.current = value;
      void ipc.setNote(task.id, value);
    }, NOTE_SAVE_DELAY_MS);
    return () => window.clearTimeout(id);
  }, [value, task.id]);

  const flush = () => {
    if (value === saved.current) return;
    saved.current = value;
    void ipc.setNote(task.id, value);
  };

  return (
    <div className="focus-note">
      <textarea
        className="focus-note-body"
        value={value}
        spellCheck={false}
        placeholder="依頼文や参照 URL、気づいたこと"
        onChange={(e) => setValue(e.target.value)}
        onBlur={flush}
      />
      <NoteLinks text={value} />
    </div>
  );
}

/**
 * タスクが鳴る前に終わったときの分岐。
 *
 * タイマーは止めない — ポモドーロは分割できないという原則を保つため。
 * 残り時間の長さで既定の推奨だけを変え、決めるのは本人に任せる。
 */
function Choice({ snap, doneTitle }: { snap: TimerSnapshot; doneTitle: string | null }) {
  const [picking, setPicking] = useState(false);
  const [candidates, setCandidates] = useState<Task[] | null>(null);
  const minutesLeft = Math.ceil(snap.remainingMs / 60_000);
  // 残りが僅かなら休憩、たっぷりあるなら次の 1 件を推す
  const recommend: "review" | "next" | "break" =
    minutesLeft <= 3 ? "break" : minutesLeft >= 10 ? "next" : "review";

  const openPicker = () => {
    setPicking(true);
    void ipc.nextCandidates(3).then(setCandidates);
  };

  if (picking) {
    return (
      <div className="choice">
        <div className="choice-head">
          <span className="choice-title">次にやる 1 件</span>
          <span className="choice-clock">{formatClock(snap.remainingMs)}</span>
        </div>

        {candidates === null ? null : candidates.length === 0 ? (
          <div className="choice-empty">
            候補がありません。
            <br />
            見直しに充てるか、休憩に入ってください。
          </div>
        ) : (
          <div className="choice-list">
            {candidates.map((c) => (
              <button
                key={c.id}
                className="choice-item"
                onClick={() => void ipc.chooseHandoff(c.id)}
              >
                <span className="choice-item-title">{c.title}</span>
                {c.due && <DueChip due={c.due} />}
              </button>
            ))}
          </div>
        )}

        <button className="choice-back" onClick={() => setPicking(false)}>
          戻る
        </button>
      </div>
    );
  }

  return (
    <div className="choice">
      <div className="choice-head">
        <span className="choice-title">
          完了{doneTitle ? ` — ${doneTitle}` : ""}
        </span>
        <span className="choice-clock">{formatClock(snap.remainingMs)}</span>
      </div>
      <p className="choice-lede">残り {minutesLeft} 分の使い道を選んでください。</p>

      <div className="choice-btns">
        <button
          className={`choice-btn${recommend === "review" ? " is-rec" : ""}`}
          onClick={() => void ipc.chooseReview()}
        >
          見直す
          <small>鳴るまで同じ仕事を磨く</small>
        </button>
        <button
          className={`choice-btn${recommend === "next" ? " is-rec" : ""}`}
          onClick={openPicker}
        >
          次をやる
          <small>この枠のまま次の 1 件へ</small>
        </button>
        <button
          className={`choice-btn${recommend === "break" ? " is-rec" : ""}`}
          onClick={() => void ipc.chooseBreak()}
        >
          休憩へ
          <small>ポモドーロは 1 回として数える</small>
        </button>
      </div>
    </div>
  );
}

function DueChip({ due }: { due: string }) {
  const state = dueState(due);
  return <span className={`due-chip is-${state ?? "later"}`}>{formatDue(due)}</span>;
}

/** 件数は既定で伏せる。「何かが入った」ことだけをパルスで伝える */
function InboxIndicator({
  count,
  pulse,
  showCount,
}: {
  count: number;
  pulse: boolean;
  showCount: boolean;
}) {
  const cls = ["inbox-dot", count > 0 ? "has-items" : "", pulse ? "pulse" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <div className={cls} title={`一時メモ ${count} 件`}>
        <span />
      </div>
      {showCount && <div className="inbox-count">{count > 0 ? count : ""}</div>}
    </>
  );
}

/**
 * 休憩フェーズの triage。捕まえた割り込みを「今日やる / 後で / 捨てる」に振り分ける。
 * 1 件ずつしか出さないので、休憩中も一覧に飲まれない。
 */
function Triage({ snap }: { snap: TimerSnapshot }) {
  const [queue, setQueue] = useState<Task[]>([]);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    void ipc.listTasks(["inbox"]).then((t) => {
      setQueue(t);
      setLoaded(true);
    });
  }, []);

  useEffect(load, [load]);

  const head = queue[0];

  /** null の「後で」は Inbox に残したまま次へ送る */
  const decide = async (action: "do" | "drop" | null) => {
    if (!head) return;
    if (action === "do") await ipc.promoteInbox(head.id);
    if (action === "drop") await ipc.trashTask(head.id);
    setQueue((q) => q.slice(1));
  };

  return (
    <div className="triage">
      <div className="triage-head">
        <span className="triage-title">一時メモの整理</span>
        <span className="triage-clock">{formatClock(snap.remainingMs)}</span>
        {/* 休憩は放っておいても終わるが、切り上げる手段が無いのは窮屈すぎる */}
        <button className="triage-skip" title="休憩を切り上げる" onClick={() => void ipc.timerSkip()}>
          終える
        </button>
      </div>

      {!loaded ? null : head ? (
        <>
          <div className="triage-item">
            <div className="triage-item-title">{head.title}</div>
            <div className="triage-btns">
              <button onClick={() => void decide("do")}>やる</button>
              <button onClick={() => void decide(null)}>後で</button>
              <button onClick={() => void decide("drop")}>捨てる</button>
            </div>
          </div>
          <div className="triage-remaining">残り {queue.length} 件</div>
        </>
      ) : (
        <div className="triage-empty">
          整理するものはありません。
          <br />
          休んでください。
        </div>
      )}
    </div>
  );
}

/* ---- icons (15px, currentColor) ---- */
const S = { width: 15, height: 15, viewBox: "0 0 24 24", fill: "currentColor" } as const;
const PlayIcon = () => (
  <svg {...S}>
    <path d="M8 5.5v13l11-6.5z" />
  </svg>
);
const PauseIcon = () => (
  <svg {...S}>
    <path d="M7 5h3.2v14H7zm6.8 0H17v14h-3.2z" />
  </svg>
);
const StopIcon = () => (
  <svg {...S}>
    <rect x="6.5" y="6.5" width="11" height="11" rx="1.6" />
  </svg>
);
const NoteIcon = () => (
  <svg {...S}>
    <path d="M6 3h8.5L19 7.5V21H6zm8 1.6V8h3.4zM8.4 11h7.2v1.5H8.4zm0 3.4h7.2V16H8.4zm0 3.4h4.8v1.5H8.4z" />
  </svg>
);
const CheckIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
    <path d="M4.5 12.5l5 5 10-11" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

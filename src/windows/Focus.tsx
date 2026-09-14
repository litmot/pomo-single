import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import * as ipc from "../lib/ipc";
import { NoteLinks } from "../lib/NoteBody";
import { CheckIcon, NoteIcon, SubtaskIcon, WaitIcon } from "../lib/icons";
import { openPicker, useComposition } from "../lib/ime";
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
  /** 着手中タスクが属する仕事の親 (自身が親ならなし) */
  const [parentTask, setParentTask] = useState<Task | null>(null);
  /** 同じ仕事の内訳。既定では畳んでおく */
  const [siblings, setSiblings] = useState<Task[]>([]);
  const [subOpen, setSubOpen] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [inbox, setInbox] = useState(0);
  const [pulse, setPulse] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [waitOpen, setWaitOpen] = useState(false);
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
      setParentTask(null);
      setSiblings([]);
      return;
    }
    const all = await ipc.listTasks(["todo", "doing", "waiting", "done"]);
    // 引き継ぎ時は tasks://changed と timer://phase が続けて飛ぶ。
    // 古い ID での応答が後から届いて新しい表示を上書きするのを防ぐ。
    if (wantedTaskId.current !== taskId) return;

    const current = all.find((t) => t.id === taskId) ?? null;
    setTask(current);

    // 着手中が親なら its 子、サブタスクなら同じ親の兄弟を束ねる。
    // どちらの場合も「約束した 1 件の内訳」という同じ意味になる。
    const parentId = current?.parentId ?? current?.id ?? null;
    setParentTask(current?.parentId ? (all.find((t) => t.id === current.parentId) ?? null) : null);
    setSiblings(parentId ? all.filter((t) => t.parentId === parentId) : []);
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

  /**
   * 全画面かどうか。設定として持っているので、次のセッションにも残る。
   *
   * 高さの扱いがまるで逆になる (中身に合わせる ⇄ モニタに合わせる) ので、
   * 測る処理はすべてこの値で止める。
   */
  const full = settings?.focusFullscreen ?? false;

  /** 中身の高さをウィンドウに反映する */
  const fitWindow = useCallback(() => {
    if (full) return;
    const el = shellRef.current;
    if (!el) return;
    const height = Math.round(el.getBoundingClientRect().height);
    if (height > 0) void ipc.resizeFocus(height);
  }, [full]);

  // 表示する中身は状況で変わる (1 行 / triage / 3 択 / 候補 / メモ)。
  // 高さを決め打ちにすると必ずどこかで見切れるので、中身の高さに追従させる。
  //
  // 監視だけに頼らないのは、ウィンドウが隠れている間は WebView2 が
  // レイアウトを走らせず ResizeObserver が発火しないため。表示や切り替えの
  // たびに明示的にも測る。
  useEffect(() => {
    if (full) return;
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
  }, [full]);

  // フェーズが変わったらメモと内訳は畳む。次の仕事に持ち越さない
  useEffect(() => {
    setNoteOpen(false);
    setWaitOpen(false);
  }, [snap?.phase, snap?.currentTaskId]);

  useEffect(() => {
    setSubOpen(false);
  }, [snap?.phase, parentTask?.id, task?.parentId]);

  // 表示する中身が切り替わった直後に、描画を待ってから測る
  useEffect(() => {
    const id = requestAnimationFrame(fitWindow);
    return () => cancelAnimationFrame(id);
  }, [
    fitWindow,
    full,
    noteOpen,
    waitOpen,
    subOpen,
    snap?.phase,
    snap?.awaitingChoice,
    snap?.reviewing,
    task?.id,
  ]);

  if (!snap) return null;

  const breaking = isBreak(snap.phase);
  /**
   * 進捗バーの長さ。
   *
   * 集中中は「積み上げた分」なので伸ばす。休憩中は逆に「残っている分」を
   * 出して減らしていく — 休みは積み上げるものではなく、使い切るもの。
   * 同じ向きに伸ばすと、休憩が終わりに近づくほどバーが満ちて、達成感の
   * ような読み違えを招く。
   */
  const ratio = snap.totalMs > 0 ? snap.remainingMs / snap.totalMs : 0;
  const progress = breaking ? ratio : 1 - ratio;

  return (
    <div
      className={[
        "focus-shell",
        breaking ? "is-break" : "",
        full ? "is-full" : "",
        // OS 側の窓の透過と CSS の地の濃さを食い違わせない
        settings && !settings.focusTransparent ? "is-opaque" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={shellRef}
    >
      {snap.awaitingChoice ? (
        <Choice snap={snap} task={task} onContentChange={fitWindow} />
      ) : breaking ? (
        <>
          <Triage onContentChange={fitWindow} />
          {/* 休憩中も計測器は同じ場所・同じ大きさ。むしろ休憩は
              「あと何分休めるか」が主題なので、時計が一番大きい */}
          <Meter snap={snap} full={full}>
            <InboxIndicator
              count={inbox}
              pulse={pulse}
              showCount={settings?.showInboxCount ?? false}
            />
            {/* PC で休む (動画を見る、調べ物をする) のも休憩。暗幕で
                潰してしまうと、休憩そのものを避けるようになる */}
            {(settings?.breakDim ?? true) && (
              <button
                className={`icon-btn${snap.dimLifted ? "" : " is-on"}`}
                title={snap.dimLifted ? "画面をまた暗くする" : "画面の暗転を解除する"}
                onClick={() => void ipc.setBreakDim(snap.dimLifted)}
              >
                {snap.dimLifted ? <DimOffIcon /> : <DimOnIcon />}
              </button>
            )}
            <button
              className="icon-btn"
              title="休憩を切り上げる"
              onClick={() => void ipc.timerSkip()}
            >
              <SkipIcon />
            </button>
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
          </Meter>
        </>
      ) : (
        <>
          {/* タスク名と、そこから開く中身 (内訳・メモ・待ち) をひと組に
              しておく。小窓では `display: contents` で無いも同然だが、
              全画面ではこの組ごと画面の中央に置く。組にしていないと、
              開いた中身だけが計測器の側に取り残されて離れてしまう。 */}
          <div className="focus-stage">
          {/* タスク名が先。ボタンをこれ以上増やさずにホットキー以外の
              入り口を作るため、ここのダブルクリックで一時メモを開く。 */}
          <div className="focus-body drag-region">
            <div
              className="focus-main no-drag"
              title="ダブルクリックで一時メモに追加"
              onDoubleClick={() => {
                // ダブルクリックはブラウザが単語を選択した後に届く。
                // 入力欄が出てきたときにタスク名が青く反転したままでは、
                // どちらに文字を打つのか分からなくなるので解いておく。
                // 引きずっての選択 (コピー) は今まで通りできる。
                window.getSelection()?.removeAllRanges();
                void ipc.showCapture();
              }}
            >
              <div className="focus-main-text">
                {/* サブタスクに着手しているときは、どの仕事の内訳かを見失わせない */}
                {parentTask && <div className="focus-parent">{parentTask.title}</div>}
                <div className={`focus-task${task ? "" : " is-empty"}`}>
                  {task ? task.title : "タスク未選択"}
                </div>
              </div>

              {/* このタスクに付いている操作はすべてここ。計測器の列には
                  タイマーそのものに関わるものだけを残す。並びは
                  完了 → 待ち → メモ → 内訳 で、左から「片付ける」順。
                  下端に寄せてあるのは、開いた中身がすぐ下に生えるため。 */}
              <div className="focus-main-tools" onDoubleClick={(e) => e.stopPropagation()}>
                {task && task.status !== "done" && (
                  <button
                    className="icon-btn is-done"
                    title="このタスクを完了にする"
                    onClick={() => void ipc.completeCurrentTask()}
                  >
                    <CheckIcon />
                  </button>
                )}
                {task && task.status !== "done" && (
                  <button
                    className={`icon-btn${waitOpen ? " is-on" : ""}`}
                    title="このタスクを待ちにする"
                    onClick={() => setWaitOpen((v) => !v)}
                  >
                    <WaitIcon />
                  </button>
                )}
                {task && (
                  <button
                    className={`icon-btn${noteOpen ? " is-on" : ""}${task.note ? " has-note" : ""}`}
                    title={task.note ? "このタスクのメモ" : "このタスクにメモを書く"}
                    onClick={() => setNoteOpen((v) => !v)}
                  >
                    <NoteIcon />
                  </button>
                )}
                {/* 内訳の開閉はこの三角形だけ。件数まで出すと、畳んでいる意味が薄れる */}
                {siblings.length > 0 && (
                  <button
                    className={`focus-sub-toggle${subOpen ? " is-open" : ""}`}
                    title={
                      subOpen
                        ? "内訳を畳む"
                        : `内訳を開く (${siblings.filter((t) => t.status === "done").length}/${siblings.length} 完了)`
                    }
                    onClick={() => setSubOpen((v) => !v)}
                  >
                    <SubtaskIcon />
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* 仕事の内訳。開いたときだけ並べる。
              一覧を常時見せないという方針は守ったまま、必要なときだけ出す。 */}
          {subOpen && siblings.length > 0 && (
            <SubtaskList items={siblings} currentId={task?.id ?? null} />
          )}

          {/* 集中中でも、今やっている仕事の資料には手が届くようにする。
              既定では畳んでおき、開いたぶんだけウィンドウが伸びる。 */}
          {noteOpen && task && <FocusNote key={task.id} task={task} />}

          {/* 待ちにするときの入力。管理画面と同じく要因と催促の日を取る */}
          {waitOpen && task && (
            <WaitForm
              key={task.id}
              task={task}
              onClose={() => setWaitOpen(false)}
            />
          )}
          </div>

          {/* 計測器 (タイマー・操作・進捗) は下段にまとめる。窓は下端を
              固定して上に伸びるので、ここに置けばメモや 3 択を開いても
              タイマーが画面上で動かない。 */}
          <Meter snap={snap} full={full}>
            <InboxIndicator
              count={inbox}
              pulse={pulse}
              showCount={settings?.showInboxCount ?? false}
            />
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
          </Meter>
        </>
      )}

      {/* 進捗もタイマーと同じ計測器の部品。最下端に敷く */}
      <div className="focus-progress">
        <i style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }} />
      </div>
    </div>
  );
}

/**
 * 下段の計測器 — 時計・フェーズ名・操作ボタン。
 *
 * 集中中も休憩中も同じ場所に同じ大きさで置く。窓は下端を固定して上に
 * 伸びるので、ここが動かない限り、中身が変わっても目で追う対象がずれない。
 * フェーズが変わるたびに時計の位置と大きさが変わるようでは、そもそも
 * 「残り時間を測る道具」として信用できない。
 */
function Meter({
  snap,
  full,
  children,
}: {
  snap: TimerSnapshot;
  full: boolean;
  children: ReactNode;
}) {
  return (
    <div className="focus-head drag-region">
      <div className={`focus-clock${snap.running ? "" : " is-paused"}`}>
        {formatClock(snap.remainingMs)}
      </div>
      <div className="focus-phase">
        {snap.reviewing ? "見直し" : PHASE_LABEL[snap.phase]}
        {!snap.running && snap.phase !== "idle" ? " · 一時停止" : ""}
        {snap.interruptCount > 0 ? ` · 中断 ${snap.interruptCount}` : ""}
      </div>
      <div className="focus-actions no-drag">
        {children}
        {/* 表示の形を変えるだけのボタンなので、仕事の操作より後ろに置く */}
        <button
          className={`icon-btn${full ? " is-on" : ""}`}
          title={
            full
              ? "小窓に戻す"
              : "このウィンドウがあるモニタを全画面で覆う (先に出したいモニタへ動かしてから押す)"
          }
          onClick={() => void ipc.setFocusFullscreen(!full)}
        >
          {full ? <ShrinkIcon /> : <ExpandIcon />}
        </button>
      </div>
    </div>
  );
}

/**
 * 仕事の内訳。
 *
 * 兄弟サブタスクを並べ、その場で着手先を切り替えたり完了にできる。
 * 同じ親の中での移動は中断に数えないので、ここでの切り替えは実績を汚さない。
 */
function SubtaskList({ items, currentId }: { items: Task[]; currentId: string | null }) {
  const check = (t: Task) => {
    if (t.status === "done") return void ipc.setTaskStatus(t.id, "todo");
    // 着手中のものを終えたら、残り時間の使い道を聞く流れに乗せる
    if (t.id === currentId) return void ipc.completeCurrentTask();
    return void ipc.setTaskStatus(t.id, "done");
  };

  return (
    <div className="focus-subs">
      <div className="focus-subs-list">
        {items.map((t) => (
            <div
              key={t.id}
              className={`focus-sub${t.id === currentId ? " is-current" : ""}${
                t.status === "done" ? " is-done" : ""
              }`}
            >
              <button
                className="focus-sub-check"
                title={t.status === "done" ? "未完了に戻す" : "完了にする"}
                onClick={() => check(t)}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3.4"
                >
                  <path d="M4.5 12.5l5 5 10-11" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              <span className="focus-sub-title">{t.title}</span>
              {t.status !== "done" && t.id !== currentId && (
                <button
                  className="focus-sub-switch"
                  title="これに切り替える"
                  onClick={() => void ipc.switchCurrentTask(t.id)}
                >
                  切替
                </button>
              )}
            {t.id === currentId && <span className="focus-sub-now">着手中</span>}
          </div>
        ))}
      </div>
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
 * 集中中に「待ち」へ回すときの入力。
 *
 * 管理画面と同じく、何を待っているかと、いつまで待つかを一緒に取る。
 * 要因を Enter で確定するとそのままカレンダーへ移るのも同じ運び方。
 * どちらも空のまま出せる — 詰まった瞬間に理由を書けとは限らないので、
 * 入力を必須にすると「待ちにせず放置する」方に逃げてしまう。
 */
function WaitForm({ task, onClose }: { task: Task; onClose: () => void }) {
  const [reason, setReason] = useState(task.waitingFor ?? "");
  const [until, setUntil] = useState(task.waitingUntil ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const { composing, handlers } = useComposition();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commit = (nextUntil = until) => {
    void ipc.waitCurrentTask(reason.trim(), nextUntil);
    onClose();
  };

  /**
   * 日付欄へ移る。
   *
   * キーを押した処理の中で同期的に呼ぶ必要がある。`showPicker()` は
   * ユーザー操作の最中でないと拒否されるので、状態を更新して
   * 描画後の effect で呼ぶ形にすると、focus は移るがカレンダーは開かない。
   */
  const toDate = () => {
    dateRef.current?.focus();
  };

  return (
    <div className="focus-wait">
      <div className="focus-wait-row">
        <input
          ref={inputRef}
          className="focus-wait-reason"
          value={reason}
          placeholder="何を待つか (例: A社の返信)"
          spellCheck={false}
          onChange={(e) => setReason(e.target.value)}
          {...handlers}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !composing.current) {
              e.preventDefault();
              toDate();
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
        />
        <span className="focus-wait-label">いつまで</span>
        <input
          ref={dateRef}
          type="date"
          className="focus-wait-date"
          value={until}
          // 受け取り方 (Enter で移ってきた / Tab / クリック) に関わらず開く。
          // 日付欄に来た時点で、やりたいのは日付を選ぶことしかない。
          onFocus={(e) => openPicker(e.currentTarget)}
          onChange={(e) => setUntil(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
        />
      </div>
      <button className="focus-wait-go" onClick={() => commit()}>
        待ちにする
      </button>
    </div>
  );
}

/**
 * タスクが鳴る前に終わったときの分岐。
 *
 * タイマーは止めない — ポモドーロは分割できないという原則を保つため。
 * 残り時間の長さで既定の推奨だけを変え、決めるのは本人に任せる。
 */
function Choice({
  snap,
  task,
  onContentChange,
}: {
  snap: TimerSnapshot;
  task: Task | null;
  onContentChange: () => void;
}) {
  const [picking, setPicking] = useState(false);
  const [candidates, setCandidates] = useState<Task[] | null>(null);

  useEffect(() => {
    const id = requestAnimationFrame(onContentChange);
    return () => cancelAnimationFrame(id);
  }, [onContentChange, picking, candidates]);
  const minutesLeft = Math.ceil(snap.remainingMs / 60_000);
  // 待ちに回したときは「見直す」を出さない。相手の番になっている仕事を
  // 磨き直すことはできないので、選ばせても手が止まるだけ。
  const waiting = task?.status === "waiting";
  // 残りが僅かなら休憩、たっぷりあるなら次の 1 件を推す
  const recommend: "review" | "next" | "break" =
    minutesLeft <= 3 || (waiting && minutesLeft < 10)
      ? "break"
      : minutesLeft >= 10
        ? "next"
        : "review";

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
          {waiting ? "待ち" : "完了"}
          {task ? ` — ${task.title}` : ""}
        </span>
        <span className="choice-clock">{formatClock(snap.remainingMs)}</span>
      </div>
      <p className="choice-lede">残り {minutesLeft} 分の使い道を選んでください。</p>

      <div className="choice-btns">
        {!waiting && (
          <button
            className={`choice-btn${recommend === "review" ? " is-rec" : ""}`}
            onClick={() => void ipc.chooseReview()}
          >
            見直す
            <small>鳴るまで同じ仕事を磨く</small>
          </button>
        )}
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
function Triage({ onContentChange }: { onContentChange: () => void }) {
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

  // 項目ごとに本文の長さが違う。次に送った時点で測り直さないと、
  // 窓の高さが前の項目のままになる。
  useEffect(() => {
    const id = requestAnimationFrame(onContentChange);
    return () => cancelAnimationFrame(id);
  }, [onContentChange, head?.id, loaded]);

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
        {loaded && queue.length > 0 && (
          <span className="triage-remaining">残り {queue.length} 件</span>
        )}
      </div>

      {!loaded ? null : head ? (
        <>
          <div className="triage-item">
            {/* 本文だけをスクロールさせる。ボタンと同じ伸縮領域に入れると、
                長い貼り付けのときにボタンが押し出されて押せなくなる。 */}
            <div className="triage-item-body">{head.title}</div>
            <div className="triage-btns">
              <button onClick={() => void decide("do")}>やる</button>
              <button onClick={() => void decide(null)}>後で</button>
              <button onClick={() => void decide("drop")}>捨てる</button>
            </div>
          </div>
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
/** 暗幕がかかっている状態。押すと外れる */
const DimOnIcon = () => (
  <svg {...S}>
    <path d="M12 3.4A8.6 8.6 0 1 0 12 20.6 8.6 8.6 0 0 0 12 3.4zm0 1.8v13.6a6.8 6.8 0 0 1 0-13.6z" />
  </svg>
);

/** 暗幕を外している状態。押すと掛け直す */
const DimOffIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9">
    <circle cx="12" cy="12" r="3.9" />
    <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6" strokeLinecap="round" />
  </svg>
);

/** モニタいっぱいに広げる。四隅の矢印 */
const ExpandIcon = () => (
  <svg {...S}>
    <path d="M4 4h6.4v2.1H6.1v4.3H4zm9.6 0H20v6.4h-2.1V6.1h-4.3zM4 13.6h2.1v4.3h4.3V20H4zm13.9 0H20V20h-6.4v-2.1h4.3z" />
  </svg>
);

/** 小窓に戻す。内向きの矢印 */
const ShrinkIcon = () => (
  <svg {...S}>
    <path d="M8.5 4h2.1v6.6H4V8.5h4.5zm4.9 0h2.1v4.5H20v2.1h-6.6zM4 13.4h6.6V20H8.5v-4.5H4zm9.4 0H20v2.1h-4.5V20h-2.1z" />
  </svg>
);

/** 休憩を切り上げる。次へ送る意味の ⏭ */
const SkipIcon = () => (
  <svg {...S}>
    <path d="M6.5 5.5l8 6.5-8 6.5zm9.4 0h2.1v13h-2.1z" />
  </svg>
);


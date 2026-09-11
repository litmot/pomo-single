import React, { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import * as ipc from "../lib/ipc";
import { NoteLinks, noteSummary } from "../lib/NoteBody";
import { canNest, resolveDrop, type DropTarget, type DropZone } from "../lib/dnd";
import { NoteIcon, SubtaskIcon, WaitIcon } from "../lib/icons";
import {
  EV,
  dueState,
  formatDue,
  nextOccurrence,
  planUntil,
  toTimeInput,
  type Settings,
  type Task,
  type TimerSnapshot,
  type TodayStats,
} from "../lib/types";
import "../styles/app.css";
import "../styles/manage.css";

/**
 * 開いている間、欄外を押したら閉じる。
 *
 * 「やめる」ボタンを置くより、外を押せば閉じるほうが説明が要らない。
 */
function useDismissOnOutside(open: boolean, onDismiss: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onDismiss]);
  return ref;
}

/**
 * Manage View — ポモドーロを回していない時間に使う画面。
 * ここでは一覧化してよい。Inbox の整理と「次にやる 1 件」の決定が仕事。
 */
export default function Manage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [snap, setSnap] = useState<TimerSnapshot | null>(null);
  const [stats, setStats] = useState<TodayStats | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [draft, setDraft] = useState("");
  const [subDraftFor, setSubDraftFor] = useState<string | null>(null);
  /** 期限を編集中の行。追加直後はその新しいタスクを指す */
  const [dueEditingFor, setDueEditingFor] = useState<string | null>(null);
  /** メモを開いている行 */
  const [noteOpenFor, setNoteOpenFor] = useState<string | null>(null);
  /** 「タスクのメモへ」の移動先を選んでいる一時メモの行 */
  const [noteTargetFor, setNoteTargetFor] = useState<string | null>(null);
  const [trash, setTrash] = useState<Task[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const [waitingOpen, setWaitingOpen] = useState(false);
  /** 待ちの要因を編集中の行 */
  const [waitingEditFor, setWaitingEditFor] = useState<string | null>(null);
  /** 名前を編集中の行。新規タスクを起こした直後はそこへカーソルを移す */
  const [titleEditingFor, setTitleEditingFor] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  /** 一覧の末尾の落とし先にかかっているか */
  const [tailActive, setTailActive] = useState(false);
  /** 次の予定 (RFC3339)。会議までに 1 本入るかの判断に使う */
  const [appointment, setAppointment] = useState<string | null>(null);
  /** 入らないと分かっていて、それでも始めるとき */
  const [ignoreAppointment, setIgnoreAppointment] = useState(false);
  /** 残り時間の表示を進めるためだけの時計 */
  const [now, setNow] = useState(() => Date.now());
  /** 期限の入力を閉じたあと、続けて打てるよう追加欄に戻る */
  const addInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    const [t, s, st, tr, cfg] = await Promise.all([
      ipc.listTasks(["inbox", "todo", "doing", "waiting", "done"]),
      ipc.timerState(),
      ipc.todayStats(),
      ipc.listTrash(),
      // 起動時にホットキーが空きキーへ退避することがある。その書き戻しは
      // 画面が待ち受けを始める前に起きるので、通知だけでは取りこぼす。
      // 読み直しのたびに取り直して、案内と実際のキーを食い違わせない。
      ipc.getSettings(),
    ]);
    setTasks(t);
    setSnap(s);
    setStats(st);
    setTrash(tr);
    setSettings(cfg);
    setAppointment(await ipc.getNextAppointment());
  }, []);

  useEffect(() => {
    void reload();
    void ipc.getSettings().then(setSettings);
    const unlisten = Promise.all([
      listen(EV.tasksChanged, () => void reload()),
      listen(EV.inboxAdded, () => void reload()),
      // ホットキーが衝突して別のキーに退避した場合、画面の案内も追従させる
      listen(EV.settingsChanged, () => void ipc.getSettings().then(setSettings)),
      listen<TimerSnapshot>(EV.phase, (e) => {
        setSnap(e.payload);
        void reload();
      }),
    ]);
    return () => void unlisten.then((fns) => fns.forEach((f) => f()));
  }, [reload]);

  // 予定までの残りは黙っていても減る。30 秒ごとに数え直す
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const inbox = useMemo(() => tasks.filter((t) => t.status === "inbox"), [tasks]);

  /**
   * 親タスクと、その配下のサブタスクを 1 階層だけ束ねる。
   *
   * 完了した親は分けて持つ。普段の一覧は「これからやるもの」だけにしたいので、
   * 終わったものは畳んだ引き出しに回す。完了したサブタスクは、親がまだ
   * 進行中なら進み具合として一覧に残す。
   */
  const tree = useMemo(() => {
    const active = tasks.filter(
      (t) => t.status !== "inbox" && t.status !== "archived" && t.status !== "trashed",
    );
    const parents = active.filter((t) => !t.parentId);
    const bundle = (p: Task) => ({ task: p, subs: active.filter((s) => s.parentId === p.id) });
    return {
      open: parents.filter((p) => p.status !== "done" && p.status !== "waiting").map(bundle),
      waiting: parents.filter((p) => p.status === "waiting").map(bundle),
      done: parents.filter((p) => p.status === "done").map(bundle),
    };
  }, [tasks]);

  /** 催促の日が来ている待ちの件数。畳んだまま忘れるのが一番困る */
  const waitingDue = useMemo(
    () =>
      tree.waiting.filter(({ task }) => {
        const state = dueState(task.waitingUntil);
        return state === "over" || state === "soon";
      }).length,
    [tree.waiting],
  );

  /** 「メモへ」の移動先候補 */
  const openTasks = useMemo(
    // 待ちも含める。返事が来たときに、その内容を足したくなる
    () => tasks.filter((t) => ["todo", "doing", "waiting"].includes(t.status)),
    [tasks],
  );

  const plan = useMemo(
    () => (appointment && settings ? planUntil(new Date(appointment).getTime(), now, settings) : null),
    [appointment, settings, now],
  );
  /** 予定までに 1 本も入らない。始める前に止める */
  const blocked = plan !== null && plan.fits === 0 && !ignoreAppointment;

  const setAppointmentTime = async (time: string) => {
    const at = time ? nextOccurrence(time) : null;
    setAppointment(at);
    setIgnoreAppointment(false);
    await ipc.setNextAppointment(at);
  };

  const currentId = snap?.currentTaskId ?? null;
  const found = tasks.find((t) => t.id === currentId) ?? null;
  // 完了済みのタスクでは集中を始めさせない
  const currentTask = found && found.status !== "done" ? found : null;
  /**
   * 休憩明けで、着手していたタスクがまだ終わっていない状態。
   *
   * 休憩の後は自動で次の集中に入らない (毎回「今からこれをやる」と決める場を
   * 残すため) が、続きをやるのが明らかなときまで選び直させる必要はない。
   * ボタンの名前だけを変えて、押せば同じタスクで次の 1 本が始まるようにする。
   */
  const resuming = currentTask !== null && snap?.afterBreakTaskId === currentId;

  /** Enter でもフォーカスを外したときでも確定させる */
  const addTask = async () => {
    const title = draft.trim();
    if (!title) return;
    setDraft("");
    const task = await ipc.createTask(title, "todo");
    // 追加した直後にそのままカレンダーを開く。期限を入れるためだけに
    // 行を探して 2 クリックする手間を省く。入れなければ期限なしのまま。
    setDueEditingFor(task.id);
  };

  /** 期限の入力を閉じる。追加の流れを止めないよう入力欄にフォーカスを返す */
  const closeDueEditor = () => {
    setDueEditingFor(null);
    addInputRef.current?.focus();
  };

  const toggleDone = async (t: Task) => {
    await ipc.setTaskStatus(t.id, t.status === "done" ? "todo" : "done");
  };

  const rename = async (t: Task, title: string) => {
    if (title === t.title) return;
    await ipc.updateTask(t.id, { title });
  };

  /** 空文字を渡すと期限が外れる */
  const setDue = async (t: Task, due: string) => {
    await ipc.updateTask(t.id, { due });
  };

  /** 一時メモを新しいタスクのメモにして、そのまま名前の入力へ移る */
  const moveToNewTask = async (inboxId: string) => {
    const created = await ipc.moveInboxToNewTask(inboxId);
    setTitleEditingFor(created.id);
  };

  /**
   * 落とした場所から、新しい親と差し込み位置を決める。
   *
   * 行の上下の端は「その行と同じ階層に挿入」、中央は「その行のサブタスクにする」。
   * サブタスクを最上位の行の端に落とせば、親タスクに戻る。
   */
  const applyDrop = async (target: DropTarget) => {
    const id = draggingId;
    setDraggingId(null);
    setDropTarget(null);
    if (!id) return;
    const move = resolveDrop(tasks, id, target);
    if (move) await ipc.moveTask(id, move.parentId, move.afterId);
  };

  /**
   * 一覧の末尾へ、親タスクとして移す。
   *
   * 行だけを落とし先にしていると、最下段には手が届かない。最後の親が
   * サブタスクを持っていれば、一番下に見えている行はそのサブタスクで、
   * その下端に落としても「同じ親の弟」= サブタスクになってしまう。
   * 行の外に一段、専用の落とし先を置いて逃げ道を作る。
   */
  const dropToEnd = async () => {
    const id = draggingId;
    setDraggingId(null);
    setDropTarget(null);
    if (!id) return;
    const parents = tree.open.filter((b) => b.task.id !== id).map((b) => b.task.id);
    await ipc.moveTask(id, null, parents[parents.length - 1] ?? null);
  };

  const select = (id: string) => void ipc.setCurrentTask(id === currentId ? null : id);

  /** 親 1 件とその配下を描く。一覧と「完了したタスク」の引き出しで共用する */
  const renderBundle = ({ task, subs }: { task: Task; subs: Task[] }) => {
    const row = (t: Task, isSub: boolean) => (
      <TaskRow
        key={t.id}
        task={t}
        isSub={isSub}
        isCurrent={t.id === currentId}
        onToggleDone={() => void toggleDone(t)}
        onSelect={() => select(t.id)}
        onRename={(title) => void rename(t, title)}
        onSetDue={(due) => void setDue(t, due)}
        titleEditing={titleEditingFor === t.id}
        onTitleEditingChange={(open) => setTitleEditingFor(open ? t.id : null)}
        dueEditing={dueEditingFor === t.id}
        onDueEditingChange={(open) => (open ? setDueEditingFor(t.id) : closeDueEditor())}
        noteOpen={noteOpenFor === t.id}
        onNoteOpenChange={(open) => setNoteOpenFor(open ? t.id : null)}
        onAddSub={isSub ? undefined : () => setSubDraftFor(t.id === subDraftFor ? null : t.id)}
        onDemote={() => void ipc.demoteToInbox(t.id)}
        onDelete={() => void ipc.trashTask(t.id)}
        waitingEditing={waitingEditFor === t.id}
        onWaitingEditingChange={(open) => setWaitingEditFor(open ? t.id : null)}
        dragging={draggingId === t.id}
        dropZone={dropTarget?.id === t.id ? dropTarget.zone : null}
        onDragStart={() => setDraggingId(t.id)}
        onDragEnd={() => {
          setDraggingId(null);
          setDropTarget(null);
          setTailActive(false);
        }}
        onDragOverZone={(zone) => {
          if (draggingId === null || draggingId === t.id) return;
          setTailActive(false);
          // 中央に落とすとサブタスクになる。子を持つものと、サブタスク自身は対象外
          const nestable = zone === "into" && !isSub && canNest(tasks, draggingId);
          setDropTarget({ id: t.id, zone: nestable ? "into" : zone === "into" ? "after" : zone });
        }}
        onDropHere={() => {
          if (dropTarget) void applyDrop(dropTarget);
        }}
      />
    );

    return (
      <div key={task.id}>
        {row(task, false)}
        {subs.map((sub) => row(sub, true))}
        {subDraftFor === task.id && (
          <div className="tk-row is-sub">
            <InlineInput
              className="tk-title-input"
              placeholder="サブタスクを追加して Enter"
              onCommit={(title) => {
                setSubDraftFor(null);
                void ipc.createTask(title, "todo", task.id);
              }}
              onCancel={() => setSubDraftFor(null)}
            />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="mg-shell">
      <header className="mg-head">
        <div className="mg-brand">
          Pomo<em>Single</em>
          <small>ONE TASK AT A TIME</small>
        </div>

        <div className="mg-stats">
          <div className="mg-stat">
            <b>{stats?.completedFocusSessions ?? 0}</b>
            <span>ポモドーロ</span>
          </div>
          <div className="mg-stat">
            <b>{stats?.completedTasks ?? 0}</b>
            <span>完了</span>
          </div>
          <div className="mg-stat">
            <b>{stats?.interruptions ?? 0}</b>
            <span>中断</span>
          </div>
        </div>

        <button className="btn" onClick={() => setShowSettings(true)}>
          設定
        </button>
      </header>

      <div className="mg-body">
        {/* Inbox: 捕まえた割り込みの置き場。ここで初めて振り分ける */}
        <section className="mg-pane mg-pane-inbox">
          <div className="mg-pane-head">
            <span className="mg-pane-title">一時メモ</span>
            {inbox.length > 0 && <span className="mg-badge">{inbox.length}</span>}
            <button
              className="mg-add-btn"
              title={`一時メモに追加 (${settings?.hotkey ?? "Ctrl+Alt+Space"})`}
              onClick={() => void ipc.showCapture()}
            >
              ＋
            </button>
          </div>
          <div className="mg-scroll">
            {inbox.length === 0 ? (
              <div className="mg-empty">
                <kbd>{settings?.hotkey ?? "Ctrl+Alt+Space"}</kbd> で追加
              </div>
            ) : (
              inbox.map((t) => (
                <InboxRow
                  key={t.id}
                  item={t}
                  targets={openTasks}
                  isPicking={noteTargetFor === t.id}
                  onPickingChange={(open) => setNoteTargetFor(open ? t.id : null)}
                  onMoveToNew={() => void moveToNewTask(t.id)}
                />
              ))
            )}
          </div>
        </section>

        {/* タスク一覧: ここでだけ全体を俯瞰する */}
        <section className="mg-pane mg-pane-tasks">
          <div className="mg-pane-head">
            <span className="mg-pane-title">タスク</span>
            <span className="mg-pane-hint">名前をクリックで編集 / 行をダブルクリックで選択</span>
          </div>
          <div className="mg-add">
            <input
              ref={addInputRef}
              value={draft}
              placeholder="タスクを追加して Enter"
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void addTask()}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) void addTask();
              }}
            />
          </div>
          <div className="mg-scroll">
            {tree.open.length === 0 ? (
              <div className="mg-empty">上の入力欄から追加</div>
            ) : (
              tree.open.map(renderBundle)
            )}
            {/* 最下段に置くための逃げ道。掴んでいる間だけ受ける。
                行の下端に落とすと最後の行と同じ階層になるので、最後の親が
                サブタスクを持っていると親タスクとして最後に置けない */}
            {draggingId !== null && (
              <div
                className={`tk-tail${tailActive ? " is-on" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  setDropTarget(null);
                  setTailActive(true);
                }}
                onDragLeave={() => setTailActive(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setTailActive(false);
                  void dropToEnd();
                }}
              >
                ここに落とすと一番下の親タスクになります
              </div>
            )}
          </div>

          {/* 待ちは畳むが、催促の日が来ていれば見出しで知らせる */}
          {tree.waiting.length > 0 && (
            <div className="mg-drawer">
              <button
                className={`mg-drawer-toggle${waitingDue > 0 ? " is-alert" : ""}`}
                onClick={() => setWaitingOpen((v) => !v)}
              >
                待ち {tree.waiting.length} 件
                {waitingDue > 0 ? ` (${waitingDue} 件 要確認)` : ""} {waitingOpen ? "▾" : "▸"}
              </button>
              {waitingOpen && (
                <div className="mg-drawer-tasks">{tree.waiting.map(renderBundle)}</div>
              )}
            </div>
          )}

          {/* 終わったものは畳んでおく。普段の一覧は「これからやるもの」だけ */}
          {tree.done.length > 0 && (
            <div className="mg-drawer">
              <button className="mg-drawer-toggle" onClick={() => setDoneOpen((v) => !v)}>
                完了したタスク {tree.done.length} 件 {doneOpen ? "▾" : "▸"}
              </button>
              {doneOpen && (
                <div className="mg-drawer-tasks">{tree.done.map(renderBundle)}</div>
              )}
            </div>
          )}

          {trash.length > 0 && (
            <div className="mg-drawer">
              <button className="mg-drawer-toggle" onClick={() => setTrashOpen((v) => !v)}>
                ゴミ箱 {trash.length} 件 {trashOpen ? "▾" : "▸"}
              </button>
              {trashOpen && (
                <>
                  <div className="tr-list">
                    {trash.map((t) => (
                      <div className="tr-row" key={t.id}>
                        <span className="tr-row-title">{t.title}</span>
                        <button className="tk-btn" onClick={() => void ipc.restoreTask(t.id)}>
                          戻す
                        </button>
                        <button className="tk-btn" onClick={() => void ipc.deleteTask(t.id)}>
                          完全に削除
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="tr-foot">
                    <span>終了すると空になります</span>
                    <button className="tk-btn" onClick={() => void ipc.emptyTrash()}>
                      空にする
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      </div>

      {/* 開始ボタンは下端の右寄せ。OK ボタンと同じ位置に置いて、
          その左隣に「何を始めるのか」を並べる */}
      <footer className="mg-foot">
        {/* 会議まで 1 本入るかを毎回目算するのは無駄な判断なので、ここで引き受ける */}
        <div className="mg-appt">
          <label htmlFor="appt">次の予定</label>
          <ApptInput
            value={appointment ? toTimeInput(appointment) : ""}
            onPick={(time) => void setAppointmentTime(time)}
          />
          {plan &&
            (plan.fits > 0 ? (
              <span className="mg-appt-fit">あと {plan.fits} 本</span>
            ) : (
              <span className="mg-appt-warn">{plan.minutesLeft} 分 — 1 本入りません</span>
            ))}
          {appointment && (
            <button className="mg-appt-clear" title="予定を外す" onClick={() => void setAppointmentTime("")}>
              ×
            </button>
          )}
        </div>

        <div className="mg-next">
          {blocked ? (
            <span className="mg-next-label">細切れの作業か、次の予定の準備に使う時間です</span>
          ) : currentTask ? (
            <>
              <span className="mg-next-label">{resuming ? "続き" : "次にやる"}</span>
              <span className="mg-next-title">{currentTask.title}</span>
            </>
          ) : (
            <span className="mg-next-label">行をダブルクリックで選択</span>
          )}
        </div>

        {blocked && currentTask && (
          <button className="mg-override" onClick={() => setIgnoreAppointment(true)}>
            予定を無視して開始
          </button>
        )}
        <button
          className="btn btn-primary btn-start"
          onClick={() => void ipc.timerStart(currentId)}
          disabled={!currentTask || blocked}
          title={blocked ? "次の予定までに 1 本が終わりません" : undefined}
        >
          {!currentTask ? "タスクを選んでください" : resuming ? "同じタスクでもう一度" : "集中を開始"}
        </button>
      </footer>

      {showSettings && settings && (
        <SettingsCard
          initial={settings}
          onClose={() => setShowSettings(false)}
          onSaved={(s) => {
            setSettings(s);
            setShowSettings(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * Inbox の 1 件。
 *
 * 貼り付けた依頼文がそのまま入っていることがあるので、改行を保って数行まで見せる。
 * 「やる」で 1 行目を名前・全文をメモにしたタスクになり、「メモへ」で
 * 既にあるタスクのメモに合流させて Inbox からは消す。
 */
function InboxRow({
  item,
  targets,
  isPicking,
  onPickingChange,
  onMoveToNew,
}: {
  item: Task;
  targets: Task[];
  isPicking: boolean;
  onPickingChange: (open: boolean) => void;
  onMoveToNew: () => void;
}) {
  const pickRef = useDismissOnOutside(isPicking, () => onPickingChange(false));
  const [editing, setEditing] = useState(false);

  return (
    <div className={`ib-row${isPicking ? " is-picking" : ""}`}>
      {/* 割り込みは急いで書き留めるものなので、誤字も言葉足らずも残る。
          タスク名と同じく、押せばその場で直せるようにしておく。
          複数行を貼ってあることがあるので textarea で受ける */}
      {editing ? (
        <InlineArea
          initial={item.title}
          onCommit={(text) => {
            setEditing(false);
            if (text !== item.title) void ipc.updateTask(item.id, { title: text });
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div
          className="ib-row-title"
          title="クリックで書き直す"
          onClick={() => setEditing(true)}
        >
          {item.title}
        </div>
      )}
      {/* 貼り付けた文章に URL が混ざっていることがある。押せるようにしておく */}
      <NoteLinks text={item.title} />

      {isPicking ? (
        <div className="ib-pick" ref={pickRef}>
          <div className="ib-pick-list">
            {/* 貼り付けた文章から名前を機械的に作るより、その場で付けたほうが
                短く的確になる。名前は空で起こして、そのまま入力へ移す。 */}
            <button
              className="ib-pick-item is-new"
              onClick={() => {
                onPickingChange(false);
                onMoveToNew();
              }}
            >
              ＋ 新規タスクへ
            </button>
            {targets.map((t) => (
              <button
                key={t.id}
                className="ib-pick-item"
                onClick={() => {
                  onPickingChange(false);
                  void ipc.moveInboxToNote(item.id, t.id);
                }}
              >
                {t.title || "(名前未設定)"}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="ib-row-btns">
          <button onClick={() => void ipc.promoteInbox(item.id)}>やる</button>
          <button onClick={() => onPickingChange(true)}>タスクのメモへ</button>
          <button className="danger" onClick={() => void ipc.trashTask(item.id)}>
            捨てる
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Enter でもフォーカスが外れても確定し、Escape で取り消す 1 行入力。
 *
 * 確定は 1 度だけ走るよう ref で見張る。Enter で確定した直後に
 * アンマウントされて blur が走ると、二重に登録されてしまう。
 */
function InlineInput({
  initial = "",
  placeholder,
  className,
  onCommit,
  onCancel,
}: {
  initial?: string;
  placeholder?: string;
  className?: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const v = value.trim();
    if (commit && v) onCommit(v);
    else onCancel();
  };

  return (
    <input
      autoFocus
      className={className}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
    />
  );
}

/**
 * 複数行を受ける版のその場編集。一時メモ用。
 *
 * 一時メモは貼り付けた依頼文がそのまま入っていることがあるので、
 * 1 行の input では書き直せない。Enter は確定、改行は Shift+Enter —
 * Quick Capture と同じ扱いに揃えてある。
 */
function InlineArea({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // 中身の高さに合わせる。貼り付けた文章が枠に隠れると直せない
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const v = value.trim();
    if (commit && v) onCommit(v);
    else onCancel();
  };

  return (
    <textarea
      autoFocus
      ref={ref}
      className="ib-row-input"
      rows={1}
      value={value}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          finish(true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
        }
      }}
    />
  );
}

function TaskRow({
  task,
  isSub,
  isCurrent,
  onToggleDone,
  onSelect,
  onRename,
  titleEditing,
  onTitleEditingChange,
  onSetDue,
  dueEditing,
  onDueEditingChange,
  noteOpen,
  onNoteOpenChange,
  onAddSub,
  onDemote,
  onDelete,
  waitingEditing,
  onWaitingEditingChange,
  dragging,
  dropZone,
  onDragStart,
  onDragEnd,
  onDragOverZone,
  onDropHere,
}: {
  task: Task;
  isSub?: boolean;
  isCurrent: boolean;
  onToggleDone: () => void;
  onSelect: () => void;
  onRename: (title: string) => void;
  titleEditing: boolean;
  onTitleEditingChange: (open: boolean) => void;
  onSetDue: (due: string) => void;
  dueEditing: boolean;
  onDueEditingChange: (open: boolean) => void;
  noteOpen: boolean;
  onNoteOpenChange: (open: boolean) => void;
  onAddSub?: () => void;
  onDemote: () => void;
  onDelete: () => void;
  waitingEditing: boolean;
  onWaitingEditingChange: (open: boolean) => void;
  dragging: boolean;
  dropZone: DropZone | null;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDragOverZone: (zone: DropZone) => void;
  onDropHere: () => void;
}) {
  const done = task.status === "done";
  const rowRef = useRef<HTMLDivElement>(null);
  const cls = [
    "tk-row",
    isSub ? "is-sub" : "",
    isCurrent ? "is-current" : "",
    done ? "is-done" : "",
    // カレンダーだけが宙に浮いて見えないよう、どの行のものかを行側でも示す
    dueEditing ? "is-picking" : "",
    task.status === "waiting" ? "is-waiting" : "",
    dragging ? "is-dragging" : "",
    dropZone ? `drop-${dropZone}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  /** 縦位置から当たり所を決める。上下の端は挿入、中央は入れ子 */
  const zoneAt = (e: React.DragEvent<HTMLDivElement>): DropZone => {
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientY - box.top) / box.height;
    if (ratio < 0.3) return "before";
    if (ratio > 0.7) return "after";
    return "into";
  };

  return (
    <>
    {/* 行のどこをダブルクリックしても「次にやる」に指定できる。
        名前の上だけは編集を優先させるので、そちらで伝播を止めている。 */}
    <div
      className={cls}
      ref={rowRef}
      onDoubleClick={onSelect}
      onDragOver={(e) => {
        // preventDefault を呼ばないと、この要素は落とせない場所のままになる
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        onDragOverZone(zoneAt(e));
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDropHere();
      }}
    >
      {/* 掴む場所は限定する。行ごと掴めるようにすると、名前のクリックや
          文字の選択と取り合いになる */}
      <span
        className="tk-grip"
        title="ドラッグで並べ替え (中央に落とすとサブタスク)"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", task.id);
          if (rowRef.current) e.dataTransfer.setDragImage(rowRef.current, 12, 12);
          onDragStart();
        }}
        onDragEnd={onDragEnd}
      >
        ⠿
      </span>
      {/* 丸にしてあるのは、四角いチェックボックスが「行の選択」に
          見えてしまうため。選択 (= 次にやる 1 件) は右の「これをやる」と
          行の左端の帯で示す */}
      <button
        className="tk-check"
        onClick={onToggleDone}
        title={done ? "未完了に戻す" : "完了にする (選択ではありません)"}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="3.4"
        >
          <path d="M4.5 12.5l5 5 10-11" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <div className="tk-main">
        {titleEditing ? (
          <InlineInput
            className="tk-title-input"
            initial={task.title}
            placeholder="タスク名を入力して Enter"
            onCommit={(title) => {
              onTitleEditingChange(false);
              onRename(title);
            }}
            onCancel={() => onTitleEditingChange(false)}
          />
        ) : (
          <div
            className={`tk-title${task.title ? "" : " is-unnamed"}`}
            title="クリックで名前を変更"
            onClick={() => onTitleEditingChange(true)}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {task.title || "(名前未設定)"}
          </div>
        )}
        {task.status === "waiting" && !waitingEditing && (
          <div
            className="tk-waiting"
            title="クリックで待ちの内容を変更"
            onClick={() => onWaitingEditingChange(true)}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <span className="tk-waiting-tag">待ち</span>
            {task.waitingFor && <span className="tk-waiting-for">{task.waitingFor}</span>}
            {task.waitingUntil && (
              <span className={`tk-waiting-until is-${dueState(task.waitingUntil) ?? "later"}`}>
                {formatDue(task.waitingUntil)} まで
              </span>
            )}
          </div>
        )}
        {(task.due || task.note || (!isSub && task.actualPomodoros > 0)) && (
          <div className="tk-meta">
            {task.due && (
              <span className={`tk-due is-${dueState(task.due) ?? "later"}`}>
                期限 {formatDue(task.due)}
              </span>
            )}
            {!isSub && task.actualPomodoros > 0 && <span>🍅 {task.actualPomodoros}</span>}
            {task.note && !noteOpen && (
              <button className="tk-note-peek" onClick={() => onNoteOpenChange(true)}>
                📝 {noteSummary(task.note, 44)}
              </button>
            )}
          </div>
        )}
      </div>

      <div className="tk-actions" onDoubleClick={(e) => e.stopPropagation()}>
        {!done && (
          <button
            className={`tk-btn${isCurrent ? " is-on" : ""}`}
            onClick={onSelect}
            title="このタスクを「次にやる 1 件」にする"
          >
            {isCurrent ? "選択中" : "これをやる"}
          </button>
        )}
        {dueEditing ? (
          <DueInput
            initial={task.due ?? ""}
            onCommit={(due) => {
              onSetDue(due);
              onDueEditingChange(false);
            }}
            onCancel={() => onDueEditingChange(false)}
          />
        ) : (
          <button
            className={`tk-btn${task.due ? " is-on" : ""}`}
            onClick={() => onDueEditingChange(true)}
            title="期限を設定 (「次にやる」候補の並び順に使われます)"
          >
            期限
          </button>
        )}
        {/* Focus View と同じ絵を添える。集中中に押したボタンが一覧の
            どれなのか、毎回文字を読み直させないため */}
        <button
          className={`tk-btn${task.note ? " is-on" : ""}`}
          onClick={() => onNoteOpenChange(!noteOpen)}
          title="メモ (依頼文や URL の貼り付け)"
        >
          <NoteIcon size={12} />
          メモ
        </button>
        {onAddSub && (
          <button className="tk-btn" onClick={onAddSub} title="サブタスクを追加">
            <SubtaskIcon size={13} />＋ サブ
          </button>
        )}
        {task.status === "waiting" ? (
          <button
            className="tk-btn is-on"
            onClick={() => void ipc.clearWaiting(task.id)}
            title="待ちを解いて、また手を付けられる状態に戻す"
          >
            <WaitIcon size={12} />
            待ち解除
          </button>
        ) : (
          <button
            className="tk-btn"
            onClick={() => onWaitingEditingChange(true)}
            title="相手の動きを待っている状態にする"
          >
            <WaitIcon size={12} />
            待ち
          </button>
        )}
        <button className="tk-btn" onClick={onDelete} title="ゴミ箱へ (戻せます)">
          削除
        </button>
      </div>
    </div>

    {waitingEditing && (
      <WaitingEditor
        task={task}
        isSub={isSub}
        onClose={() => onWaitingEditingChange(false)}
      />
    )}

    {noteOpen && (
      <NoteEditor
        task={task}
        isSub={isSub}
        onDemote={onDemote}
        onClose={() => onNoteOpenChange(false)}
      />
    )}
    </>
  );
}

/** 選択肢の刻み (分)。時と分が 1 つの並びで出るので、細かいと探す手間が増える */
const APPT_STEP_MINUTES = 15;
/** 選択肢を並べる範囲 (時間) */
const APPT_RANGE_HOURS = 10;

/**
 * 次の予定の時刻入力。
 *
 * 標準の時刻ピッカーは `step` を無視して分を 1 分刻みで並べるので、
 * 選択肢は自前で出す。会議の時刻はたいてい 5 分の倍数で、1 分単位の
 * 選択肢は探す手間が増えるだけ。手入力は 1 分単位のまま通す。
 */
function ApptInput({ value, onPick }: { value: string; onPick: (time: string) => void }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

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
    at.setMinutes(Math.ceil((at.getMinutes() + 1) / APPT_STEP_MINUTES) * APPT_STEP_MINUTES);
    const count = (APPT_RANGE_HOURS * 60) / APPT_STEP_MINUTES;
    return Array.from({ length: count }, () => {
      const label = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
      at.setMinutes(at.getMinutes() + APPT_STEP_MINUTES);
      return label;
    });
  }, [open]);

  return (
    <div className="mg-appt-box" ref={boxRef}>
      <input
        id="appt"
        type="time"
        value={value}
        onChange={(e) => onPick(e.target.value)}
      />
      <button
        className="mg-appt-open"
        title={`${APPT_STEP_MINUTES} 分刻みで選ぶ (手入力は 1 分単位)`}
        onClick={() => setOpen((v) => !v)}
      >
        ▾
      </button>
      {open && (
        <div className="mg-appt-list">
          {options.map((t) => (
            <button
              key={t}
              className={t === value ? "is-on" : ""}
              onClick={() => {
                onPick(t);
                setOpen(false);
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

/**
 * 期限の入力。開いた瞬間にカレンダーを出す。
 *
 * タスクを追加した直後にここが開くので、期限を入れるためだけに行を探して
 * クリックする手間が要らない。何も選ばずに離れれば期限なしのまま。
 */
function DueInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (due: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // showPicker はユーザー操作の直後でないとブラウザに拒否される。
    // 弾かれても手入力できるので、失敗は無視してよい。
    try {
      (el as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
    } catch {
      /* 手入力に任せる */
    }
  }, []);

  return (
    <span className="tk-date-box">
      <input
        ref={ref}
        type="date"
        className="tk-date"
        defaultValue={initial}
        onChange={(e) => onCommit(e.target.value)}
        onBlur={onCancel}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      {initial && (
        <button
          className="tk-date-clear"
          title="期限を外す"
          // mousedown で処理する。click を待つと先に blur が走って閉じてしまう
          onMouseDown={(e) => {
            e.preventDefault();
            onCommit("");
          }}
        >
          ×
        </button>
      )}
    </span>
  );
}

/**
 * 待ちの設定。
 *
 * 要因といつまで待つかを一緒に取る。要因だけだと後から見て何を催促すれば
 * よいか分からず、日付だけだと誰に言えばよいか分からない。
 */
function WaitingEditor({
  task,
  isSub,
  onClose,
}: {
  task: Task;
  isSub?: boolean;
  onClose: () => void;
}) {
  const [reason, setReason] = useState(task.waitingFor ?? "");
  const [until, setUntil] = useState(task.waitingUntil ?? "");
  const dateRef = useRef<HTMLInputElement>(null);
  const alreadyWaiting = task.status === "waiting";

  const save = (nextUntil = until) => void ipc.setWaiting(task.id, reason.trim(), nextUntil);

  // 既に待ちなら、外を押したときも書きかけを残す。
  // まだ待ちでないなら、押し間違いで待ちにしてしまわない。
  const boxRef = useDismissOnOutside(true, () => {
    if (alreadyWaiting) save();
    onClose();
  });

  /**
   * 要因を確定したら、その時点で保存してから日付へ移る。
   *
   * タスク追加と同じ流れ。先に保存しておけば、日付を入れずに離れても
   * 要因が消えない。
   */
  const toDate = () => {
    save();
    const el = dateRef.current;
    if (!el) return;
    el.focus();
    try {
      (el as HTMLInputElement & { showPicker?: () => void }).showPicker?.();
    } catch {
      /* 弾かれても手入力できる */
    }
  };

  return (
    <div className={`tk-waiting-edit${isSub ? " is-sub" : ""}`} ref={boxRef}>
      <input
        autoFocus
        value={reason}
        placeholder="何を待っている? (例: A 社の見積もり回答)"
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            toDate();
          }
          if (e.key === "Escape") onClose();
        }}
      />
      <label>
        <span>いつまで</span>
        <input
          ref={dateRef}
          type="date"
          value={until}
          onChange={(e) => {
            setUntil(e.target.value);
            save(e.target.value);
            onClose();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
              onClose();
            }
            if (e.key === "Escape") onClose();
          }}
        />
      </label>
      <button
        className="tk-btn is-on"
        onClick={() => {
          save();
          onClose();
        }}
      >
        {alreadyWaiting ? "保存" : "待ちにする"}
      </button>
    </div>
  );
}

/**
 * タスクのメモ。依頼のメール文や参照 URL を貼り付けておく場所。
 *
 * URL は編集中でも押せるよう、本文とは別に一覧で出す。webview 内で
 * 遷移させると困るので、開くのは既定のブラウザ。
 */
function NoteEditor({
  task,
  isSub,
  onDemote,
  onClose,
}: {
  task: Task;
  isSub?: boolean;
  onDemote: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(task.note ?? "");

  const save = () => {
    if (value !== (task.note ?? "")) void ipc.setNote(task.id, value);
  };

  // 欄外を押したら、書きかけを保存して閉じる
  const boxRef = useDismissOnOutside(true, () => {
    save();
    onClose();
  });

  return (
    <div className={`tk-note${isSub ? " is-sub" : ""}`} ref={boxRef}>
      <textarea
        autoFocus
        value={value}
        spellCheck={false}
        placeholder="依頼のメール文、参照 URL、調べたことなど"
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            save();
            onClose();
          }
        }}
      />
      <NoteLinks text={value} />
      <div className="tk-note-foot">
        <span>離れると自動保存 / Esc で閉じる</span>
        {/* 行に並べるほど頻繁には使わない。メモを開いた人はその中身を
            見ているので、畳んで一時メモに戻す判断もここでできる */}
        <div className="tk-note-foot-btns">
          <button
            className="tk-btn"
            onClick={onDemote}
            title="一時メモに戻す (名前・メモ・サブタスクが 1 つの文章に畳まれます)"
          >
            一時メモへ
          </button>
          <button
            className="tk-btn"
            onClick={() => {
              save();
              onClose();
            }}
          >
            閉じる
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 暗幕の濃さの段。生の % を打たせても加減が分からないので、名前で選ばせる。
 * 値は CSS の opacity にそのまま渡る。
 */
const DIM_LEVELS = [
  { value: 30, label: "薄め" },
  { value: 55, label: "ふつう" },
  { value: 75, label: "濃め" },
  { value: 90, label: "ほぼ真っ暗" },
];

function SettingsCard({
  initial,
  onClose,
  onSaved,
}: {
  initial: Settings;
  onClose: () => void;
  onSaved: (s: Settings) => void;
}) {
  const [s, setS] = useState<Settings>(initial);
  const num =
    (k: "focusMinutes" | "shortBreakMinutes" | "longBreakMinutes" | "longBreakEvery") =>
    (e: ChangeEvent<HTMLInputElement>) =>
      setS({ ...s, [k]: Math.max(1, Number(e.target.value) || 1) });

  return (
    <div className="mg-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mg-card">
        <h2>設定</h2>
        <div className="mg-field">
          <label>集中(分)</label>
          <input
            type="number"
            min={1}
            max={120}
            value={s.focusMinutes}
            onChange={num("focusMinutes")}
          />
        </div>
        <div className="mg-field">
          <label>休憩(分)</label>
          <input
            type="number"
            min={1}
            max={60}
            value={s.shortBreakMinutes}
            onChange={num("shortBreakMinutes")}
          />
        </div>
        <div className="mg-field">
          <label>長い休憩(分)</label>
          <input
            type="number"
            min={1}
            max={90}
            value={s.longBreakMinutes}
            onChange={num("longBreakMinutes")}
          />
        </div>
        <div className="mg-field">
          <label>長い休憩の間隔(ポモドーロ数)</label>
          <input
            type="number"
            min={1}
            max={12}
            value={s.longBreakEvery}
            onChange={num("longBreakEvery")}
          />
        </div>
        <div className="mg-field">
          <label>
            次の予定の前に空ける時間(分)
            <small>席を立つ時間と頭の切り替えの分</small>
          </label>
          <input
            type="number"
            min={0}
            max={30}
            value={s.appointmentBufferMinutes}
            onChange={(e) =>
              setS({ ...s, appointmentBufferMinutes: Math.max(0, Number(e.target.value) || 0) })
            }
          />
        </div>
        <div className="mg-field">
          <label>Quick Capture のホットキー</label>
          <input
            type="text"
            value={s.hotkey}
            spellCheck={false}
            onChange={(e) => setS({ ...s, hotkey: e.target.value })}
          />
        </div>

        <hr className="mg-sep" />

        <div className="mg-field">
          <label>集中中はタイマーを常に最前面に表示</label>
          <input
            type="checkbox"
            checked={s.alwaysOnTop}
            onChange={(e) => setS({ ...s, alwaysOnTop: e.target.checked })}
          />
        </div>
        <div className="mg-field">
          <label>
            Focus View を半透明にする
            <small>次回起動時に反映</small>
          </label>
          <input
            type="checkbox"
            checked={s.focusTransparent}
            onChange={(e) => setS({ ...s, focusTransparent: e.target.checked })}
          />
        </div>
        <div className="mg-field">
          <label>
            Focus View をモニタ 1 枚の全画面にする
            <small>広げる先は Focus View が今あるモニタ。補助モニタの視界を覆う用</small>
          </label>
          <input
            type="checkbox"
            checked={s.focusFullscreen}
            onChange={(e) => setS({ ...s, focusFullscreen: e.target.checked })}
          />
        </div>
        <div className="mg-field">
          <label>
            休憩中は画面全体を暗くする
            <small>クリックは素通しするので、続けようと思えば続けられる</small>
          </label>
          <input
            type="checkbox"
            checked={s.breakDim}
            onChange={(e) => setS({ ...s, breakDim: e.target.checked })}
          />
        </div>
        {s.breakDim && (
          <div className="mg-field mg-field-sub">
            <label>暗さ</label>
            <select
              value={s.breakDimStrength}
              onChange={(e) => setS({ ...s, breakDimStrength: Number(e.target.value) })}
            >
              {DIM_LEVELS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="mg-field">
          <label>Focus View に一時メモの件数を表示</label>
          <input
            type="checkbox"
            checked={s.showInboxCount}
            onChange={(e) => setS({ ...s, showInboxCount: e.target.checked })}
          />
        </div>
        <div className="mg-field">
          <label>フェーズ終了時に通知</label>
          <input
            type="checkbox"
            checked={s.soundEnabled}
            onChange={(e) => setS({ ...s, soundEnabled: e.target.checked })}
          />
        </div>
        <p className="mg-card-note">
          件数は既定で表示しません。残りが見えること自体が気を散らすためです。
        </p>

        <div className="mg-card-foot">
          <button className="btn" onClick={onClose}>
            キャンセル
          </button>
          <button className="btn btn-primary" onClick={() => void ipc.saveSettings(s).then(onSaved)}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

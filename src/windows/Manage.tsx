import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { listen } from "@tauri-apps/api/event";
import * as ipc from "../lib/ipc";
import { LinkedText, LinkedTextarea, noteSummary } from "../lib/NoteBody";
import { isTextField, record, redoLast, undoLast } from "../lib/undo";
import { focusStop, rowNavHandler, verticalNavHandler } from "../lib/keynav";
import { canNest, resolveDrop, type DropTarget, type DropZone } from "../lib/dnd";
import { CheckIcon, DueIcon, NoteIcon, PlusIcon, RemoveIcon, TrashIcon, WaitIcon } from "../lib/icons";
import { openPicker, useComposition } from "../lib/ime";
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
  const [subDraftFor, setSubDraftFor] = useState<string | null>(null);
  /** 期限を編集中の行。追加直後はその新しいタスクを指す */
  const [dueEditingFor, setDueEditingFor] = useState<string | null>(null);
  /** メモを開いている行 */
  const [noteOpenFor, setNoteOpenFor] = useState<string | null>(null);
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
  /** 一覧の欄外をダブルクリックして出した、追加用の箱 */
  /** タスクを書く箱をどこに出しているか。＋ は先頭、余白のダブルクリックは末尾 */
  const [taskDraft, setTaskDraft] = useState<"top" | "bottom" | null>(null);
  /** 一時メモの欄に出す、その場で書く箱 */
  /** 一時メモを書く箱。タスクと同じで、＋ は先頭、余白のダブルクリックは末尾 */
  const [inboxDraft, setInboxDraft] = useState<"top" | "bottom" | null>(null);
  /** 直前に戻した操作。数秒だけ見せる */
  const [undone, setUndone] = useState<string | null>(null);

  // Ctrl+Z で直前の操作を戻し、Ctrl+Y (Ctrl+Shift+Z) でやり直す。
  // 入力欄の中では文字の取り消しに譲る
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      const undo = key === "z" && !e.shiftKey;
      const redo = key === "y" || (key === "z" && e.shiftKey);
      if (!undo && !redo) return;
      if (isTextField(e.target)) return;
      e.preventDefault();
      void (undo ? undoLast() : redoLast()).then((label) => {
        if (label) setUndone(undo ? `元に戻しました: ${label}` : `やり直しました: ${label}`);
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!undone) return;
    const id = window.setTimeout(() => setUndone(null), 2400);
    return () => window.clearTimeout(id);
  }, [undone]);

  /** 箱から追加する。出した場所 (先頭 / 末尾) にそのまま入る。
      続けて期限を聞く — 期限を入れるためだけに行を探して 2 クリックする
      手間を省く。入れなければ期限なしのまま */
  const addFromDraft = async (title: string) => {
    const atTop = taskDraft === "top";
    setTaskDraft(null);
    const task = await ipc.createTask(title, "todo", null, atTop);
    record("追加", () => ipc.trashTask(task.id), () => ipc.restoreTask(task.id));
    setDueEditingFor(task.id);
  };
  /** 次の予定 (RFC3339)。会議までに 1 本入るかの判断に使う */
  const [appointment, setAppointment] = useState<string | null>(null);
  /** 入らないと分かっていて、それでも始めるとき */
  const [ignoreAppointment, setIgnoreAppointment] = useState(false);
  /** 残り時間の表示を進めるためだけの時計 */
  const [now, setNow] = useState(() => Date.now());
  /** 期限の入力を閉じたあと、続けて打てるよう追加欄に戻る */

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

  const plan = useMemo(
    () => (appointment && settings ? planUntil(new Date(appointment).getTime(), now, settings) : null),
    [appointment, settings, now],
  );
  /** 予定までに 1 本も入らない。始める前に止める */
  const blocked = plan !== null && plan.fits === 0 && !ignoreAppointment;
  /**
   * 短い集中なら予定までに入るか。
   *
   * 標準の 1 本は入らなくても短い方なら入ることがある。同じ「入らない」で
   * 両方止めてしまうと、残り 12 分で 10 分の助走も始められなくなる。
   */
  const shortPlan = useMemo(
    () =>
      appointment && settings
        ? planUntil(new Date(appointment).getTime(), now, {
            ...settings,
            focusMinutes: settings.shortFocusMinutes,
          })
        : null,
    [appointment, settings, now],
  );
  const shortBlocked = shortPlan !== null && shortPlan.fits === 0 && !ignoreAppointment;

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

  const closeDueEditor = () => setDueEditingFor(null);

  const toggleDone = async (t: Task) => {
    const was = t.status;
    const next = was === "done" ? "todo" : "done";
    await ipc.setTaskStatus(t.id, next);
    record(
      next === "done" ? "完了" : "未完了に戻す",
      () => ipc.setTaskStatus(t.id, was),
      () => ipc.setTaskStatus(t.id, next),
    );
  };

  const rename = async (t: Task, title: string) => {
    if (title !== t.title) {
      const was = t.title;
      await ipc.updateTask(t.id, { title });
      record(
        "名前の変更",
        () => ipc.updateTask(t.id, { title: was }),
        () => ipc.updateTask(t.id, { title }),
      );
    }
    // 追加のときと同じく、名前を確定した流れでそのまま期限を聞く。
    // 期限が既にあるなら、名前を直しただけなので聞かない
    if (!t.due) setDueEditingFor(t.id);
  };

  /** 空文字を渡すと期限が外れる */
  const setDue = async (t: Task, due: string) => {
    if ((t.due ?? "") === due) return;
    const was = t.due ?? "";
    await ipc.updateTask(t.id, { due });
    record(
      due ? "期限の変更" : "期限を外す",
      () => ipc.updateTask(t.id, { due: was }),
      () => ipc.updateTask(t.id, { due }),
    );
  };

  const trashWithUndo = async (t: Task) => {
    await ipc.trashTask(t.id);
    record("削除", () => ipc.restoreTask(t.id), () => ipc.trashTask(t.id));
  };

  /** 並べ替えの逆手順に要る「元の親と、元の前の兄弟」 */
  const placementOf = (id: string) => {
    const me = tasks.find((t) => t.id === id);
    if (!me) return null;
    const siblings = tasks
      .filter((t) => (t.parentId ?? null) === (me.parentId ?? null) && t.status !== "inbox")
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const i = siblings.findIndex((t) => t.id === id);
    return { parentId: me.parentId ?? null, afterId: i > 0 ? siblings[i - 1].id : null };
  };

  const move = async (id: string, parentId: string | null, afterId: string | null) => {
    const was = placementOf(id);
    await ipc.moveTask(id, parentId, afterId);
    if (was) {
      record(
        "並べ替え",
        () => ipc.moveTask(id, was.parentId, was.afterId),
        () => ipc.moveTask(id, parentId, afterId),
      );
    }
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
    const to = resolveDrop(tasks, id, target);
    if (to) await move(id, to.parentId, to.afterId);
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
    await move(id, null, parents[parents.length - 1] ?? null);
  };

  const select = (id: string) => void ipc.setCurrentTask(id === currentId ? null : id);
  /** 選択を外し、focus はその行に置く */
  const deselect = () => {
    if (!currentId) return;
    refocus.current = { row: currentId };
    void ipc.setCurrentTask(null);
  };

  const firstRow = (selector: string) => document.querySelector<HTMLElement>(selector) ?? undefined;

  /** キーボードで選んだ後の focus の行き先。一覧が描き直された後に当てる */
  const refocus = useRef<{ row?: string; start?: boolean } | null>(null);
  useEffect(() => {
    const to = refocus.current;
    if (!to) return;
    refocus.current = null;
    const start = document.querySelector<HTMLButtonElement>(".btn-start");
    // 開始ボタンが押せないとき (次の予定までに入らない等) は行に留まる
    const target =
      to.start && start && !start.disabled
        ? start
        : document.querySelector<HTMLElement>(`[data-task-id="${to.row}"]`);
    focusStop(target ?? undefined);
  }, [tasks, currentId]);

  // ↑ ↓ は画面を 2 つの縦の列と見て、その列で上下にあるものへ渡る。
  // 左の列: 設定 → 一時メモの ＋ → 一時メモの行 → 次の予定。
  // 右の列: 設定 → タスクの ＋ → タスクの行 → 待ち / 完了の引き出し
  // (開いていればその行も) → 開始ボタン
  const verticalNav = useMemo(
    () =>
      verticalNavHandler(
        [
          {
            within: ".mg-pane-inbox, .mg-appt",
            stops: ".btn-settings, .mg-pane-inbox .mg-add-btn, .mg-pane-inbox .ib-row:not(.ib-draft), #appt",
          },
          {
            within: ".mg-shell",
            stops:
              ".btn-settings, .mg-pane-tasks .mg-add-btn, .mg-pane-tasks .tk-row:not(.tk-draft), .mg-pane-tasks .mg-drawer-toggle, .btn-start",
            // タスクを選んでいなければ開始ボタンは押せないので、次の予定へ
            belowEnd: "#appt",
          },
        ],
        // どこにも止まっていなければ、一番上の「設定」から
        { first: ".btn-settings" },
      ),
    [],
  );
  // document に付ける。どこにも focus が無いとき (target が body) の
  // キー入力は React の木に届かないため。行の中の ← → Enter は一覧側が
  // 先に受けて止めるので、ここには ↑ ↓ だけが来る
  useEffect(() => {
    document.addEventListener("keydown", verticalNav);
    return () => document.removeEventListener("keydown", verticalNav);
  }, [verticalNav]);

  // 追加の箱。先頭にも末尾にも同じものを出す
  const inboxDraftBox = (
    <div className="ib-row ib-draft">
      <InlineArea
        initial=""
        placeholder="一時メモを書いて Enter (改行は Shift+Enter)"
        commitOnBlur={false}
        onCommit={(text) => {
          const atTop = inboxDraft === "top";
          setInboxDraft(null);
          void ipc
            .quickCapture(text, atTop)
            .then((memo) =>
              record(
                "一時メモの追加",
                () => ipc.trashTask(memo.id),
                () => ipc.restoreTask(memo.id),
              ),
            );
        }}
        onCancel={() => setInboxDraft(null)}
      />
    </div>
  );
  const taskDraftBox = (
    // 行と同じ骨組みで出す。つかみ手とチェックの席を空けておくと、
    // 入力欄の左端が上の行のタスク名と揃う
    <div className="tk-row tk-draft">
      <span className="tk-grip" aria-hidden="true" />
      <span className="tk-check is-ghost" aria-hidden="true" />
      <div className="tk-main">
        <InlineInput
          className="tk-title-input"
          placeholder="タスクを追加して Enter"
          commitOnBlur={false}
          onCommit={(title) => void addFromDraft(title)}
          onCancel={() => setTaskDraft(null)}
        />
      </div>
    </div>
  );

  /** 親 1 件とその配下を描く。一覧と「完了したタスク」の引き出しで共用する */
  const renderBundle = ({ task, subs }: { task: Task; subs: Task[] }) => {
    const row = (t: Task, isSub: boolean) => (
      <TaskRow
        key={t.id}
        task={t}
        isSub={isSub}
        isCurrent={t.id === currentId}
        checkSelects={settings?.checkSelects ?? false}
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
        onDelete={() => void trashWithUndo(t)}
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
                void ipc
                  .createTask(title, "todo", task.id)
                  .then((sub) =>
                    record(
                      "サブタスクの追加",
                      () => ipc.trashTask(sub.id),
                      () => ipc.restoreTask(sub.id),
                    ),
                  );
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

        <button className="btn btn-settings" onClick={() => setShowSettings(true)}>
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
              title={`一時メモを書く (どこからでも ${settings?.hotkey ?? "Ctrl+Alt+Space"})`}
              onClick={() => setInboxDraft("top")}
            >
              <PlusIcon />
            </button>
          </div>
          <div
            className="mg-scroll"
            // 矢印キーで行とボタンを渡り歩ける。Enter で書き直しに入る
            onKeyDown={(e) =>
              rowNavHandler(e.currentTarget, {
                row: ".ib-row:not(.ib-draft)",
                button: ".ib-row-btns button",
                onEnter: (row) => row.querySelector<HTMLElement>(".ib-row-title")?.click(),
                // 右端のボタンからさらに → で、タスク一覧へ渡る
                onRightEnd: () => focusStop(firstRow(".mg-pane-tasks .tk-row:not(.tk-draft)")),
              })(e)
            }
            // 余白をダブルクリックしても書ける。タスク一覧と同じ作法
            onDoubleClick={(e) => {
              const el = e.target as HTMLElement;
              if (el === e.currentTarget || el.classList.contains("mg-empty")) {
                setInboxDraft("bottom");
              }
            }}
          >
            {/* 管理画面の中では、別の窓を出すより、その場に書ける箱を出す。
                視線を動かさずに済むし、外れたらやめられる。
                出した場所 (先頭 / 末尾) にそのまま入る */}
            {inboxDraft === "top" && inboxDraftBox}
            {inbox.length === 0 && !inboxDraft ? (
              <div className="mg-empty">
                <kbd>{settings?.hotkey ?? "Ctrl+Alt+Space"}</kbd> で追加 / ここをダブルクリック
              </div>
            ) : (
              inbox.map((t) => (
                <InboxRow key={t.id} item={t} />
              ))
            )}
            {inboxDraft === "bottom" && inboxDraftBox}
          </div>
        </section>

        {/* タスク一覧: ここでだけ全体を俯瞰する */}
        {/* 矢印キーで行とボタンを渡り歩ける (引き出しの中の行も)。
            Enter は行の上ならダブルクリックと同じ「次にやる 1 件」にする */}
        <section
          className="mg-pane mg-pane-tasks"
          onKeyDown={(e) =>
            rowNavHandler(e.currentTarget, {
              row: ".tk-row:not(.tk-draft)",
              button: ".tk-check, .tk-actions button",
              onEnter: (row) => {
                const id = row.dataset.taskId;
                if (!id) return;
                // 選んだら、そのまま開始ボタンへ進める (Enter → Enter で始められる)。
                // 選択を外したときは行に留まる。どちらも描き直しで focus が
                // 外れるので、描き直し後に当て直す
                refocus.current = { row: id, start: id !== currentId };
                select(id);
              },
              // 行の上で ← なら、一時メモの一覧へ渡る
              onLeft: () => focusStop(firstRow(".mg-pane-inbox .ib-row:not(.ib-draft)")),
              // 行の上で Esc なら、選んでいるタスクを外す (無ければ行から外れる)
              onEscape: () => {
                if (!currentId) return false;
                deselect();
                return true;
              },
            })(e)
          }
        >
          <div className="mg-pane-head">
            <span className="mg-pane-title">タスク</span>
            <span className="mg-pane-hint">タスクをダブルクリックで選択</span>
            {/* 常設の入力欄は置かない。一覧の余白のダブルクリックと同じ箱を
                出すだけ。一覧の先頭に空の欄が居座らないぶん、1 行ぶん広く使える */}
            <button className="mg-add-btn" title="タスクを追加" onClick={() => setTaskDraft("top")}>
              <PlusIcon />
            </button>
          </div>
          <div
            className="mg-scroll"
            // 行の外 (一覧の余白) をダブルクリックしたら、その場に追加の箱を出す。
            // 上の入力欄まで視線を戻さなくても、目の前で足せるようにする
            onDoubleClick={(e) => {
              const el = e.target as HTMLElement;
              if (el === e.currentTarget || el.classList.contains("mg-empty")) {
                setTaskDraft("bottom");
              }
            }}
          >
            {taskDraft === "top" && taskDraftBox}
            {tree.open.length === 0 && !taskDraft ? (
              <div className="mg-empty">＋ か、ここをダブルクリックで追加</div>
            ) : (
              tree.open.map(renderBundle)
            )}
            {taskDraft === "bottom" && taskDraftBox}
            {/* 最下段に置くための逃げ道。掴んでいる間だけ受ける。
                行の下端に落とすと最後の行と同じ階層になるので、最後の親が
                サブタスクを持っていると親タスクとして最後に置けない。

                見た目は出さず、かかったときに挿入線だけを引く。行に落とす
                ときと同じ線で、幅が行の全幅なので「親タスクとして入る」と
                いうことも線そのものが伝える。 */}
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
              />
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

        </section>
      </div>

      {trashOpen && <TrashPanel items={trash} onClose={() => setTrashOpen(false)} />}

      {undone && <div className="mg-undone">{undone}</div>}

      {/* 開始ボタンは下端の右寄せ。OK ボタンと同じ位置に置いて、
          その左隣に「何を始めるのか」を並べる */}
      <footer className="mg-foot">
        {/* ゴミ箱は一時メモとタスクの両方から入るので、どちらの領域でもない
            下の帯の左端に置く。絵と数だけの小さな印にして、普段は目に入らない
            ようにする。空のときは押すものが無いので出さない */}
        {trash.length > 0 && (
          <button
            className={`mg-trash-btn${trashOpen ? " is-open" : ""}`}
            title={`ゴミ箱 ${trash.length} 件 — 削除した一時メモとタスク (戻せます)`}
            onClick={() => setTrashOpen((v) => !v)}
          >
            <TrashIcon /> <b>{trash.length}</b>
          </button>
        )}
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
            <span className="mg-next-label">タスクをダブルクリックで選択</span>
          )}
        </div>

        {blocked && currentTask && (
          <button className="mg-override" onClick={() => setIgnoreAppointment(true)}>
            予定を無視して開始
          </button>
        )}
        {/* 助走用の短い集中。ポモドーロと対等には置かない。
            25 分が重くて着手できないときのための脇道で、これが主役に
            なってしまうと実績の単位が育たなくなる。 */}
        {currentTask && (
          <button
            className="btn btn-quiet btn-short"
            onClick={() => void ipc.timerStartShort(currentId)}
            disabled={shortBlocked}
            title={
              shortBlocked
                ? "次の予定までに短い集中も終わりません"
                : "まず短く始める。ポモドーロとしては数えません"
            }
          >
            短い {settings?.shortFocusMinutes ?? 10} 分
          </button>
        )}
        <button
          className="btn btn-primary btn-start"
          onClick={() => void ipc.timerStart(currentId)}
          // Esc で選択を外す。ボタンは押せなくなるので、focus は外した行へ戻す
          onKeyDown={(e) => {
            if (e.key === "Escape" && currentId) {
              e.preventDefault();
              deselect();
            }
          }}
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
 * 「タスクへ」で 1 行目を名前・全文をメモにしたタスクになる。
 * 既にあるタスクのメモへ合流させる道は以前あったが、使われず外した —
 * 一時メモは「後で判断する」ための箱で、判断は「タスクにする / 消す」の 2 つで足りる。
 */
function InboxRow({ item }: { item: Task }) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="ib-row" tabIndex={0}>
      {/* 割り込みは急いで書き留めるものなので、誤字も言葉足らずも残る。
          タスク名と同じく、押せばその場で直せるようにしておく。
          複数行を貼ってあることがあるので textarea で受ける */}
      {editing ? (
        <InlineArea
          initial={item.title}
          onCommit={(text) => {
            setEditing(false);
            if (text !== item.title) {
              const was = item.title;
              void ipc
                .updateTask(item.id, { title: text })
                .then(() =>
                  record(
                    "一時メモの書き直し",
                    () => ipc.updateTask(item.id, { title: was }),
                    () => ipc.updateTask(item.id, { title: text }),
                  ),
                );
            }
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div
          className="ib-row-title"
          title="クリックで書き直す"
          onClick={() => setEditing(true)}
        >
          {/* 貼り付けた文章に URL やパスが混ざっていることがある。
              色を付けて、そこだけ押せば開くようにしておく */}
          <LinkedText text={item.title} />
        </div>
      )}

      <div className="ib-row-btns">
          <button
            onClick={() => {
              // 同じ行が名前つきのタスクに変わるので、戻すときは一時メモの形に戻す
              const text = item.title;
              void ipc
                .promoteInbox(item.id)
                .then(() =>
                  record(
                    "一時メモをタスクにする",
                    () => ipc.updateTask(item.id, { status: "inbox", title: text, note: "" }),
                    () => ipc.promoteInbox(item.id),
                  ),
                );
            }}
          >
            タスクへ
          </button>
          <button
            className="danger"
            onClick={() =>
              void ipc
                .trashTask(item.id)
                .then(() =>
                  record(
                    "一時メモを捨てる",
                    () => ipc.restoreTask(item.id),
                    () => ipc.trashTask(item.id),
                  ),
                )
            }
          >
            削除
          </button>
        </div>
    </div>
  );
}

/**
 * ゴミ箱。一時メモとタスクの両方がここに入る。
 *
 * ゴミ箱に入ると見た目が同じ 1 行になり、元が何だったのか分からない。
 * 戻したときにどこへ現れるかが違うので、一時メモとタスクに分けて並べる。
 * 下の帯のボタンの上に出す小さな板で、外を押せば閉じる。
 */
function TrashPanel({ items, onClose }: { items: Task[]; onClose: () => void }) {
  const ref = useDismissOnOutside(true, onClose);
  const memos = items.filter((t) => t.prevStatus === "inbox");
  const tasks = items.filter((t) => t.prevStatus !== "inbox");

  const group = (label: string, list: Task[]) =>
    list.length > 0 && (
      <div className="tr-group">
        <div className="tr-group-head">
          {label} <span>{list.length}</span>
        </div>
        {list.map((t) => (
          <div className="tr-row" key={t.id}>
            <span className="tr-row-title" title={t.title}>
              {t.title || "(名前未設定)"}
            </span>
            <button className="tk-btn" onClick={() => void ipc.restoreTask(t.id)}>
              戻す
            </button>
            <button className="tk-btn" onClick={() => void ipc.deleteTask(t.id)}>
              完全に削除
            </button>
          </div>
        ))}
      </div>
    );

  return (
    <div className="tr-panel" ref={ref}>
      {group("一時メモ", memos)}
      {group("タスク", tasks)}
      <div className="tr-foot">
        <span>アプリを終了すると空になります</span>
        <button className="tk-btn" onClick={() => void ipc.emptyTrash().then(onClose)}>
          空にする
        </button>
      </div>
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
  commitOnBlur = true,
  onCommit,
  onCancel,
}: {
  initial?: string;
  placeholder?: string;
  className?: string;
  /** 欄外を押したとき確定するか。新規追加の箱は、外れたらやめる */
  commitOnBlur?: boolean;
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
      onBlur={() => finish(commitOnBlur)}
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
  placeholder,
  commitOnBlur = true,
  onCommit,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
  /** 欄外を押したとき確定するか。新しく書く箱は、外れたらやめる */
  commitOnBlur?: boolean;
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
    <LinkedTextarea
      autoFocus
      areaRef={ref}
      className="ib-row-input"
      rows={1}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(commitOnBlur)}
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

/** 手掛かり同士の間隔。CSS の gap と合わせる */
const SIDE_GAP = 8;
/** ボタンの右端の寄せ。CSS の right と合わせる */
const BUTTONS_RIGHT = 8;
/** 期限の「 まで」の幅。2 文字固定なので測らない */
const MADE_WIDTH = 22;
/** メモのアイコンと、その後ろの間隔 */
const NOTE_ICON_WIDTH = 17 + 4;

function TaskRow({
  task,
  isSub,
  isCurrent,
  checkSelects,
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
  /** チェックボックスが「選ぶ」の意味のとき true。完了は行のボタンで行う */
  checkSelects: boolean;
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
  /** 名前のクリックを編集に変えるまでの待ち。ダブルクリックが来たら取り消す */
  const editTimer = useRef<number | null>(null);

  const lineRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const dueRef = useRef<HTMLElement>(null);
  const tomatoRef = useRef<HTMLSpanElement>(null);
  const noteTextRef = useRef<HTMLSpanElement>(null);
  const hasDue = Boolean(task.due);
  const hasTomato = !isSub && task.actualPomodoros > 0;
  const hasNote = Boolean(task.note) && !noteOpen;
  const hasSide = !titleEditing && (hasDue || hasTomato || hasNote);

  /**
   * 行の中の寸法を実測して、名前の幅の上限と、手掛かりの段数を決める。
   *
   * 定数で見積もると必ずどこかに余りが出る (ボタンは 190px なのに 196px
   * 空ける、など)。ここは「ぴったり」が要求なので、ボタン・日付・🍅・
   * メモの実際の幅を測る。
   *
   * - titleMax: 名前に使わせる幅の上限。ボタンを出しても、手掛かりの
   *   最小の形 (日付、または 🍅 とメモのアイコン) が残るところまで。
   *   日付は「まで」込み。落とせば 22px 稼げるが、落としても余る行と
   *   落とさないと入らない行の境目が見た目で分からず、かえって不揃いに
   *   見える。
   * - avail: 名前の右に、ボタンを出しても残る幅。1 段か 2 段かはこれで
   *   決める。ボタンの幅を最初から引いてあるので、ホバーの前後で判断が
   *   変わらない — 変わると行の高さが跳ねる。
   */
  const [titleMax, setTitleMax] = useState<number | undefined>(undefined);
  const [avail, setAvail] = useState(Number.POSITIVE_INFINITY);
  const [noteNatural, setNoteNatural] = useState(0);
  const [dueFull, setDueFull] = useState(0);
  const [tomatoW, setTomatoW] = useState(0);
  /** ボタンの実際の幅。ホバー時に手掛かりを縮める量として CSS に渡す */
  const [buttonsWidth, setButtonsWidth] = useState(196);

  useLayoutEffect(() => {
    const line = lineRef.current;
    const title = titleRef.current;
    const actions = actionsRef.current;
    if (!line || !title || !actions) return;

    const measure = () => {
      const lineW = line.clientWidth;
      const buttonsW = actions.offsetWidth + BUTTONS_RIGHT;
      const dueDateW = dueRef.current?.offsetWidth ?? 0;
      const tomato = tomatoRef.current?.offsetWidth ?? 0;
      const noteW = noteTextRef.current
        ? noteTextRef.current.scrollWidth + NOTE_ICON_WIDTH
        : 0;

      // 手掛かりの最小の形。2 段のどちらか広い方
      const sideMin = Math.max(
        hasDue ? dueDateW + MADE_WIDTH : 0,
        (hasTomato ? tomato : 0) + (hasTomato && hasNote ? SIDE_GAP : 0) + (hasNote ? 17 : 0),
      );
      const reserve = buttonsW + SIDE_GAP + (hasSide ? sideMin + SIDE_GAP : 0);
      setTitleMax(Math.max(80, lineW - reserve));
      setButtonsWidth(buttonsW);

      const titleW = title.getBoundingClientRect().width;
      setAvail(lineW - titleW - SIDE_GAP - buttonsW);
      setDueFull(hasDue ? dueDateW + MADE_WIDTH : 0);
      setTomatoW(tomato);
      setNoteNatural(noteW);
    };

    measure();
    // 名前の上限を当てると名前の箱が変わるので、名前も見張って測り直す
    const observer = new ResizeObserver(measure);
    observer.observe(line);
    observer.observe(title);
    return () => observer.disconnect();
  }, [task.title, task.note, task.due, task.actualPomodoros, titleEditing, hasSide, hasDue, hasTomato, hasNote]);

  // 1 段に収めるのに要る幅。無いものは数えない。メモはアイコンだけ数える —
  // ボタンを出している間はアイコンに縮んでよく、文字は入るなら出す程度
  const oneLineNeed =
    dueFull +
    (hasTomato ? tomatoW : 0) +
    (hasNote ? Math.min(noteNatural, 17) : 0) +
    SIDE_GAP * Math.max(0, [hasDue, hasTomato, hasNote].filter(Boolean).length - 1);
  const oneLine = avail >= oneLineNeed;
  const cls = [
    "tk-row",
    isSub ? "is-sub" : "",
    isCurrent ? "is-current" : "",
    done ? "is-done" : "",
    checkSelects ? "check-selects" : "",
    // カレンダーだけが宙に浮いて見えないよう、どの行のものかを行側でも示す
    dueEditing ? "is-picking" : "",
    task.status === "waiting" ? "is-waiting" : "",
    dragging ? "is-dragging" : "",
    dropZone ? `drop-${dropZone}` : "",
    titleEditing ? "is-editing" : "",
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
      // キーボードで行に止まれるように。矢印キーの動きは一覧側で受ける
      tabIndex={0}
      data-task-id={task.id}
      style={{ "--buttons": `${buttonsWidth}px` } as React.CSSProperties}
      onDoubleClick={() => {
        // 名前の上でダブルクリックすると、ブラウザが単語を選択した状態で
        // 届く。選択のつもりで押した人に青い反転を残さない
        window.getSelection()?.removeAllRanges();
        onSelect();
      }}
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
      {/* 完了と選択は色で分ける。緑がかったこの色が「済み」で、
          橙は「次にやる 1 件」。触ったときに出る色でどちらの操作なのかが
          分かるので、言葉で補う必要がない。
          設定でチェックの意味を「選ぶ」にしていれば、橙で光り、押すと
          次にやる 1 件になる。完了した行だけは、選べないので元のまま */}
      <button
        className="tk-check"
        onClick={checkSelects && !done ? onSelect : onToggleDone}
        title={
          done
            ? "未完了に戻す"
            : checkSelects
              ? isCurrent
                ? "選択を外す"
                : "このタスクを「次にやる 1 件」にする"
              : "完了にする"
        }
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
        {/* 名前と手掛かり (期限・🍅・メモ) を 1 行に畳む。別の行に分けると、
            1 件あたり 17px を常に使うことになり、スクロールせずに見渡せる
            件数がそのぶん減る */}
        <div className={`tk-line${hasSide ? " has-side" : ""}`} ref={lineRef}>
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
              ref={titleRef}
              style={titleMax !== undefined ? { maxWidth: titleMax } : undefined}
              className={`tk-title${task.title ? "" : " is-unnamed"}`}
              title="クリックで名前を変更 / ダブルクリックで選択"
              // 名前の上でもダブルクリックで選択できるようにする。行を薄くした
              // ぶん、名前以外の当たりが細くなった。1 回目のクリックで即座に
              // 編集に入ると 2 回目が入力欄に吸われるので、少しだけ待つ。
              onClick={(e) => {
                if (e.detail > 1) return; // ダブルクリックの 2 回目
                if (editTimer.current) window.clearTimeout(editTimer.current);
                editTimer.current = window.setTimeout(() => {
                  editTimer.current = null;
                  onTitleEditingChange(true);
                }, 220);
              }}
              onDoubleClick={() => {
                if (editTimer.current) window.clearTimeout(editTimer.current);
                editTimer.current = null;
                // 伝播させて、行のダブルクリック (= 選択) に乗せる
              }}
            >
              {task.title || "(名前未設定)"}
            </div>
          )}
          {/* 手掛かり (期限・🍅・メモ) はタスク名のすぐ右。名前が短くて幅が
              余っていれば 1 段に並べ、足りなければ期限 / 🍅+メモ の 2 段に
              する。期限は名前から離すと意識に上らないので、右端に寄せない。
              ボタンが出るときはその幅ぶんだけ縮み、縮むのはメモの文字と、
              入らないときだけ期限の「まで」 */}
          {hasSide && (
            <div className={`tk-side ${oneLine ? "is-one" : "is-two"}`}>
              {task.due && (
                <span className={`tk-due is-${dueState(task.due) ?? "later"}`}>
                  <b ref={dueRef}>{formatDue(task.due)}</b> まで
                </span>
              )}
              {(hasTomato || hasNote) && (
                <div className="tk-side-rest">
                  {hasTomato && (
                    <span className="tk-tomato" ref={tomatoRef}>
                      🍅 {task.actualPomodoros}
                    </span>
                  )}
                  {/* メモは残った幅のぶんだけ出す。入り切らなければ省略記号に
                      なり、最後はアイコンだけが残る */}
                  {hasNote && (
                    <button
                      className="tk-note-peek"
                      title={noteSummary(task.note ?? "", 200)}
                      onClick={() => onNoteOpenChange(true)}
                    >
                      <span className="tk-note-icon">📝</span>
                      <span className="tk-note-text" ref={noteTextRef}>
                        {noteSummary(task.note ?? "", 200)}
                      </span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
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
      </div>

      {/* 2 段に分ける。上段はタスクそのものの扱いを変えるもの
          (着手する / 待ちにする / 捨てる)、下段はタスクに情報を足すもの
          (期限 / メモ / サブタスク)。押す前に、どちらの種類の操作なのかが
          並びで分かる。

          段はタスクの中身によらず常に 2 段。ボタンが行によって上下に
          移ると、覚えた位置が使えなくなる。 */}
      <div className="tk-actions" ref={actionsRef} onDoubleClick={(e) => e.stopPropagation()}>
        <div className="tk-actions-row">
          {!done && !checkSelects && (
            <button
              className={`tk-btn ${isCurrent ? "is-on" : "tk-btn-wide"}`}
              onClick={onSelect}
              title="このタスクを「次にやる 1 件」にする"
            >
              {isCurrent ? "選択中" : "これをやる"}
            </button>
          )}
          {/* チェックが「選ぶ」のときは、完了をこのボタンが引き受ける */}
          {!done && checkSelects && (
            <button className="tk-btn tk-btn-wide tk-btn-done" onClick={onToggleDone} title="完了にする">
              <CheckIcon size={11} /> 完了
            </button>
          )}
          {task.status === "waiting" ? (
            <button
              className="tk-btn is-on"
              onClick={() => {
              const was = { waitingFor: task.waitingFor ?? "", waitingUntil: task.waitingUntil ?? "" };
              void ipc
                .clearWaiting(task.id)
                .then(() =>
                  record(
                    "待ちの解除",
                    () => ipc.setWaiting(task.id, was.waitingFor, was.waitingUntil),
                    () => ipc.clearWaiting(task.id),
                  ),
                );
            }}
              title="待ちを解いて、また手を付けられる状態に戻す"
            >
              <WaitIcon size={12} />
              解除
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
            <RemoveIcon size={11} />
            削除
          </button>
        </div>
        <div className="tk-actions-row">
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
              <DueIcon size={11} />
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
              ＋ サブ
            </button>
          )}
        </div>
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
      {/* 欄を押せば刻みの一覧が開く。そのまま打てば 1 分単位で入る */}
      <input
        id="appt"
        type="time"
        value={value}
        title={`押すか Space で ${APPT_STEP_MINUTES} 分刻みの一覧 (手入力は 1 分単位)`}
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
          if (!open) {
            // 閉じているときの ↑ ↓ は画面の移動 (親に任せる)。時刻の増減はさせない
            if (e.key === "ArrowDown" || e.key === "ArrowUp") e.preventDefault();
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
          }
        }}
      />
      {open && (
        <div className="mg-appt-list" ref={listRef}>
          {options.map((t, i) => (
            <button
              key={t}
              tabIndex={-1}
              className={`${t === value ? "is-on" : ""}${i === cursor ? " is-cursor" : ""}`}
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

  // カレンダーは onFocus 側で開く
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <span className="tk-date-box">
      <input
        ref={ref}
        type="date"
        className="tk-date"
        defaultValue={initial}
        onFocus={(e) => openPicker(e.currentTarget)}
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
  const { composing, handlers } = useComposition();

  /** 戻す手順はこの編集で 1 回だけ積む。途中の保存ごとに積むと、Ctrl+Z 1 回で半分しか戻らない */
  const recorded = useRef(false);
  /** 最後に保存した値。やり直しで使う */
  const latest = useRef({ reason: "", until: "" });
  const save = (nextUntil = until) => {
    latest.current = { reason: reason.trim(), until: nextUntil };
    void ipc.setWaiting(task.id, reason.trim(), nextUntil);
    if (recorded.current) return;
    recorded.current = true;
    const was = { status: task.status, waitingFor: task.waitingFor ?? "", waitingUntil: task.waitingUntil ?? "" };
    record(
      alreadyWaiting ? "待ちの変更" : "待ちにする",
      () =>
        was.status === "waiting"
          ? ipc.setWaiting(task.id, was.waitingFor, was.waitingUntil)
          : ipc.clearWaiting(task.id),
      // やり直しは、この編集で最後に保存した値を使う
      () => ipc.setWaiting(task.id, latest.current.reason, latest.current.until),
    );
  };

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
    // カレンダーは日付欄の onFocus 側で開く
    dateRef.current?.focus();
  };

  return (
    <div className={`tk-waiting-edit${isSub ? " is-sub" : ""}`} ref={boxRef}>
      <input
        autoFocus
        value={reason}
        placeholder="何を待っている? (例: A 社の見積もり回答)"
        onChange={(e) => setReason(e.target.value)}
        {...handlers}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !composing.current) {
            e.preventDefault();
            // 日付が既に入っていれば、要因を直しただけ。カレンダーは開かず確定する
            if (until) {
              save();
              onClose();
            } else {
              toDate();
            }
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
          onFocus={(e) => openPicker(e.currentTarget)}
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
  const recorded = useRef(false);
  /** 最後に保存した本文。やり直しで使う */
  const latestNote = useRef("");

  const save = () => {
    if (value === (task.note ?? "")) return;
    latestNote.current = value;
    void ipc.setNote(task.id, value);
    if (recorded.current) return;
    recorded.current = true;
    const was = task.note ?? "";
    record(
      "メモの変更",
      () => ipc.setNote(task.id, was),
      () => ipc.setNote(task.id, latestNote.current),
    );
  };

  // 欄外を押したら、書きかけを保存して閉じる
  const boxRef = useDismissOnOutside(true, () => {
    save();
    onClose();
  });

  return (
    <div className={`tk-note${isSub ? " is-sub" : ""}`} ref={boxRef}>
      <LinkedTextarea
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
      <div className="tk-note-foot">
        <span>離れると自動保存 / Esc で閉じる / リンクは Ctrl+クリック</span>
        {/* 行に並べるほど頻繁には使わない。メモを開いた人はその中身を
            見ているので、畳んで一時メモに戻す判断もここでできる */}
        <div className="tk-note-foot-btns">
          <button
            className="tk-btn"
            onClick={onDemote}
            title="一時メモへ移す。名前とメモ、サブタスクは 1 つの文章にまとめられます"
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
    (
      k:
        | "focusMinutes"
        | "shortFocusMinutes"
        | "shortBreakMinutes"
        | "longBreakMinutes"
        | "longBreakEvery",
    ) =>
    (e: ChangeEvent<HTMLInputElement>) =>
      setS({ ...s, [k]: Math.max(1, Number(e.target.value) || 1) });

  return (
    <div className="mg-modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mg-card">
        <h2>設定</h2>
        {/* 項目は増える一方なので、溢れたぶんは中でスクロールさせる。
            カード全体を伸ばすと、窓が小さいときに保存ボタンが画面の外へ
            出て押せなくなる */}
        <div className="mg-card-body">
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
        <div className="mg-field mg-field-sub">
          <label>
            短い集中(分)
            <small>助走用。ポモドーロとしては数えません</small>
          </label>
          <input
            type="number"
            min={1}
            max={60}
            value={s.shortFocusMinutes}
            onChange={num("shortFocusMinutes")}
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
            タスクのチェックボックスの意味
            <small>「選ぶ」にすると、完了は行の「✓ 完了」ボタンで行う</small>
          </label>
          <select
            value={s.checkSelects ? "select" : "done"}
            onChange={(e) => setS({ ...s, checkSelects: e.target.value === "select" })}
          >
            <option value="done">完了にする</option>
            <option value="select">次にやる 1 件に選ぶ</option>
          </select>
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
        </div>

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

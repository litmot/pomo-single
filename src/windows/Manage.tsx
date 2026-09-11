import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { listen } from "@tauri-apps/api/event";
import * as ipc from "../lib/ipc";
import { NoteLinks, noteSummary } from "../lib/NoteBody";
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
  /** 次の予定 (RFC3339)。会議までに 1 本入るかの判断に使う */
  const [appointment, setAppointment] = useState<string | null>(null);
  /** 入らないと分かっていて、それでも始めるとき */
  const [ignoreAppointment, setIgnoreAppointment] = useState(false);
  /** 残り時間の表示を進めるためだけの時計 */
  const [now, setNow] = useState(() => Date.now());
  /** 期限の入力を閉じたあと、続けて打てるよう追加欄に戻る */
  const addInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    const [t, s, st, tr] = await Promise.all([
      ipc.listTasks(["inbox", "todo", "doing", "done"]),
      ipc.timerState(),
      ipc.todayStats(),
      ipc.listTrash(),
    ]);
    setTasks(t);
    setSnap(s);
    setStats(st);
    setTrash(tr);
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

  /** 親タスクと、その配下のサブタスクを 1 階層だけ束ねる */
  const tree = useMemo(() => {
    const active = tasks.filter((t) => t.status !== "inbox" && t.status !== "archived");
    const parents = active.filter((t) => !t.parentId);
    return parents.map((p) => ({
      task: p,
      subs: active.filter((s) => s.parentId === p.id),
    }));
  }, [tasks]);

  /** 「メモへ」の移動先候補 */
  const openTasks = useMemo(
    () => tasks.filter((t) => t.status === "todo" || t.status === "doing"),
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

  const select = (id: string) => void ipc.setCurrentTask(id === currentId ? null : id);

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
            {tree.length === 0 ? (
              <div className="mg-empty">上の入力欄から追加</div>
            ) : (
              tree.map(({ task, subs }) => (
                <div key={task.id}>
                  <TaskRow
                    task={task}
                    isCurrent={task.id === currentId}
                    onToggleDone={() => void toggleDone(task)}
                    onSelect={() => select(task.id)}
                    onRename={(title) => void rename(task, title)}
                    onSetDue={(due) => void setDue(task, due)}
                    dueEditing={dueEditingFor === task.id}
                    onDueEditingChange={(open) =>
                      open ? setDueEditingFor(task.id) : closeDueEditor()
                    }
                    noteOpen={noteOpenFor === task.id}
                    onNoteOpenChange={(open) => setNoteOpenFor(open ? task.id : null)}
                    onAddSub={() => setSubDraftFor(task.id === subDraftFor ? null : task.id)}
                    onDemote={() => void ipc.demoteToInbox(task.id)}
                    onDelete={() => void ipc.trashTask(task.id)}
                  />
                  {subs.map((s) => (
                    <TaskRow
                      key={s.id}
                      task={s}
                      isSub
                      isCurrent={s.id === currentId}
                      onToggleDone={() => void toggleDone(s)}
                      onSelect={() => select(s.id)}
                      onRename={(title) => void rename(s, title)}
                      onSetDue={(due) => void setDue(s, due)}
                      dueEditing={dueEditingFor === s.id}
                      onDueEditingChange={(open) =>
                        open ? setDueEditingFor(s.id) : closeDueEditor()
                      }
                      noteOpen={noteOpenFor === s.id}
                      onNoteOpenChange={(open) => setNoteOpenFor(open ? s.id : null)}
                      onDemote={() => void ipc.demoteToInbox(s.id)}
                      onDelete={() => void ipc.trashTask(s.id)}
                    />
                  ))}
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
              ))
            )}
          </div>

          {trash.length > 0 && (
            <div className="tr-bar">
              <button className="tr-toggle" onClick={() => setTrashOpen((v) => !v)}>
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
              <span className="mg-next-label">次にやる</span>
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
          {currentTask ? "集中を開始" : "タスクを選んでください"}
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
}: {
  item: Task;
  targets: Task[];
  isPicking: boolean;
  onPickingChange: (open: boolean) => void;
}) {
  return (
    <div className={`ib-row${isPicking ? " is-picking" : ""}`}>
      <div className="ib-row-title">{item.title}</div>

      {isPicking ? (
        <div className="ib-pick">
          <div className="ib-pick-head">
            <span>どのタスクのメモへ</span>
            <button onClick={() => onPickingChange(false)}>やめる</button>
          </div>
          {targets.length === 0 ? (
            <div className="ib-pick-empty">移動先のタスクがありません</div>
          ) : (
            <div className="ib-pick-list">
              {targets.map((t) => (
                <button
                  key={t.id}
                  className="ib-pick-item"
                  onClick={() => {
                    onPickingChange(false);
                    void ipc.moveInboxToNote(item.id, t.id);
                  }}
                >
                  {t.title}
                </button>
              ))}
            </div>
          )}
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

function TaskRow({
  task,
  isSub,
  isCurrent,
  onToggleDone,
  onSelect,
  onRename,
  onSetDue,
  dueEditing,
  onDueEditingChange,
  noteOpen,
  onNoteOpenChange,
  onAddSub,
  onDemote,
  onDelete,
}: {
  task: Task;
  isSub?: boolean;
  isCurrent: boolean;
  onToggleDone: () => void;
  onSelect: () => void;
  onRename: (title: string) => void;
  onSetDue: (due: string) => void;
  dueEditing: boolean;
  onDueEditingChange: (open: boolean) => void;
  noteOpen: boolean;
  onNoteOpenChange: (open: boolean) => void;
  onAddSub?: () => void;
  onDemote: () => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const done = task.status === "done";
  const cls = [
    "tk-row",
    isSub ? "is-sub" : "",
    isCurrent ? "is-current" : "",
    done ? "is-done" : "",
    // カレンダーだけが宙に浮いて見えないよう、どの行のものかを行側でも示す
    dueEditing ? "is-picking" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
    {/* 行のどこをダブルクリックしても「次にやる」に指定できる。
        名前の上だけは編集を優先させるので、そちらで伝播を止めている。 */}
    <div className={cls} onDoubleClick={onSelect}>
      <button className="tk-check" onClick={onToggleDone} title={done ? "未完了に戻す" : "完了"}>
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
        {editing ? (
          <InlineInput
            className="tk-title-input"
            initial={task.title}
            onCommit={(title) => {
              setEditing(false);
              onRename(title);
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div
            className="tk-title"
            title="クリックで名前を変更"
            onClick={() => setEditing(true)}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            {task.title}
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
        {task.due && !dueEditing && (
          <button className="tk-btn" onClick={() => onSetDue("")} title="期限を外す">
            ×
          </button>
        )}
        <button
          className={`tk-btn${task.note ? " is-on" : ""}`}
          onClick={() => onNoteOpenChange(!noteOpen)}
          title="メモ (依頼文や URL の貼り付け)"
        >
          メモ
        </button>
        {onAddSub && (
          <button className="tk-btn" onClick={onAddSub} title="サブタスクを追加">
            + サブ
          </button>
        )}
        <button
          className="tk-btn"
          onClick={onDemote}
          title="一時メモに戻す (名前・メモ・サブタスクが 1 つの文章に畳まれます)"
        >
          一時メモへ
        </button>
        <button className="tk-btn" onClick={onDelete} title="ゴミ箱へ (戻せます)">
          削除
        </button>
      </div>
    </div>

    {noteOpen && (
      <NoteEditor task={task} isSub={isSub} onClose={() => onNoteOpenChange(false)} />
    )}
    </>
  );
}

/** 選択肢の刻み (分) */
const APPT_STEP_MINUTES = 5;
/** 選択肢を並べる範囲 (時間) */
const APPT_RANGE_HOURS = 8;

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
        title={`${APPT_STEP_MINUTES} 分刻みで選ぶ`}
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
  onClose,
}: {
  task: Task;
  isSub?: boolean;
  onClose: () => void;
}) {
  const [value, setValue] = useState(task.note ?? "");

  const save = () => {
    if (value !== (task.note ?? "")) void ipc.setNote(task.id, value);
  };

  return (
    <div className={`tk-note${isSub ? " is-sub" : ""}`}>
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
  );
}

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

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as ipc from "../lib/ipc";
import { isTextField, record } from "../lib/undo";
import { useComposition } from "../lib/ime";
import { initialPicks, orderWithPicks, staleTasks, TIDY_LIMIT, TODAY_PICKS } from "../lib/tidy";
import { formatDue, isUrgent, type Task } from "../lib/types";
import "../styles/tidy.css";

/**
 * 朝の整理。
 *
 * その日最初に管理画面を開いたとき、中身と入れ替わって出る (振り返りと
 * 同じ場所)。2 つの段からなる:
 * 1. 動いていないタスクを 1 件ずつ見直す (古い順に最大 5 件)
 * 2. 今日やる 3 件を選ぶ。選んだ順に一覧の先頭へ並べ、1 件目を選ぶ
 *
 * 強制はしない。「今日は飛ばす」で閉じられる (飛ばしたことは振り返りに残る)。
 */

type Mode = null | "due" | "split" | "wait";

/** 見直しのボタン。数字キーでも押せる */
const ACTIONS: { id: string; label: string; hint: string }[] = [
  { id: "today", label: "今日やる", hint: "今日の 3 件の候補に入れる" },
  { id: "due", label: "日付を決める", hint: "やる日 (期限) を入れる" },
  { id: "split", label: "分解する", hint: "最初の一歩をサブタスクにする" },
  { id: "wait", label: "待ちにする", hint: "相手の動きを待っている" },
  { id: "someday", label: "いつかへ", hint: "一覧から外す。週の振り返りで見直す" },
  { id: "trash", label: "捨てる", hint: "削除する (Ctrl+Z で戻せる)" },
  { id: "keep", label: "このまま残す", hint: "今のままでよい。しばらく出さない" },
];

export default function Tidy({
  tasks,
  currentId,
  onClose,
  renderDue,
}: {
  tasks: Task[];
  currentId: string | null;
  /** 済ませた / 飛ばした */
  onClose: (result: "done" | "skipped") => void;
  /** 期限の入力欄 (一覧と同じもの) */
  renderDue: (onCommit: (due: string) => void, onCancel: () => void) => ReactNode;
}) {
  /**
   * 見直す順番は開いた時点で決めて、途中で並べ直さない。
   * 「残す」で日数が変わっても、目の前のカードが入れ替わらないように
   */
  const [queue, setQueue] = useState<string[] | null>(null);
  const [total, setTotal] = useState(0);
  useEffect(() => {
    if (queue !== null || tasks.length === 0) return;
    const stale = staleTasks(tasks);
    setTotal(stale.length);
    setQueue(stale.slice(0, TIDY_LIMIT).map((x) => x.task.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  const [index, setIndex] = useState(0);
  const [mode, setMode] = useState<Mode>(null);
  /** 見直しで「今日やる」にしたもの */
  const [today, setToday] = useState<string[]>([]);
  const [step, setStep] = useState<"stale" | "pick">("stale");

  // 消えた (別の所で完了・削除した) カードは飛ばす
  const items = useMemo(
    () => (queue ?? []).map((id) => tasks.find((t) => t.id === id)).filter((t): t is Task => Boolean(t)),
    [queue, tasks],
  );
  const card = step === "stale" ? items[index] : undefined;
  useEffect(() => {
    if (queue !== null && step === "stale" && index >= items.length) setStep("pick");
  }, [queue, step, index, items.length]);

  const next = () => {
    setMode(null);
    setIndex((i) => i + 1);
  };

  const act = async (id: string) => {
    if (!card) return;
    const t = card;
    switch (id) {
      case "today":
        await ipc.touchTask(t.id);
        setToday((xs) => (xs.includes(t.id) ? xs : [...xs, t.id]));
        return next();
      case "due":
      case "split":
      case "wait":
        return setMode(id);
      case "someday":
        if (currentId === t.id || tasks.find((x) => x.id === currentId)?.parentId === t.id) {
          await ipc.setCurrentTask(null);
        }
        await ipc.setTaskStatus(t.id, "someday");
        record("いつかへ", () => ipc.setTaskStatus(t.id, t.status), () => ipc.setTaskStatus(t.id, "someday"));
        return next();
      case "trash":
        await ipc.trashTask(t.id);
        record("削除", () => ipc.restoreTask(t.id), () => ipc.trashTask(t.id));
        return next();
      case "keep":
        await ipc.touchTask(t.id);
        return next();
    }
  };

  // 数字キーで押せる。入力欄の中では効かない
  const actRef = useRef(act);
  actRef.current = act;
  useEffect(() => {
    if (step !== "stale") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.metaKey || isTextField(e.target)) return;
      if (e.key === "Escape" && mode) {
        e.preventDefault();
        setMode(null);
        return;
      }
      const n = Number(e.key);
      if (!mode && n >= 1 && n <= ACTIONS.length) {
        e.preventDefault();
        void actRef.current(ACTIONS[n - 1].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, mode]);

  /* ---- 2 段目: 今日やる 3 件 ---- */
  const open = useMemo(
    () => tasks.filter((t) => !t.parentId && (t.status === "todo" || t.status === "doing")),
    [tasks],
  );
  const [picks, setPicks] = useState<string[] | null>(null);
  useEffect(() => {
    if (step === "pick" && picks === null) setPicks(initialPicks(open, tasks, currentId, today));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const togglePick = (id: string) =>
    setPicks((xs) => {
      const cur = xs ?? [];
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      return cur.length >= TODAY_PICKS ? cur : [...cur, id];
    });

  /** 選んだ順に一覧の先頭へ並べ、1 件目を選ぶ。`start` ならそのまま集中に入る */
  const finish = async (start: boolean) => {
    const chosen = picks ?? [];
    if (chosen.length) {
      await ipc.reorderTasks(orderWithPicks(open.map((t) => t.id), chosen));
      // 1 件目を選ぶ。そのサブタスクを選んでいたなら、そのまま
      const cur = tasks.find((t) => t.id === currentId);
      const keep = cur && (cur.id === chosen[0] || cur.parentId === chosen[0]);
      const first = keep ? cur.id : chosen[0];
      if (!keep) await ipc.setCurrentTask(first);
      onClose("done");
      if (start) await ipc.timerStart(first);
      return;
    }
    onClose("done");
  };

  const inbox = tasks.filter((t) => t.status === "inbox").length;

  if (queue === null && tasks.length > 0) return null;

  return (
    <div className="td">
      <div className="td-top">
        <h2>朝の整理</h2>
        <span className="td-steps">
          <span className={step === "stale" ? "is-on" : "is-past"}>1. 動いていないタスクを見直す</span>
          <span className="td-arrow">›</span>
          <span className={step === "pick" ? "is-on" : ""}>2. 今日やる {TODAY_PICKS} 件を選ぶ</span>
        </span>
        <span className="td-sp" />
        <button className="td-skip" onClick={() => onClose("skipped")} title="今日は整理せずに一覧へ (振り返りに「飛ばした」と残ります)">
          今日は飛ばす
        </button>
      </div>

      {step === "stale" && card && (
        <div className="td-body">
          <div className="td-count">
            {index + 1} / {items.length} 件目
            {total > items.length && <small> (ほかに {total - items.length} 件。明日以降に出ます)</small>}
          </div>
          <StaleCard task={card} subs={tasks.filter((s) => s.parentId === card.id)} />

          {mode === null && (
            <div className="td-actions">
              {ACTIONS.map((a, i) => (
                <button
                  key={a.id}
                  className={`td-act is-${a.id}`}
                  title={a.hint}
                  onClick={() => void act(a.id)}
                  autoFocus={i === 0}
                >
                  <kbd>{i + 1}</kbd>
                  {a.label}
                </button>
              ))}
            </div>
          )}
          {mode === "due" && (
            <div className="td-input">
              <span>やる日 (期限)</span>
              {renderDue(
                (due) => {
                  if (!due) return setMode(null);
                  void (async () => {
                    await ipc.updateTask(card.id, { due });
                    await ipc.touchTask(card.id);
                    next();
                  })();
                },
                () => setMode(null),
              )}
            </div>
          )}
          {mode === "split" && (
            <LineInput
              label="最初の一歩"
              placeholder="例: 先方の過去のメールを探す (サブタスクとして足す)"
              onCommit={(title) =>
                void (async () => {
                  await ipc.createTask(title, "todo", card.id);
                  await ipc.touchTask(card.id);
                  next();
                })()
              }
              onCancel={() => setMode(null)}
            />
          )}
          {mode === "wait" && (
            <LineInput
              label="何を待つか"
              placeholder="例: A 社の見積もり回答"
              onCommit={(what) =>
                void (async () => {
                  if (currentId === card.id) await ipc.setCurrentTask(null);
                  await ipc.setWaiting(card.id, what, "");
                  next();
                })()
              }
              onCancel={() => setMode(null)}
            />
          )}
          <div className="td-foot">
            <button className="td-link" onClick={() => setStep("pick")}>
              見直しを終えて、今日の {TODAY_PICKS} 件を選ぶ ›
            </button>
          </div>
        </div>
      )}

      {step === "pick" && (
        <div className="td-body">
          {items.length === 0 && <div className="td-note">動いていないタスクはありません。</div>}
          <div className="td-count">
            今日やるタスクを {TODAY_PICKS} 件まで、やる順に選んでください。選んだ順に一覧の先頭へ並べ、1 件目を選んだ状態にします。
          </div>
          <div className="td-picks">
            {open.length === 0 && <div className="td-note">一覧にタスクがありません。</div>}
            {open.map((t) => {
              const n = (picks ?? []).indexOf(t.id);
              const full = (picks ?? []).length >= TODAY_PICKS && n < 0;
              return (
                <button
                  key={t.id}
                  className={`td-pick${n >= 0 ? " is-on" : ""}`}
                  disabled={full}
                  onClick={() => togglePick(t.id)}
                >
                  <span className="td-pick-n">{n >= 0 ? n + 1 : ""}</span>
                  <span className="td-pick-t">
                    {t.importance === 1 && <span className="td-star">★</span>}
                    {t.title}
                  </span>
                  {t.due && <span className={`td-due${isUrgent(t.due) ? " is-urgent" : ""}`}>{formatDue(t.due)} まで</span>}
                </button>
              );
            })}
          </div>
          {inbox > 0 && <div className="td-note">一時メモが {inbox} 件あります。整理を終えたら一覧で振り分けてください。</div>}
          <div className="td-foot">
            {(picks ?? []).length ? (
              <>
                <button className="td-link" onClick={() => void finish(false)}>
                  並べるだけ
                </button>
                <button className="td-go" onClick={() => void finish(true)} autoFocus>
                  1 件目で集中を開始
                </button>
              </>
            ) : (
              <button className="td-go" onClick={() => void finish(false)} autoFocus>
                選ばずに終える
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 見直すタスクのカード。何日動いていないか、サブタスクとメモの手掛かり */
function StaleCard({ task, subs }: { task: Task; subs: Task[] }) {
  const item = staleTasks([task, ...subs]).find((x) => x.task.id === task.id);
  const created = daysSince(task.createdAt);
  const doneSubs = subs.filter((s) => s.status === "done").length;
  return (
    <div className="td-card">
      <div className="td-card-t">
        {task.importance === 1 && <span className="td-star">★</span>}
        {task.title}
      </div>
      <div className="td-card-meta">
        {item && <span className="td-idle">{item.days} 日動きなし</span>}
        {/* 作ってから一度も動いていなければ、日数は上と同じなので出さない */}
        {Number.isFinite(created) && created !== item?.days && (
          <span>作成 {created === 0 ? "今日" : `${created} 日前`}</span>
        )}
        {task.actualPomodoros > 0 && <span>🍅 {task.actualPomodoros}</span>}
        {subs.length > 0 && (
          <span>
            サブタスク {doneSubs}/{subs.length} 完了
          </span>
        )}
        {task.due && <span className="td-due is-urgent">{formatDue(task.due)} まで (過ぎています)</span>}
      </div>
      {task.note && <div className="td-card-note">{task.note.split("\n").slice(0, 3).join("\n")}</div>}
    </div>
  );
}

function daysSince(iso: string): number {
  const a = new Date(iso);
  a.setHours(0, 0, 0, 0);
  const b = new Date();
  b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/** 1 行の入力。Enter で決める、Esc でやめる */
function LineInput({
  label,
  placeholder,
  onCommit,
  onCancel,
}: {
  label: string;
  placeholder: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const ime = useComposition();
  return (
    <div className="td-input">
      <span>{label}</span>
      <input
        autoFocus
        value={text}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        {...ime.handlers}
        onKeyDown={(e) => {
          if (ime.composing.current) return;
          if (e.key === "Enter" && text.trim()) {
            e.preventDefault();
            onCommit(text.trim());
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      <button className="td-act" onClick={() => text.trim() && onCommit(text.trim())}>
        決める
      </button>
      <button className="td-link" onClick={onCancel}>
        やめる
      </button>
    </div>
  );
}

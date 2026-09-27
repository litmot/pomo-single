import { useEffect, useMemo, useRef, useState } from "react";
import * as ipc from "../lib/ipc";
import {
  OUTCOME_LABEL,
  addDays,
  hm,
  mdw,
  startOfDay,
  startOfWeek,
  summarize,
  ymd,
  type ReviewData,
  type Summary,
  type Touched,
} from "../lib/review";
import { formatDue, isUrgent, type Task } from "../lib/types";
import "../styles/review.css";

/** 振り返りから移れる先 */
export type ReviewTarget = "inbox" | "list" | "waiting" | "matrix" | "routines";

/** タスクごとの色。1 日の流れの帯と一覧の印で同じ色を使う */
const PALETTE = ["#e0a458", "#56b6a4", "#7ea6e0", "#c78fd0", "#d98c7a", "#9fbf6a", "#6fc1d6", "#d6c36f"];

/**
 * 振り返り。
 *
 * 管理画面の中身と入れ替わる。集中中・休憩中には出さない (自分で開いた
 * ときだけの場)。「記録を見る」と「次に備えて片付ける」の 2 つからなる。
 *
 * 点数や連続記録は出さない。数を追わせると、本数を稼ぐ方向に歪む。
 * 0 本の日も 0 のまま並べる。
 */
export default function Review({
  tab,
  onTab,
  onClose,
  tasks,
  routineCount,
  currentId,
  onGo,
}: {
  tab: "day" | "week";
  onTab: (tab: "day" | "week") => void;
  onClose: () => void;
  /** 管理画面が持っているタスク (一時メモ・待ち・期限を数えるのに使う) */
  tasks: Task[];
  routineCount: number;
  currentId: string | null;
  onGo: (where: ReviewTarget) => void;
}) {
  const today = startOfDay(new Date());
  const [day, setDay] = useState(today);
  const [week, setWeek] = useState(startOfWeek(today));

  const from = tab === "day" ? day : week;
  const to = addDays(from, tab === "day" ? 1 : 7);
  const [data, setData] = useState<ReviewData | null>(null);

  // 表示している期間の記録を取り直す。タスクが変わったとき (完了にした等) も
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  useEffect(() => {
    let alive = true;
    void ipc.reviewData(fromIso, toIso).then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
  }, [fromIso, toIso, tasks]);

  const summary = useMemo(
    () => (data ? summarize(data, from.getTime(), to.getTime()) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, fromIso, toIso],
  );

  const isToday = tab === "day" && ymd(day) === ymd(today);
  const isThisWeek = tab === "week" && ymd(week) === ymd(startOfWeek(today));
  const atLatest = tab === "day" ? isToday : isThisWeek;

  const step = (delta: number) => {
    if (tab === "day") setDay(addDays(day, delta));
    else setWeek(addDays(week, 7 * delta));
  };

  return (
    <div className="rv">
      <div className="rv-top">
        <span className="rv-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "day"} className={tab === "day" ? "is-on" : ""} onClick={() => onTab("day")}>
            今日
          </button>
          <button role="tab" aria-selected={tab === "week"} className={tab === "week" ? "is-on" : ""} onClick={() => onTab("week")}>
            今週
          </button>
        </span>
        <span className="rv-nav">
          <button onClick={() => step(-1)} aria-label={tab === "day" ? "前の日" : "前の週"} title={tab === "day" ? "前の日" : "前の週"}>
            ←
          </button>
          <span className="rv-when">
            {tab === "day" ? mdw(day) : `${mdw(week)} 〜 ${mdw(addDays(week, 6))}`}
          </span>
          <button
            onClick={() => step(1)}
            disabled={atLatest}
            aria-label={tab === "day" ? "次の日" : "次の週"}
            title={tab === "day" ? "次の日" : "次の週"}
          >
            →
          </button>
          {!atLatest && (
            <button
              className="rv-today"
              onClick={() => (tab === "day" ? setDay(today) : setWeek(startOfWeek(today)))}
            >
              {tab === "day" ? "今日へ" : "今週へ"}
            </button>
          )}
        </span>
        <span className="rv-sp" />
        <button className="rv-back" onClick={onClose}>
          一覧に戻る
        </button>
      </div>

      {!summary ? (
        <div className="rv-loading">読み込み中…</div>
      ) : tab === "day" ? (
        <DayView
          summary={summary}
          dayStart={day}
          isToday={isToday}
          tasks={tasks}
          currentId={currentId}
          onGo={onGo}
        />
      ) : (
        <WeekView
          summary={summary}
          data={data!}
          weekStart={week}
          tasks={tasks}
          routineCount={routineCount}
          onGo={onGo}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */

function Facts({ summary, extra }: { summary: Summary; extra?: string }) {
  return (
    <div className="rv-facts">
      <div className="rv-fact">
        <b>{summary.pomodoros}</b>
        <span>ポモドーロ</span>
        {extra && <small>{extra}</small>}
      </div>
      <div className="rv-fact">
        <b>{hm(summary.focusMs)}</b>
        <span>集中した時間</span>
      </div>
      <div className="rv-fact">
        <b>{summary.completedTasks}</b>
        <span>完了したタスク</span>
      </div>
      <div className="rv-fact">
        <b>{summary.interrupts}</b>
        <span>中断</span>
        <small>別の仕事へ移った回数</small>
      </div>
      <div className="rv-fact">
        <b>{summary.captured}</b>
        <span>集中中の一時メモ</span>
        <small>書き留めて先へ進んだ回数</small>
      </div>
    </div>
  );
}

const STATE_LABEL: Record<Touched["state"], string> = {
  done: "完了",
  continue: "続き",
  waiting: "待ちへ",
  trashed: "削除",
};

function TouchedList({ touched, colorOf }: { touched: Touched[]; colorOf: (id: string) => string }) {
  if (touched.length === 0) return <div className="rv-empty">この日に手を付けたタスクはありません</div>;
  return (
    <div className="rv-list">
      {touched.map((t) => (
        <div className="rv-li" key={t.task.id}>
          <span className="rv-sw" style={{ background: colorOf(t.task.id) }} />
          <span className={`rv-state is-${t.state}`}>{STATE_LABEL[t.state]}</span>
          <span className="rv-n" title={t.task.title}>
            {t.task.routineId ? "↻ " : ""}
            {t.task.title}
          </span>
          <span className="rv-m">
            🍅 {t.pomodoros}
            {t.shortFocus > 0 ? ` + 短い集中 ${t.shortFocus}` : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

/** タスクに色を割り当てる。本数の多い順に、決まった色を順に使う */
function useColors(touched: Touched[]) {
  return useMemo(() => {
    const map = new Map<string, string>();
    touched.forEach((t, i) => map.set(t.task.id, PALETTE[i % PALETTE.length]));
    return (id: string | null) => (id && map.get(id)) || "#5a6373";
  }, [touched]);
}

/* ---------------- 日次 ---------------- */

function DayView({
  summary,
  dayStart,
  isToday,
  tasks,
  currentId,
  onGo,
}: {
  summary: Summary;
  dayStart: Date;
  isToday: boolean;
  tasks: Task[];
  currentId: string | null;
  onGo: (where: ReviewTarget) => void;
}) {
  const colorOf = useColors(summary.touched);
  const focusCount = Object.values(summary.outcomes).reduce((a, b) => a + b, 0);

  return (
    <div className="rv-stack">
      <Facts summary={summary} extra={summary.pomodoros > 0 ? "短い集中は数えない" : undefined} />

      <div className="rv-card">
        <h3>
          1 日の流れ <small>集中した時間帯。色はタスク、斜線は短い集中</small>
        </h3>
        <Timeline summary={summary} dayStart={dayStart} colorOf={colorOf} />
      </div>

      <div className="rv-grid">
        <div className="rv-card">
          <h3>
            手を付けたタスク <small>{summary.touched.length} 件</small>
          </h3>
          <TouchedList touched={summary.touched} colorOf={colorOf} />
          {focusCount > 0 && (
            <>
              <h3 className="rv-sub">
                終わり方 <small>標準の集中 {focusCount} 本</small>
              </h3>
              <div className="rv-list">
                {Object.entries(summary.outcomes).map(([k, n]) => (
                  <div className="rv-li" key={k}>
                    <span className="rv-n">{OUTCOME_LABEL[k] ?? k}</span>
                    <span className="rv-m">{n} 本</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="rv-card">
          {isToday && <Prepare tasks={tasks} currentId={currentId} onGo={onGo} />}
          <NoteBox kind="day" noteKey={ymd(dayStart)} placeholder="例: 午後は会議の合間で細切れ。契約書は午前に回すほうが進む" />
        </div>
      </div>
    </div>
  );
}

/** 1 日の帯。横軸は時刻 */
function Timeline({
  summary,
  dayStart,
  colorOf,
}: {
  summary: Summary;
  dayStart: Date;
  colorOf: (id: string | null) => string;
}) {
  const segs = summary.segments;
  const base = dayStart.getTime();
  const hourOf = (ms: number) => (ms - base) / 3_600_000;
  // 既定は 8〜19 時。記録がはみ出していれば広げる
  let startH = 8;
  let endH = 19;
  for (const g of segs) {
    startH = Math.min(startH, Math.floor(hourOf(g.start)));
    endH = Math.max(endH, Math.ceil(hourOf(g.end)));
  }
  startH = Math.max(0, startH);
  endH = Math.min(24, Math.max(endH, startH + 1));

  const W = 980;
  const x0 = 30;
  const x1 = W - 20;
  const X = (h: number) => x0 + ((h - startH) / (endH - startH)) * (x1 - x0);
  const ticks = [];
  const every = endH - startH > 14 ? 2 : 1;
  for (let h = startH; h <= endH; h += every) ticks.push(h);

  const legend = summary.touched.filter((t) => t.pomodoros > 0 || t.shortFocus > 0);

  return (
    <>
      <div className="rv-chart">
        <svg viewBox={`0 0 ${W} 82`} width="100%" role="img" aria-label="集中した時間帯">
          <defs>
            <pattern id="rv-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="5" height="5" fill="#2a2f38" />
              <rect width="2" height="5" fill="#7a8394" />
            </pattern>
          </defs>
          <rect x={x0} y={14} width={x1 - x0} height={34} rx={4} fill="#1b1e24" stroke="#2c313a" />
          {ticks.map((h) => (
            <g key={h}>
              <line x1={X(h)} x2={X(h)} y1={14} y2={52} stroke="#2c313a" />
              <text x={X(h)} y={68} fill="#96a0af" fontSize="11" textAnchor="middle">
                {h}:00
              </text>
            </g>
          ))}
          {segs.map((g, i) => {
            const a = X(hourOf(g.start));
            const b = X(hourOf(g.end));
            const title = `${new Date(g.start).toTimeString().slice(0, 5)}–${new Date(g.end)
              .toTimeString()
              .slice(0, 5)} ${summary.touched.find((t) => t.task.id === g.taskId)?.task.title ?? "(タスクなし)"}${
              g.short ? " (短い集中)" : ""
            }${g.interrupts ? ` (中断 ${g.interrupts})` : ""}`;
            return (
              <g key={i}>
                <rect
                  x={a + 0.5}
                  y={18}
                  width={Math.max(2, b - a - 1)}
                  height={26}
                  rx={3}
                  fill={g.short ? "url(#rv-hatch)" : colorOf(g.taskId)}
                >
                  <title>{title}</title>
                </rect>
                {g.interrupts > 0 && (
                  <text x={b + 2} y={11} fill="#d9645f" fontSize="10">
                    中断
                  </text>
                )}
              </g>
            );
          })}
          {segs.length === 0 && (
            <text x={(x0 + x1) / 2} y={36} fill="#96a0af" fontSize="12" textAnchor="middle">
              集中の記録はありません
            </text>
          )}
        </svg>
      </div>
      {legend.length > 0 && (
        <div className="rv-legend">
          {legend.map((t) => (
            <span key={t.task.id}>
              <i style={{ background: colorOf(t.task.id) }} />
              {t.task.title}
            </span>
          ))}
          {segs.some((g) => g.short) && (
            <span>
              <i className="is-hatch" />
              短い集中 (ポモドーロに数えない)
            </span>
          )}
        </div>
      )}
    </>
  );
}

/** 明日に備える。今日を見ているときだけ出す */
function Prepare({
  tasks,
  currentId,
  onGo,
}: {
  tasks: Task[];
  currentId: string | null;
  onGo: (where: ReviewTarget) => void;
}) {
  const todayKey = ymd(new Date());
  const tomorrowKey = ymd(addDays(new Date(), 1));
  const inbox = tasks.filter((t) => t.status === "inbox").length;
  const open = tasks.filter((t) => (t.status === "todo" || t.status === "doing") && !t.parentId);
  const dueSoon = tasks
    .filter((t) => (t.status === "todo" || t.status === "doing") && t.due && t.due <= tomorrowKey)
    .sort((a, b) => (a.due ?? "").localeCompare(b.due ?? ""));
  const waitingDue = tasks.filter((t) => t.status === "waiting" && t.waitingUntil && t.waitingUntil <= todayKey);

  // 次の出だしの候補: 重要の印 → 期限の近い順
  const candidates = [...open]
    .sort(
      (a, b) =>
        (b.importance === 1 ? 1 : 0) - (a.importance === 1 ? 1 : 0) ||
        (a.due ?? "9999").localeCompare(b.due ?? "9999") ||
        a.sortOrder - b.sortOrder,
    )
    .slice(0, 3);

  const nothing = inbox === 0 && dueSoon.length === 0 && waitingDue.length === 0;

  return (
    <>
      <h3>明日に備える</h3>
      <div className="rv-list">
        {nothing && <div className="rv-empty">片付けておくものはありません</div>}
        {inbox > 0 && (
          <div className="rv-li">
            <span className="rv-n">残っている一時メモ</span>
            <span className="rv-m">{inbox} 件</span>
            <button className="rv-go" onClick={() => onGo("inbox")}>
              振り分ける
            </button>
          </div>
        )}
        {dueSoon.slice(0, 4).map((t) => (
          <div className="rv-li" key={t.id}>
            <span className="rv-n" title={t.title}>
              {t.title}
            </span>
            <span className={`rv-m ${t.due && t.due < todayKey ? "is-over" : "is-soon"}`}>{formatDue(t.due!)} まで</span>
            <button className="rv-go" onClick={() => onGo("list")}>
              一覧で見る
            </button>
          </div>
        ))}
        {waitingDue.map((t) => (
          <div className="rv-li" key={t.id}>
            <span className="rv-n" title={t.title}>
              ⏳ {t.waitingFor || t.title}
            </span>
            <span className="rv-m is-over">{formatDue(t.waitingUntil!)} 催促</span>
            <button className="rv-go" onClick={() => onGo("waiting")}>
              待ちを見る
            </button>
          </div>
        ))}
      </div>

      {candidates.length > 0 && (
        <>
          <h3 className="rv-sub">
            次の出だしの 1 件 <small>アプリを開き直しても、選んだ状態で始まる</small>
          </h3>
          <div className="rv-list">
            {candidates.map((t, i) => (
              <div className="rv-li" key={t.id}>
                <span className="rv-n" title={t.title}>
                  {t.title}
                </span>
                <span className="rv-m">
                  {t.importance === 1 ? "★ " : ""}
                  {t.due ? `${formatDue(t.due)} まで` : ""}
                </span>
                {currentId === t.id ? (
                  <span className="rv-picked">選択中</span>
                ) : (
                  <button className={`rv-go${i === 0 ? " is-primary" : ""}`} onClick={() => void ipc.setStartTask(t.id)}>
                    これにする
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/* ---------------- 週次 ---------------- */

function WeekView({
  summary,
  data,
  weekStart,
  tasks,
  routineCount,
  onGo,
}: {
  summary: Summary;
  data: ReviewData;
  weekStart: Date;
  tasks: Task[];
  routineCount: number;
  onGo: (where: ReviewTarget) => void;
}) {
  const colorOf = useColors(summary.touched);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(weekStart, i);
    const s = summarize(data, d.getTime(), addDays(d, 1).getTime());
    return { d, pomodoros: s.pomodoros, interrupts: s.interrupts };
  });
  const worked = days.filter((d) => d.pomodoros > 0).length;
  const top = summary.touched.filter((t) => t.pomodoros > 0).slice(0, 5);

  return (
    <div className="rv-stack">
      <Facts summary={summary} extra={worked > 0 ? `1 日平均 ${(summary.pomodoros / worked).toFixed(1)} 本 (${worked} 日)` : undefined} />
      <div className="rv-grid">
        <div className="rv-card">
          <h3>
            曜日ごとのポモドーロ <small>棒の上は本数、下は中断の回数</small>
          </h3>
          <Bars days={days} />
          <h3 className="rv-sub">
            🍅 の多かったタスク <small>思ったより時間を食ったものに気づくため</small>
          </h3>
          {top.length === 0 ? (
            <div className="rv-empty">この週の集中の記録はありません</div>
          ) : (
            <TouchedList touched={top} colorOf={colorOf} />
          )}
        </div>
        <div className="rv-card">
          <Steps weekKey={ymd(weekStart)} tasks={tasks} routineCount={routineCount} onGo={onGo} />
          <NoteBox kind="week" noteKey={ymd(weekStart)} placeholder="例: 水曜は会議で 3 本。来週は午前に予算資料を固める" />
        </div>
      </div>
    </div>
  );
}

function Bars({ days }: { days: { d: Date; pomodoros: number; interrupts: number }[] }) {
  const max = Math.max(4, ...days.map((d) => d.pomodoros));
  const niceMax = Math.ceil(max / 2) * 2;
  const left = 30;
  const right = 505;
  const top = 18;
  const base = 150;
  const Y = (v: number) => base - (v / niceMax) * (base - top);
  const bw = (right - left) / days.length;
  const today = ymd(new Date());
  const grid = [];
  for (let v = 0; v <= niceMax; v += niceMax > 10 ? 4 : 2) grid.push(v);
  return (
    <div className="rv-chart">
      <svg viewBox="0 0 520 200" width="100%" role="img" aria-label="曜日ごとのポモドーロの本数">
        {grid.map((v) => (
          <g key={v}>
            <line x1={left} x2={right} y1={Y(v)} y2={Y(v)} stroke={v === 0 ? "#4a5261" : "#23272f"} />
            <text x={left - 6} y={Y(v) + 4} fill="#96a0af" fontSize="10" textAnchor="end">
              {v}
            </text>
          </g>
        ))}
        {days.map(({ d, pomodoros, interrupts }, i) => {
          const cx = left + bw * i + bw / 2;
          const w = bw * 0.56;
          const isToday = ymd(d) === today;
          return (
            <g key={i}>
              {pomodoros > 0 && (
                <rect x={cx - w / 2} y={Y(pomodoros)} width={w} height={base - Y(pomodoros)} rx={3} fill={isToday ? "#e0a458" : "#8a6a3f"}>
                  <title>{`${mdw(d)} ${pomodoros} 本`}</title>
                </rect>
              )}
              <text x={cx} y={Y(pomodoros) - 5} fill="#eef0f4" fontSize="11" textAnchor="middle">
                {pomodoros}
              </text>
              <text x={cx} y={base + 16} fill={isToday ? "#e0a458" : "#c3cbd7"} fontSize="11" textAnchor="middle">
                {mdw(d).replace(/^\d+\/\d+/, "").replace(/[()]/g, "")}
              </text>
              <text x={cx} y={base + 30} fill="#96a0af" fontSize="9.5" textAnchor="middle">
                {`${d.getMonth() + 1}/${d.getDate()}`}
              </text>
              <text x={cx} y={base + 44} fill={interrupts ? "#d9645f" : "#5a6373"} fontSize="9.5" textAnchor="middle">
                中断 {interrupts}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** 見直しの手順。チェックはその週のあいだだけ覚える */
function Steps({
  weekKey,
  tasks,
  routineCount,
  onGo,
}: {
  weekKey: string;
  tasks: Task[];
  routineCount: number;
  onGo: (where: ReviewTarget) => void;
}) {
  const storeKey = `review-steps:${weekKey}`;
  const [checked, setChecked] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(storeKey) ?? "[]");
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      setChecked(JSON.parse(localStorage.getItem(storeKey) ?? "[]"));
    } catch {
      setChecked([]);
    }
  }, [storeKey]);
  const toggle = (id: string) => {
    const next = checked.includes(id) ? checked.filter((x) => x !== id) : [...checked, id];
    setChecked(next);
    try {
      localStorage.setItem(storeKey, JSON.stringify(next));
    } catch {
      /* 覚えられなくても手順そのものは使える */
    }
  };

  const todayKey = ymd(new Date());
  const in14 = ymd(addDays(new Date(), 14));
  const open = tasks.filter((t) => t.status === "todo" || t.status === "doing");
  const inbox = tasks.filter((t) => t.status === "inbox").length;
  const waiting = tasks.filter((t) => t.status === "waiting");
  const waitingDue = waiting.filter((t) => t.waitingUntil && t.waitingUntil <= todayKey).length;
  const dueIn14 = open.filter((t) => t.due && t.due <= in14).length;
  const q2 = open.filter((t) => !t.parentId && t.importance === 1 && !isUrgent(t.due)).length;

  const steps: { id: string; title: string; sub: string; status: string; warn: boolean; go: ReviewTarget; goLabel: string }[] = [
    { id: "inbox", title: "一時メモを空にする", sub: "全部をタスクへ・削除に振り分ける", status: inbox ? `残り ${inbox} 件` : "空です", warn: inbox > 0, go: "inbox", goLabel: "振り分ける" },
    { id: "waiting", title: "待ちを見直す", sub: "催促するか、解くか", status: waitingDue ? `要確認 ${waitingDue} 件` : `${waiting.length} 件`, warn: waitingDue > 0, go: "waiting", goLabel: "待ちを見る" },
    { id: "due", title: "2 週間先までの期限を見る", sub: `${mdw(addDays(new Date(), 14))} まで`, status: `${dueIn14} 件`, warn: false, go: "list", goLabel: "一覧で見る" },
    { id: "matrix", title: "表で来週やるものを決める", sub: "「Ⅱ 重要だが緊急でない」から選ぶ", status: `Ⅱ に ${q2} 件`, warn: false, go: "matrix", goLabel: "表を開く" },
    { id: "routines", title: "定型を見直す", sub: "要らないものを消す、周期を直す", status: `${routineCount} 件`, warn: false, go: "routines", goLabel: "定型を開く" },
  ];

  return (
    <>
      <h3>
        見直しの手順 <small>上から順に。ボタンでその場所へ移る</small>
      </h3>
      <div className="rv-steps">
        {steps.map((s) => {
          const done = checked.includes(s.id);
          return (
            <div className={`rv-step${done ? " is-done" : ""}`} key={s.id}>
              <input type="checkbox" checked={done} onChange={() => toggle(s.id)} aria-label={`${s.title}を済みにする`} />
              <span className="rv-step-t">
                {s.title}
                <small>{s.sub}</small>
              </span>
              <span className={`rv-step-st${s.warn ? " is-warn" : ""}`}>{s.status}</span>
              <button className="rv-go" onClick={() => onGo(s.go)}>
                {s.goLabel}
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}

/** 一言メモ。離れたとき (と打ち止めて少ししたとき) に保存する */
function NoteBox({ kind, noteKey, placeholder }: { kind: "day" | "week"; noteKey: string; placeholder: string }) {
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(true);
  const last = useRef("");
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    void ipc.getReviewNote(kind, noteKey).then((v) => {
      if (!alive) return;
      setText(v ?? "");
      last.current = v ?? "";
      setSaved(true);
    });
    return () => {
      alive = false;
    };
  }, [kind, noteKey]);

  const save = (value: string) => {
    if (timer.current) window.clearTimeout(timer.current);
    if (value === last.current) return;
    last.current = value;
    void ipc.setReviewNote(kind, noteKey, value).then(() => setSaved(true));
  };

  return (
    <div className="rv-note">
      <h3 className="rv-sub">
        一言メモ <small>任意。{saved ? "自動で保存" : "保存待ち…"}</small>
      </h3>
      <textarea
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          setSaved(false);
          if (timer.current) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => save(v), 800);
        }}
        onBlur={() => save(text)}
      />
      <span className="rv-hint">
        {kind === "day" ? "この日の振り返りに残る。← で前の日を開けば読み返せる" : "この週の振り返りに残る"}
      </span>
    </div>
  );
}

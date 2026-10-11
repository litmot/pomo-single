/**
 * 集中用のノイズ (ブラウン / ピンク / ホワイト)。
 *
 * 音声ファイルは持たず、Web Audio でその場で作る。ネットワークも要らない。
 * 3 種類をそれぞれ 15 秒ぶん作って繰り返し流し、「音色」のつまみの位置で
 * 混ぜる割合を変える。左端がブラウン (低い音が多い)、真ん中がピンク、
 * 右端がホワイト (高い音まで同じ強さ)。ノイズなので継ぎ目は聞き分けられない。
 *
 * 耳とまわりへの配慮:
 * - 音量の上限を抑えめにする (MAX_GAIN)。つまみの 100 でも大きくなりすぎない
 * - いきなり鳴らさず、数秒かけて大きくする。イヤホンを挿し忘れて
 *   スピーカーから流れても、すぐ気づいて止められるように
 * - 止めるときも少しずつ小さくする
 * - 3 種類は同じくらいの大きさに揃えてから混ぜる。音色を変えても
 *   音量が跳ねないように
 */

/** つまみを 100 にしたときの音量 (0〜1)。ここで上限を抑える */
const MAX_GAIN = 0.3;
/** 作っておくノイズの長さ (秒) */
const SECONDS = 15;
/** 揃える音の大きさ (RMS)。今までのピンクノイズと同じくらい */
const TARGET_RMS = 0.12;
/**
 * 種類ごとの聞こえ方の補正。同じ RMS でも、高い音を多く含むホワイトは
 * うるさく、低い音ばかりのブラウンは静かに聞こえる
 */
const TRIM = { brown: 1.15, pink: 1, white: 0.7 } as const;

type Kind = keyof typeof TRIM;
const KINDS: Kind[] = ["brown", "pink", "white"];

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
const mix = new Map<Kind, GainNode>();
const buffers = new Map<Kind, AudioBuffer>();
let sources: AudioBufferSourceNode[] = [];
let stopTimer: number | null = null;
let color = 50;

/** 0〜100 のつまみの値を音量にする。耳の感じ方に合わせて 2 乗で効かせる */
function gainOf(volume: number): number {
  const v = Math.max(0, Math.min(100, volume)) / 100;
  return v * v * MAX_GAIN;
}

/**
 * 「音色」のつまみ (0〜100) を、ブラウン・ピンク・ホワイトの混ぜる割合にする。
 * 0〜50 はブラウンとピンク、50〜100 はピンクとホワイトを混ぜる。
 * 2 つの割合の 2 乗の和が常に 1 になるように混ぜる (等パワー)。
 * 直線で混ぜると、真ん中あたりで音が小さく聞こえる
 */
export function colorMix(value: number): { brown: number; pink: number; white: number } {
  const t = Math.max(0, Math.min(100, value)) / 100;
  if (t <= 0.5) {
    const a = (t / 0.5) * (Math.PI / 2);
    return { brown: Math.cos(a), pink: Math.sin(a), white: 0 };
  }
  const a = ((t - 0.5) / 0.5) * (Math.PI / 2);
  return { brown: 0, pink: Math.cos(a), white: Math.sin(a) };
}

/** つまみの位置の呼び名 */
export function colorName(value: number): string {
  if (value <= 10) return "ブラウン";
  if (value < 40) return "ブラウン寄り";
  if (value <= 60) return "ピンク";
  if (value < 90) return "ホワイト寄り";
  return "ホワイト";
}

/** ノイズを作り、TARGET_RMS に揃える */
function makeBuffer(c: AudioContext, kind: Kind): AudioBuffer {
  const length = Math.floor(c.sampleRate * SECONDS);
  const buf = c.createBuffer(1, length, c.sampleRate);
  const out = buf.getChannelData(0);
  if (kind === "white") {
    for (let i = 0; i < length; i++) out[i] = Math.random() * 2 - 1;
  } else if (kind === "brown") {
    // 白色ノイズを積み重ねる (少しずつ 0 に引き戻して、流れていかないようにする)
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      out[i] = last;
    }
  } else {
    // ピンク (Paul Kellet の近似)。白色ノイズを何段かのローパスに通す
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      out[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
    }
  }
  // 大きさを揃える。割れないよう、いちばん大きい山も 0.95 に収める
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < length; i++) {
    sum += out[i] * out[i];
    peak = Math.max(peak, Math.abs(out[i]));
  }
  const rms = Math.sqrt(sum / length) || 1;
  const scale = Math.min((TARGET_RMS * TRIM[kind]) / rms, 0.95 / (peak || 1));
  for (let i = 0; i < length; i++) out[i] *= scale;
  return buf;
}

/** 混ぜる割合を当てる。seconds だけかけて滑らせる */
function applyColor(seconds: number) {
  if (!ctx) return;
  const m = colorMix(color);
  const now = ctx.currentTime;
  for (const k of KINDS) {
    const g = mix.get(k)?.gain;
    if (!g) continue;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(m[k], now + seconds);
  }
}

/**
 * 鳴らし始める (鳴っていれば音量を合わせるだけ)。
 * 最初の 1 回はボタンを押した処理の中で呼ぶこと — ブラウザは、人の操作を
 * 受けた最中でないと音を出させない。
 */
export function noisePlay(volume: number, fadeSeconds = 2.5) {
  if (stopTimer !== null) {
    window.clearTimeout(stopTimer);
    stopTimer = null;
  }
  if (!ctx) {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    for (const k of KINDS) {
      const g = ctx.createGain();
      g.gain.value = colorMix(color)[k];
      g.connect(master);
      mix.set(k, g);
    }
  }
  void ctx.resume();
  if (sources.length === 0) {
    for (const k of KINDS) {
      if (!buffers.has(k)) buffers.set(k, makeBuffer(ctx, k));
      const s = ctx.createBufferSource();
      s.buffer = buffers.get(k)!;
      s.loop = true;
      s.connect(mix.get(k)!);
      s.start();
      sources.push(s);
    }
    applyColor(0);
  }
  const g = master!.gain;
  const now = ctx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(gainOf(volume), now + fadeSeconds);
}

/** 音量だけを変える (鳴っているときだけ効く) */
export function noiseVolume(volume: number) {
  if (!ctx || !master || sources.length === 0) return;
  const g = master.gain;
  const now = ctx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  // つまみを動かしたときに音が跳ねないよう、ほんの少しだけ滑らせる
  g.linearRampToValueAtTime(gainOf(volume), now + 0.08);
}

/** 音色 (0 = ブラウン、50 = ピンク、100 = ホワイト) を変える。鳴る前に呼んでもよい */
export function noiseColor(value: number) {
  color = Math.max(0, Math.min(100, value));
  applyColor(0.12);
}

/** 少しずつ小さくして止める */
export function noiseStop(fadeSeconds = 1.5) {
  if (!ctx || !master || sources.length === 0) return;
  const g = master.gain;
  const now = ctx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(0, now + fadeSeconds);
  const playing = sources;
  if (stopTimer !== null) window.clearTimeout(stopTimer);
  stopTimer = window.setTimeout(() => {
    stopTimer = null;
    for (const s of playing) {
      try {
        s.stop();
      } catch {
        /* もう止まっている */
      }
    }
    if (sources === playing) sources = [];
    void ctx?.suspend();
  }, fadeSeconds * 1000 + 50);
}

/* ---- つまみの値を覚えておく (この PC だけで覚える) ---- */

function load(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const v = Number(raw);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, v: number) {
  try {
    localStorage.setItem(key, String(Math.round(v)));
  } catch {
    /* 覚えられなくても、次は既定の値で始まるだけ */
  }
}

/** 0 まで下げて終えても、次は 5 から始める (無音のまま始まって「鳴らない」と迷わないように) */
export const savedNoiseVolume = () => Math.max(5, load("pomo-noise-volume", 30));
export const saveNoiseVolume = (v: number) => save("pomo-noise-volume", v);
/** 音色の既定は真ん中 (ピンク)。今までと同じ音から始まる */
export const savedNoiseColor = () => load("pomo-noise-color", 50);
export const saveNoiseColor = (v: number) => save("pomo-noise-color", v);

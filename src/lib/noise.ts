/**
 * ピンクノイズ。
 *
 * 音声ファイルは持たず、Web Audio でその場で作る。ネットワークも要らない。
 * 20 秒ぶんを作って繰り返し流す (ノイズなので継ぎ目は聞き分けられない)。
 *
 * 耳とまわりへの配慮:
 * - 音量の上限を抑えめにする (MAX_GAIN)。つまみの 100 でも大きくなりすぎない
 * - いきなり鳴らさず、数秒かけて大きくする。イヤホンを挿し忘れて
 *   スピーカーから流れても、すぐ気づいて止められるように
 * - 止めるときも少しずつ小さくする
 */

/** つまみを 100 にしたときの音量 (0〜1)。ここで上限を抑える */
const MAX_GAIN = 0.3;
/** 作っておくノイズの長さ (秒) */
const SECONDS = 20;

let ctx: AudioContext | null = null;
let gain: GainNode | null = null;
let source: AudioBufferSourceNode | null = null;
let buffer: AudioBuffer | null = null;
let stopTimer: number | null = null;

/** 0〜100 のつまみの値を音量にする。耳の感じ方に合わせて 2 乗で効かせる */
function gainOf(volume: number): number {
  const v = Math.max(0, Math.min(100, volume)) / 100;
  return v * v * MAX_GAIN;
}

/**
 * ピンクノイズを作る (Paul Kellet の近似)。白色ノイズを何段かの
 * ローパスに通し、高い音ほど弱くなる (1/f の) 音にする。
 */
function makeBuffer(c: AudioContext): AudioBuffer {
  const length = Math.floor(c.sampleRate * SECONDS);
  const buf = c.createBuffer(1, length, c.sampleRate);
  const out = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
  return buf;
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
    gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(ctx.destination);
  }
  void ctx.resume();
  if (!buffer) buffer = makeBuffer(ctx);
  if (!source) {
    source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain!);
    source.start();
  }
  const g = gain!.gain;
  const now = ctx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(gainOf(volume), now + fadeSeconds);
}

/** 音量だけを変える (鳴っているときだけ効く) */
export function noiseVolume(volume: number) {
  if (!ctx || !gain || !source) return;
  const g = gain.gain;
  const now = ctx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  // つまみを動かしたときに音が跳ねないよう、ほんの少しだけ滑らせる
  g.linearRampToValueAtTime(gainOf(volume), now + 0.08);
}

/** 少しずつ小さくして止める */
export function noiseStop(fadeSeconds = 1.5) {
  if (!ctx || !gain || !source) return;
  const g = gain.gain;
  const now = ctx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(0, now + fadeSeconds);
  const s = source;
  if (stopTimer !== null) window.clearTimeout(stopTimer);
  stopTimer = window.setTimeout(() => {
    stopTimer = null;
    try {
      s.stop();
    } catch {
      /* もう止まっている */
    }
    if (source === s) source = null;
    void ctx?.suspend();
  }, fadeSeconds * 1000 + 50);
}

/** 音量のつまみの値を覚えておく鍵 (この PC だけで覚える) */
const VOLUME_KEY = "pomo-noise-volume";

export function savedNoiseVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(v) && v > 0 ? Math.min(100, v) : 30;
  } catch {
    return 30;
  }
}

export function saveNoiseVolume(v: number) {
  try {
    localStorage.setItem(VOLUME_KEY, String(Math.round(v)));
  } catch {
    /* 覚えられなくても、次は既定の音量で始まるだけ */
  }
}

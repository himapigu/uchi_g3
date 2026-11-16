// 効果音。音声ファイルは使わず Web Audio API でその場で合成する（追加の素材・費用なし）。
// ブラウザの制約で、最初のクリックまでは音が鳴らない（unlock() で解除）。

const STORE_KEY = 'uchinoko-muted';
let ctx = null;
let master = null;
let muted = false;
try { muted = localStorage.getItem(STORE_KEY) === '1'; } catch { /* noop */ }

function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function unlock() { ac(); }
export const isMuted = () => muted;
export function setMuted(v) {
  muted = !!v;
  try { localStorage.setItem(STORE_KEY, muted ? '1' : '0'); } catch { /* noop */ }
}

/** 単音。freq から to へ周波数を動かす */
function tone(c, { freq, to = freq, dur = 0.1, type = 'square', vol = 0.15, at = 0, attack = 0.005 }) {
  const t0 = c.currentTime + at;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (to !== freq) o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

let noiseBuf = null;
/** ノイズ（打撃音・風切り音）。フィルタの周波数を freq → to に動かす */
function noise(c, { dur = 0.15, vol = 0.3, at = 0, freq = 1200, to = freq, filter = 'lowpass', q = 1 }) {
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const t0 = c.currentTime + at;
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  const f = c.createBiquadFilter();
  f.type = filter;
  f.Q.value = q;
  f.frequency.setValueAtTime(freq, t0);
  if (to !== freq) f.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

/** 音符の並び（[周波数, 長さ秒]） */
function melody(c, notes, { type = 'square', vol = 0.12, gap = 0 } = {}) {
  let at = 0;
  for (const [freq, dur] of notes) {
    if (freq) tone(c, { freq, dur: dur * 0.95, type, vol, at });
    at += dur + gap;
  }
}

// 音名 → 周波数
const N = { C4: 262, D4: 294, E4: 330, F4: 349, G4: 392, A4: 440, B4: 494, C5: 523, D5: 587, E5: 659, F5: 698, G5: 784, A5: 880, C6: 1047, Eb4: 311, Ab4: 415, Bb4: 466 };

const SOUNDS = {
  select: (c) => tone(c, { freq: 880, to: 1320, dur: 0.05, vol: 0.08 }),
  blip: (c) => tone(c, { freq: 1100, dur: 0.025, vol: 0.035 }),
  judge: (c) => tone(c, { freq: 180, to: 160, dur: 0.12, type: 'triangle', vol: 0.18 }),
  join: (c) => melody(c, [[N.E5, 0.08], [N.A5, 0.14]], { vol: 0.1 }),
  ok: (c) => melody(c, [[N.C5, 0.06], [N.G5, 0.12]], { type: 'triangle', vol: 0.15 }),
  yourTurn: (c) => tone(c, { freq: 1320, dur: 0.08, type: 'triangle', vol: 0.1 }),
  reveal: (c) => { tone(c, { freq: 660, dur: 0.06, vol: 0.1 }); tone(c, { freq: 990, dur: 0.12, vol: 0.1, at: 0.06 }); },
  fanfare: (c) => melody(c, [[N.G4, 0.1], [N.C5, 0.1], [N.E5, 0.1], [N.G5, 0.3]], { vol: 0.1 }),
  start: (c) => {
    melody(c, [[N.C5, 0.08], [N.C5, 0.08], [N.C5, 0.08], [N.G5, 0.35]], { type: 'sawtooth', vol: 0.07 });
    noise(c, { dur: 0.6, vol: 0.12, freq: 3000, to: 400, filter: 'bandpass', at: 0.24 });
  },
  use: (c) => noise(c, { dur: 0.18, vol: 0.25, freq: 600, to: 3000, filter: 'bandpass', q: 2 }),
  hit: (c) => {
    noise(c, { dur: 0.15, vol: 0.5, freq: 1800, to: 300 });
    tone(c, { freq: 160, to: 60, dur: 0.12, vol: 0.2 });
  },
  hitWeak: (c) => {
    noise(c, { dur: 0.1, vol: 0.3, freq: 900, to: 300 });
    tone(c, { freq: 120, to: 80, dur: 0.08, vol: 0.12 });
  },
  hitBig: (c) => {
    noise(c, { dur: 0.3, vol: 0.6, freq: 3000, to: 200 });
    tone(c, { freq: 220, to: 40, dur: 0.3, type: 'sawtooth', vol: 0.2 });
    noise(c, { dur: 0.2, vol: 0.4, freq: 2000, to: 200, at: 0.12 });
  },
  crit: (c) => { tone(c, { freq: 1760, dur: 0.06, vol: 0.12 }); tone(c, { freq: 2640, dur: 0.12, vol: 0.1, at: 0.06 }); },
  miss: (c) => noise(c, { dur: 0.25, vol: 0.2, freq: 3000, to: 500, filter: 'bandpass', q: 3 }),
  heal: (c) => melody(c, [[N.C5, 0.07], [N.E5, 0.07], [N.G5, 0.07], [N.C6, 0.18]], { type: 'sine', vol: 0.15 }),
  up: (c) => { tone(c, { freq: 400, to: 1200, dur: 0.18, vol: 0.1 }); tone(c, { freq: 600, to: 1600, dur: 0.18, vol: 0.08, at: 0.15 }); },
  down: (c) => { tone(c, { freq: 1000, to: 300, dur: 0.18, vol: 0.1 }); tone(c, { freq: 700, to: 180, dur: 0.22, vol: 0.08, at: 0.15 }); },
  stun: (c) => { for (let i = 0; i < 6; i++) tone(c, { freq: i % 2 ? 380 : 760, dur: 0.045, type: 'sawtooth', vol: 0.08, at: i * 0.05 }); },
  faint: (c) => { tone(c, { freq: 700, to: 50, dur: 0.7, type: 'sawtooth', vol: 0.12 }); noise(c, { dur: 0.3, vol: 0.2, freq: 400, to: 100, at: 0.5 }); },
  switchOut: (c) => tone(c, { freq: 900, to: 200, dur: 0.2, type: 'sine', vol: 0.15 }),
  switchIn: (c) => { tone(c, { freq: 200, to: 900, dur: 0.18, type: 'sine', vol: 0.15 }); noise(c, { dur: 0.1, vol: 0.25, freq: 2500, at: 0.18 }); },
  win: (c) => melody(c, [
    [N.C5, 0.12], [N.C5, 0.12], [N.C5, 0.12], [N.C5, 0.36], [N.Ab4, 0.36], [N.Bb4, 0.36], [N.C5, 0.12], [0, 0.12], [N.Bb4, 0.12], [N.C5, 0.6],
  ], { vol: 0.1 }),
  lose: (c) => melody(c, [[N.G4, 0.25], [N.Eb4, 0.25], [N.D4, 0.25], [N.C4, 0.7]], { type: 'triangle', vol: 0.15 }),
  draw: (c) => melody(c, [[N.E4, 0.2], [N.E4, 0.2], [N.E4, 0.5]], { type: 'triangle', vol: 0.15 }),
};

export function play(name) {
  if (muted) return;
  const c = ac();
  if (!c || c.state !== 'running') return;
  try { SOUNDS[name]?.(c); } catch (e) { console.warn(`効果音 ${name} を鳴らせませんでした`, e); } // ゲームは止めない
}

/**
 * Sound effects, made from nothing: short synthesized sounds (sine bursts, filtered noise) placed at the times the scenes' animations
 * happen. Nothing is sampled or downloaded, so there is nothing to license and nothing that needs a GPU.
 *
 * lib.js records `{ t, kind, gain }` for every snap, wipe, sweep and click while a scene is built; render.ts hands them to `track()`,
 * which mixes them into one mono 48 kHz track as long as the scene.
 */
export const SR = 48_000;
export type Kind = 'snap' | 'pop' | 'swish' | 'whoosh' | 'click' | 'tick' | 'type' | 'stamp' | 'alert' | 'caution' | 'ding';
export interface Event { t: number; kind: Kind; gain?: number }

// a fixed pseudo-random sequence, so the same scene always sounds the same
let seed = 1234567;
const noise = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0x80000000) - 1;

const make = (seconds: number, f: (t: number, i: number) => number): Float32Array => {
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = f(i / SR, i);
  return out;
};
const TAU = Math.PI * 2;

/** Filtered noise whose cut-off sweeps from `lo` to `hi` Hz: the sound of something moving past. */
function swoosh(seconds: number, lo: number, hi: number, level: number): Float32Array {
  let y = 0;
  return make(seconds, (t) => {
    const fc = lo + (hi - lo) * (t / seconds);
    y += (1 - Math.exp((-TAU * fc) / SR)) * (noise() - y);
    return y * Math.pow(Math.sin(Math.PI * (t / seconds)), 2) * level;
  });
}

const SOUNDS: Record<Kind, () => Float32Array> = {
  // a dull mechanical thunk, like a block locking into place
  snap: () => make(0.14, (t) => Math.sin(TAU * (55 + 45 * Math.exp(-t * 40)) * t) * Math.exp(-t * 28) * 0.9 + noise() * Math.exp(-t * 600) * 0.45),
  pop: () => make(0.1, (t) => Math.sin(TAU * (420 + 700 * Math.exp(-t * 55)) * t) * Math.exp(-t * 42) * 0.5),
  swish: () => swoosh(0.22, 500, 5200, 0.55),
  whoosh: () => {
    const body = swoosh(0.5, 180, 3600, 0.75);
    // a low thump as it lands
    const thump = make(0.5, (t) => (t > 0.34 ? Math.sin(TAU * 52 * (t - 0.34)) * Math.exp(-(t - 0.34) * 22) * 0.7 : 0));
    return body.map((v, i) => v + thump[i]!);
  },
  click: () => make(0.04, (t) => noise() * Math.exp(-t * 900) * 0.55 + Math.sin(TAU * 2300 * t) * Math.exp(-t * 230) * 0.4),
  tick: () => make(0.025, (t) => Math.sin(TAU * 1500 * t) * Math.exp(-t * 300) * 0.4),
  type: () => make(0.03, (t) => noise() * Math.exp(-t * 700) * 0.35 + Math.sin(TAU * 900 * t) * Math.exp(-t * 200) * 0.2),
  // a heavier hit for a stamp
  stamp: () => make(0.26, (t) => Math.sin(TAU * (46 + 70 * Math.exp(-t * 32)) * t) * Math.exp(-t * 15) + noise() * Math.exp(-t * 260) * 0.65),
  // two falling tones: the critical-risk warning
  alert: () => make(0.36, (t) => {
    const second = t >= 0.17;
    const f = second ? 620 : 840, u = second ? t - 0.17 : t;
    const env = u < 0.12 ? Math.min(1, u / 0.006) * Math.exp(-u * 6) : 0;
    return (Math.sin(TAU * f * u) + 0.3 * Math.sin(TAU * f * 3 * u)) * env * 0.38;
  }),
  // one softer tone: caution
  caution: () => make(0.2, (t) => Math.sin(TAU * 700 * t) * Math.min(1, t / 0.006) * Math.exp(-t * 14) * 0.38),
  // a bell for "finished"
  ding: () => make(0.7, (t) => (Math.sin(TAU * 1320 * t) * 0.4 + Math.sin(TAU * 1980 * t) * 0.14) * Math.exp(-t * 7) * Math.min(1, t / 0.004)),
};

/** Minimum gap between two sounds of the same kind, in ms: a run of 31 snaps is a few thuds, not a machine gun. */
const SPACING: Record<Kind, number> = { snap: 90, pop: 80, swish: 130, whoosh: 300, click: 60, tick: 55, type: 34, stamp: 150, alert: 400, caution: 400, ding: 300 };

export function track(events: Event[], durationMs: number, master = 0.5): Int16Array {
  const total = Math.round((durationMs / 1000) * SR);
  const mix = new Float32Array(total);
  const cache = new Map<Kind, Float32Array>();
  const last = new Map<Kind, number>();
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (e.t < 0 || e.t >= durationMs) continue;
    if (e.t - (last.get(e.kind) ?? -1e9) < SPACING[e.kind]) continue;
    last.set(e.kind, e.t);
    let sound = cache.get(e.kind);
    if (!sound) cache.set(e.kind, (sound = SOUNDS[e.kind]()));
    const start = Math.round((e.t / 1000) * SR), g = (e.gain ?? 1) * master;
    for (let i = 0; i < sound.length && start + i < total; i++) mix[start + i]! += sound[i]! * g;
  }
  // a soft limiter, so a busy moment bends instead of clipping
  const out = new Int16Array(total);
  for (let i = 0; i < total; i++) out[i] = Math.round(Math.tanh(mix[i]!) * 32767);
  return out;
}

export function wav(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const text = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  text(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE'); text(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, 'data'); v.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => v.setInt16(44 + i * 2, s, true));
  return bytes;
}

/** Synthetische Testsignale – nur für isolierte Tests, nie im echten Verlauf. */

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number): () => number {
  return () => {
    const u = Math.max(1e-12, rand());
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

/** Weißes Rauschen mit RMS-Pegel in dBFS. */
export function whiteNoise(sr: number, seconds: number, dbfs: number, seed = 1): Float32Array {
  const g = gaussian(rng(seed));
  const amp = Math.pow(10, dbfs / 20);
  const out = new Float32Array(Math.round(sr * seconds));
  for (let i = 0; i < out.length; i++) out[i] = g() * amp;
  return out;
}

/** Tieffrequentes, böiges Windrumpeln (unter ~120 Hz). */
export function wind(sr: number, seconds: number, amp: number, seed = 7): Float32Array {
  const g = gaussian(rng(seed));
  const out = new Float32Array(Math.round(sr * seconds));
  // stark tiefpassgefiltertes Rauschen + langsame Böen-Modulation
  let y1 = 0;
  let y2 = 0;
  const a = Math.exp((-2 * Math.PI * 60) / sr);
  for (let i = 0; i < out.length; i++) {
    y1 = a * y1 + (1 - a) * g();
    y2 = a * y2 + (1 - a) * y1;
    const gust = 0.6 + 0.4 * Math.sin((2 * Math.PI * 0.4 * i) / sr);
    out[i] = y2 * 40 * amp * gust;
  }
  return out;
}

/** Ball-Schläger-Kontakt: kurzer, gedämpfter „Pock“ (Grundton + Obertöne). */
export function pock(sr: number, amp: number, freq = 1800, decayMs = 5): Float32Array {
  const len = Math.round(sr * 0.04);
  const out = new Float32Array(len);
  const tau = (decayMs / 1000) * sr;
  for (let i = 0; i < len; i++) {
    const env = Math.exp(-i / tau);
    out[i] =
      amp *
      env *
      (0.7 * Math.sin((2 * Math.PI * freq * i) / sr) + 0.3 * Math.sin((2 * Math.PI * freq * 2.3 * i) / sr));
  }
  return out;
}

export function mixAt(target: Float32Array, src: Float32Array, atSec: number, sr: number): void {
  const start = Math.round(atSec * sr);
  for (let i = 0; i < src.length && start + i < target.length; i++) target[start + i] += src[i];
}

export function add(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
}

/** Verarbeitet ein Signal in 128er-Blöcken (wie AudioWorklet) und zählt Impulse. */
export function runBlocks(process: (block: Float32Array) => number, signal: Float32Array, block = 128): number {
  let hits = 0;
  for (let i = 0; i < signal.length; i += block) hits += process(signal.subarray(i, Math.min(signal.length, i + block)));
  return hits;
}

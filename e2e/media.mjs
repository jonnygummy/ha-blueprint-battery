// Synthetische Testmedien für die Browser-Tests (nur für isolierte Tests).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SR = 48000;
export const DURATION = 22;
export const HIT_TIMES = [7, 8.1, 9.0, 10.2, 11.0, 12.3, 13.1, 14.0, 15.2, 16.0]; // 10 Schlaggeräusche

/** Mono-WAV: Rauschen + Windrumpeln + 10 „Pock“-Geräusche. */
export function makeWav(dir) {
  let seed = 12345;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, rand()))) * Math.cos(2 * Math.PI * rand());
  const n = SR * DURATION;
  const x = new Float32Array(n);
  const noiseAmp = Math.pow(10, -52 / 20);
  for (let i = 0; i < n; i++) x[i] = gauss() * noiseAmp;
  let y1 = 0, y2 = 0;
  const a = Math.exp((-2 * Math.PI * 60) / SR);
  for (let i = 0; i < n; i++) {
    y1 = a * y1 + (1 - a) * gauss();
    y2 = a * y2 + (1 - a) * y1;
    x[i] += y2 * 4;
  }
  for (const t of HIT_TIMES) {
    const s = Math.round(t * SR);
    const tau = 0.005 * SR;
    for (let i = 0; i < SR * 0.04; i++) {
      const env = Math.exp(-i / tau);
      x[s + i] += 0.35 * env * (0.7 * Math.sin((2 * Math.PI * 1800 * i) / SR) + 0.3 * Math.sin((2 * Math.PI * 4100 * i) / SR));
    }
  }
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  const p = join(dir, 'fake-mic.wav');
  writeFileSync(p, buf);
  return p;
}

/**
 * Y4M-Video (Hochformat 120×160, 30 fps): Sand mit Bildrauschen, zwei langsam
 * schwankende Spieler, und bei den Schlägen in `swingAt` ein schneller Schlägerschwung.
 */
export function makeY4m(dir, swingAt) {
  const W = 120, H = 160, FPS = 30;
  const frames = DURATION * FPS;
  let seed = 777;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const ySize = W * H;
  const cSize = (W / 2) * (H / 2);
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420jpeg\n`);
  const chunks = [header];
  for (let f = 0; f < frames; f++) {
    const t = f / FPS;
    const y = Buffer.alloc(ySize);
    for (let i = 0; i < ySize; i++) y[i] = 170 + Math.floor((rand() - 0.5) * 6);
    // Himmel/Meer oben
    for (let r = 0; r < 30; r++) for (let c = 0; c < W; c++) y[r * W + c] = 200;
    // zwei Spieler, die langsam hin und her schwanken
    const sway = Math.round(2 * Math.sin(t * 1.5));
    const player = (x0) => {
      for (let r = 70; r < 130; r++) for (let c = x0 + sway; c < x0 + sway + 10; c++) y[r * W + c] = 60;
    };
    player(15);
    player(95);
    // schneller Schwung: Schläger fegt über ~4 Bilder um den Schlagzeitpunkt
    for (const s of swingAt) {
      const k = Math.round((t - s) * FPS);
      if (k >= -2 && k <= 2) {
        const x0 = 25 + (k + 2) * 7;
        for (let r = 80; r < 100; r++) for (let c = x0; c < x0 + 6; c++) y[r * W + c] = 20;
      }
    }
    const u = Buffer.alloc(cSize, 128);
    const v = Buffer.alloc(cSize, 128);
    chunks.push(Buffer.from('FRAME\n'), y, u, v);
  }
  const p = join(dir, 'fake-cam.y4m');
  writeFileSync(p, Buffer.concat(chunks));
  return p;
}

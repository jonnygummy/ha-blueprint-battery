import { describe, expect, it } from 'vitest';
import { MotionTracker, motionThreshold, rgbaToGray } from '../src/camera/motionCore';
import { HitFusion, FUSION_DECIDE_MS, type FusionDecision } from '../src/game/fusion';
import { rng } from './signals';

const W = 96;
const H = 128;

/** Synthetisches Strandbild: Sand mit Bildrauschen, optional ein bewegter Block (Schläger). */
function frame(seed: number, opts: { block?: { x: number; y: number; w: number; h: number; v: number }; brightness?: number } = {}): Uint8Array {
  const r = rng(seed);
  const img = new Uint8Array(W * H);
  const base = opts.brightness ?? 150;
  for (let i = 0; i < img.length; i++) img[i] = Math.max(0, Math.min(255, base + (r() - 0.5) * 8));
  const b = opts.block;
  if (b) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) img[y * W + x] = b.v;
  return img;
}

describe('Bewegungserkennung', () => {
  it('ruhiges Bild mit Sensorrauschen bleibt unter der Schwelle', () => {
    const m = new MotionTracker(W, H);
    let max = 0;
    for (let i = 0; i < 90; i++) max = Math.max(max, m.process(frame(i), i * 33));
    expect(max).toBeLessThan(motionThreshold(10));
  });

  it('ein schneller Schwung erzeugt eine deutliche Spitze an der richtigen Stelle', () => {
    const m = new MotionTracker(W, H);
    for (let i = 0; i < 60; i++) m.process(frame(i), i * 33);
    const s1 = m.process(frame(100, { block: { x: 16, y: 40, w: 10, h: 24, v: 40 } }), 60 * 33);
    const s2 = m.process(frame(101, { block: { x: 30, y: 40, w: 10, h: 24, v: 40 } }), 61 * 33);
    expect(Math.max(s1, s2)).toBeGreaterThan(motionThreshold(6));
    const peakCol = m.lastPeakCell % m.cols;
    expect(peakCol).toBeGreaterThanOrEqual(1);
    expect(peakCol).toBeLessThanOrEqual(5);
  });

  it('Belichtungssprung des ganzen Bildes zählt nicht als Bewegung', () => {
    const m = new MotionTracker(W, H);
    for (let i = 0; i < 60; i++) m.process(frame(i), i * 33);
    const s = m.process(frame(200, { brightness: 185 }), 61 * 33);
    expect(s).toBeLessThan(motionThreshold(6));
  });

  it('dauernde Bewegung an einer Stelle (Wellen) wird zum Hintergrund', () => {
    const m = new MotionTracker(W, H);
    let last = 0;
    for (let i = 0; i < 150; i++) {
      // flackernder Streifen oben im Bild, jedes Bild anders
      last = m.process(frame(i, { block: { x: 0, y: 0, w: W, h: 16, v: i % 2 ? 90 : 200 } }), i * 33);
    }
    expect(last).toBeLessThan(motionThreshold(6));
  });

  it('peak() liefert null, wenn im Zeitfenster kein Bild ankam', () => {
    const m = new MotionTracker(W, H);
    for (let i = 0; i < 10; i++) m.process(frame(i), i * 33);
    expect(m.peak(5000, 6000)).toBeNull();
    expect(m.peak(0, 400)).not.toBeNull();
  });

  it('Graustufen-Umrechnung', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 0, 0, 255]);
    const out = new Uint8Array(3);
    rgbaToGray(rgba, out);
    expect(out[0]).toBeGreaterThan(250);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(76);
  });
});

describe('Ton + Bild (Zeitfenster)', () => {
  function setup(peakValue: number | null, typicalValue: number | null = 2) {
    let now = 1000;
    const timers: { at: number; fn: () => void; id: number }[] = [];
    let nextId = 1;
    const clock = {
      mono: () => now,
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextId++;
        timers.push({ at: now + ms, fn, id });
        return id;
      },
      clearTimeout: (id: number) => {
        const i = timers.findIndex((t) => t.id === id);
        if (i >= 0) timers.splice(i, 1);
      },
    };
    const windows: [number, number][] = [];
    const decisions: FusionDecision[] = [];
    const fusion = new HitFusion(
      clock,
      {
        peak: (t0, t1) => {
          windows.push([t0, t1]);
          return peakValue;
        },
        typical: () => typicalValue,
      },
      (d) => decisions.push(d),
      9,
    );
    const advance = (ms: number) => {
      now += ms;
      for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) {
        if (t.at <= now) t.fn();
        else timers.push(t);
      }
    };
    return { fusion, decisions, windows, advance };
  }

  it('bestätigt bei Bewegung im Fenster, nach der Entscheidungszeit', () => {
    const f = setup(20);
    f.fusion.submit(7);
    f.advance(FUSION_DECIDE_MS - 10);
    expect(f.decisions).toHaveLength(0);
    f.advance(20);
    expect(f.decisions).toEqual([expect.objectContaining({ gen: 7, outcome: 'confirmed' })]);
    // Fenster beginnt vor dem Ton und reicht danach länger (Kamera-Latenz)
    expect(f.windows[0][0]).toBeLessThan(1000);
    expect(f.windows[0][1]).toBeGreaterThan(1000 + 200);
  });

  it('verwirft ohne Bewegung', () => {
    const f = setup(3);
    f.fusion.submit(1);
    f.advance(FUSION_DECIDE_MS);
    expect(f.decisions[0].outcome).toBe('rejected');
  });

  it('ohne Kamerabilder im Fenster: „nocamera“ (wird gezählt, damit nichts verloren geht)', () => {
    const f = setup(null);
    f.fusion.submit(1);
    f.advance(FUSION_DECIDE_MS);
    expect(f.decisions[0].outcome).toBe('nocamera');
  });

  it('verwirft, wenn die Bewegung nicht über der üblichen Bewegung davor liegt (Spieler laufen)', () => {
    const f = setup(20, 14);
    f.fusion.submit(1);
    f.advance(FUSION_DECIDE_MS);
    expect(f.decisions[0].outcome).toBe('rejected');
    const g = setup(40, 14);
    g.fusion.submit(1);
    g.advance(FUSION_DECIDE_MS);
    expect(g.decisions[0].outcome).toBe('confirmed');
  });

  it('cancelAll verwirft offene Kandidaten (Stopp)', () => {
    const f = setup(20);
    f.fusion.submit(1);
    f.fusion.submit(1);
    f.fusion.cancelAll();
    f.advance(1000);
    expect(f.decisions).toHaveLength(0);
  });
});

/**
 * Bewegungserkennung für die Kamera-Bestätigung.
 *
 * Reine Logik ohne Browser-Abhängigkeit. Pro Kamerabild (klein skaliert, Graustufen):
 *  1. Absolute Differenz zum vorigen Bild, gemittelt je Rasterzelle (8×8 Pixel).
 *  2. Je Zelle ein langsam nachgeführter Hintergrund (Wellen, wehende Handtücher).
 *  3. Belichtungssprünge werden über den Median aller Zellen herausgerechnet.
 *  4. Bildwert = stärkster lokaler Überschuss. Ein Schlägerschwung erzeugt hier eine Spitze.
 *
 * Bilder werden nur im Speicher verglichen und sofort verworfen, nie gespeichert.
 */

export interface MotionSample {
  t: number;
  score: number;
}

export const MOTION_SENSITIVITY_MIN = 1;
export const MOTION_SENSITIVITY_MAX = 10;
export const MOTION_SENSITIVITY_DEFAULT = 6;

/** Ordnet den Bewegungsregler (1–10) der Bestätigungsschwelle zu (Graustufen 0–255). */
export function motionThreshold(sensitivity: number): number {
  const s = Math.min(MOTION_SENSITIVITY_MAX, Math.max(MOTION_SENSITIVITY_MIN, sensitivity));
  return 30 - 2.5 * s; // 1 → 27.5 … 6 → 15 … 10 → 5
}

/** Ein Schwung muss mindestens so viel stärker sein als die übliche Bewegung davor. */
export const MOTION_RATIO = 2;

const BASELINE_TAU_MS = 800;
const HISTORY_MS = 4000;

export class MotionTracker {
  readonly width: number;
  readonly height: number;
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  private prev: Uint8Array | null = null;
  private prevT = 0;
  private readonly baseline: Float32Array;
  private readonly cellDiff: Float32Array;
  private readonly sorted: Float32Array;
  private warm = 0;
  private history: MotionSample[] = [];
  lastFrameAt = -Infinity;
  /** Zelle mit dem stärksten Überschuss im letzten Bild (für die Vorschau). */
  lastPeakCell = -1;
  lastScore = 0;

  constructor(width: number, height: number, cell = 8) {
    this.width = width;
    this.height = height;
    this.cell = cell;
    this.cols = Math.floor(width / cell);
    this.rows = Math.floor(height / cell);
    const n = this.cols * this.rows;
    this.baseline = new Float32Array(n);
    this.cellDiff = new Float32Array(n);
    this.sorted = new Float32Array(n);
  }

  reset(): void {
    this.prev = null;
    this.warm = 0;
    this.history = [];
    this.baseline.fill(0);
    this.lastFrameAt = -Infinity;
    this.lastScore = 0;
    this.lastPeakCell = -1;
  }

  /** Verarbeitet ein Graustufenbild (width×height). Gibt den Bewegungswert zurück. */
  process(gray: Uint8Array, t: number): number {
    const { width, cell, cols, rows } = this;
    if (!this.prev) {
      this.prev = new Uint8Array(gray);
      this.prevT = t;
      this.lastFrameAt = t;
      return 0;
    }
    const prev = this.prev;
    const area = cell * cell;
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        let sum = 0;
        const x0 = cx * cell;
        for (let y = cy * cell; y < (cy + 1) * cell; y++) {
          const row = y * width + x0;
          for (let x = 0; x < cell; x++) {
            const d = gray[row + x] - prev[row + x];
            sum += d < 0 ? -d : d;
          }
        }
        this.cellDiff[cy * cols + cx] = sum / area;
      }
    }
    prev.set(gray);

    // Belichtungs- und Gesamthelligkeitssprünge: Median der Zellen abziehen
    this.sorted.set(this.cellDiff);
    this.sorted.sort();
    const median = this.sorted[this.sorted.length >> 1];

    const dt = Math.max(1, t - this.prevT);
    this.prevT = t;
    const a = 1 - Math.exp(-dt / BASELINE_TAU_MS);
    let best = 0;
    let bestCell = -1;
    const n = this.cellDiff.length;
    for (let i = 0; i < n; i++) {
      const d = Math.max(0, this.cellDiff[i] - median);
      const b = this.baseline[i];
      const excess = this.warm < 3 ? 0 : d - b;
      if (excess > best) {
        best = excess;
        bestCell = i;
      }
      // Kurze Spitzen (Schwung: 1–3 Bilder) ziehen den Hintergrund kaum mit,
      // anhaltende Bewegung (Wellen) wird nach 2–3 Sekunden zum Hintergrund.
      this.baseline[i] = b + a * (Math.min(d, b * 2 + 6) - b);
    }
    this.warm++;

    this.lastFrameAt = t;
    this.lastScore = best;
    this.lastPeakCell = bestCell;
    this.history.push({ t, score: best });
    const cutoff = t - HISTORY_MS;
    let drop = 0;
    while (drop < this.history.length && this.history[drop].t < cutoff) drop++;
    if (drop > 0) this.history.splice(0, drop);
    return best;
  }

  /** p-Quantil der Bewegungswerte im Zeitfenster (übliche Bewegung); null ohne Bilder. */
  quantile(t0: number, t1: number, p: number): number | null {
    const vals: number[] = [];
    for (const s of this.history) if (s.t >= t0 && s.t <= t1) vals.push(s.score);
    if (vals.length === 0) return null;
    vals.sort((a, b) => a - b);
    return vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
  }

  /** Höchster Bewegungswert im Zeitfenster; null, wenn darin kein Bild ankam. */
  peak(t0: number, t1: number): number | null {
    let max: number | null = null;
    for (const s of this.history) {
      if (s.t < t0 || s.t > t1) continue;
      if (max === null || s.score > max) max = s.score;
    }
    return max;
  }
}

/** RGBA → Graustufen (BT.601-Näherung, ganzzahlig). */
export function rgbaToGray(rgba: Uint8ClampedArray, out: Uint8Array): void {
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }
}

/**
 * Kamera-Bestätigung: Ein Ton-Kandidat zählt nur, wenn im Kamerabild zur selben Zeit
 * eine schnelle Bewegung (Schlägerschwung) zu sehen ist.
 *
 * Zeitbezug: Ankunftszeit des Ton-Ereignisses im Haupt-Thread (performance.now).
 * Kamerabilder kommen typischerweise 50–150 ms später an als der Ton, daher ist das
 * Fenster nach hinten länger. Die Entscheidung fällt, sobald das Fenster abgelaufen ist.
 * Alle Werte sind abstimmbare Ausgangswerte.
 */

export interface FusionClock {
  mono(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

export const FUSION_BEFORE_MS = 250;
export const FUSION_AFTER_MS = 300;
export const FUSION_DECIDE_MS = 360;
/** Vergleichsfenster für die übliche Bewegung vor dem Schlag. */
export const FUSION_BACKGROUND_FROM_MS = 2250;
export const FUSION_BACKGROUND_TO_MS = 350;
export const FUSION_RATIO = 2;

export type FusionOutcome = 'confirmed' | 'rejected' | 'nocamera';

export interface FusionDecision {
  gen: number;
  outcome: FusionOutcome;
  peak: number | null;
  /** übliche Bewegung vor dem Schlag */
  typical: number | null;
  t: number;
}

export interface MotionSource {
  peak(t0: number, t1: number): number | null;
  typical(t0: number, t1: number): number | null;
}

export interface FusionStats {
  candidates: number;
  confirmed: number;
  rejected: number;
  /** ohne Kamerabilder im Zeitfenster – gezählt, damit keine Schläge verloren gehen */
  noCamera: number;
}

export function emptyStats(): FusionStats {
  return { candidates: 0, confirmed: 0, rejected: 0, noCamera: 0 };
}

export class HitFusion {
  private readonly pending = new Map<number, { gen: number; t: number }>();
  threshold: number;

  constructor(
    private readonly clock: FusionClock,
    private readonly motion: MotionSource,
    private readonly decide: (d: FusionDecision) => void,
    threshold: number,
  ) {
    this.threshold = threshold;
  }

  /** Ton-Kandidat einreichen; die Entscheidung kommt verzögert über `decide`. */
  submit(gen: number, t = this.clock.mono()): void {
    const id = this.clock.setTimeout(() => {
      const p = this.pending.get(id);
      this.pending.delete(id);
      if (!p) return;
      const peak = this.motion.peak(p.t - FUSION_BEFORE_MS, p.t + FUSION_AFTER_MS);
      const typical = this.motion.typical(p.t - FUSION_BACKGROUND_FROM_MS, p.t - FUSION_BACKGROUND_TO_MS);
      let outcome: FusionOutcome;
      if (peak === null) outcome = 'nocamera';
      else {
        // fester Mindestwert UND deutlich über der üblichen Bewegung (Spieler laufen ständig)
        const relativeOk = typical === null || peak >= typical * FUSION_RATIO + 2;
        outcome = peak >= this.threshold && relativeOk ? 'confirmed' : 'rejected';
      }
      this.decide({ gen: p.gen, outcome, peak, typical, t: p.t });
    }, FUSION_DECIDE_MS);
    this.pending.set(id, { gen, t });
  }

  /** Offene Kandidaten verwerfen (Stopp, Pause, neue Runde). */
  cancelAll(): void {
    for (const id of this.pending.keys()) this.clock.clearTimeout(id);
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}

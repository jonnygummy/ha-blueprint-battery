/** Reine Achsenberechnung: echte Zeitachse (x) und ganzzahlige Schlagachse ab null (y). */
import { sameLocalDay, startOfLocalDay } from '../stats/stats';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export interface TimeDomain {
  min: number;
  max: number;
}

/** Zeitbereich mit etwas Rand; ein einzelner Punkt bekommt ±30 Minuten. */
export function timeDomain(times: number[]): TimeDomain | null {
  if (times.length === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of times) {
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  if (hi - lo < MIN) return { min: lo - 30 * MIN, max: hi + 30 * MIN };
  const pad = Math.max(2 * MIN, (hi - lo) * 0.05);
  return { min: lo - pad, max: hi + pad };
}

/** true, wenn die Spiele an verschiedenen lokalen Kalendertagen liegen. */
export function spansMultipleDays(times: number[]): boolean {
  if (times.length < 2) return false;
  const first = Math.min(...times);
  const last = Math.max(...times);
  return !sameLocalDay(first, last);
}

const MINUTE_STEPS = [1, 2, 5, 10, 15, 30].map((m) => m * MIN);
const HOUR_STEPS = [1, 2, 3, 6, 12].map((h) => h * HOUR);
const DAY_STEPS = [1, 2, 7, 14, 30, 61, 91, 182, 365];

export interface TimeTicks {
  ticks: number[];
  stepMs: number;
  dayStep: boolean;
}

/** Ticks an „runden“ lokalen Uhrzeiten bzw. Mitternacht ausgerichtet. */
export function timeTicks(domain: TimeDomain, maxTicks: number): TimeTicks {
  const span = domain.max - domain.min;
  for (const step of [...MINUTE_STEPS, ...HOUR_STEPS]) {
    if (span / step <= maxTicks) {
      const ticks: number[] = [];
      let base = startOfLocalDay(domain.min);
      let t = base + Math.ceil((domain.min - base) / step) * step;
      while (t <= domain.max) {
        // bei Tageswechsel an lokaler Mitternacht neu ausrichten (Sommerzeit)
        const dayStart = startOfLocalDay(t);
        if (dayStart !== base) {
          base = dayStart;
          t = base + Math.ceil((t - base) / step) * step;
          if (t > domain.max) break;
        }
        ticks.push(t);
        t += step;
      }
      return { ticks, stepMs: step, dayStep: false };
    }
  }
  for (const days of DAY_STEPS) {
    if (span / (days * DAY) <= maxTicks || days === DAY_STEPS[DAY_STEPS.length - 1]) {
      const ticks: number[] = [];
      const d = new Date(startOfLocalDay(domain.min));
      if (d.getTime() < domain.min) d.setDate(d.getDate() + 1);
      while (d.getTime() <= domain.max) {
        ticks.push(d.getTime());
        d.setDate(d.getDate() + days);
      }
      return { ticks, stepMs: days * DAY, dayStep: true };
    }
  }
  return { ticks: [], stepMs: DAY, dayStep: true };
}

export interface CountAxis {
  max: number;
  ticks: number[];
}

/** Ganzzahlige y-Achse ab null mit höchstens ~5 Abschnitten. */
export function countAxis(maxValue: number, maxSegments = 5): CountAxis {
  const m = Math.max(0, Math.ceil(maxValue));
  if (m === 0) return { max: 5, ticks: [0, 1, 2, 3, 4, 5] };
  const candidates = [1, 2, 5];
  let step = 1;
  outer: for (let mag = 1; mag <= 1e9; mag *= 10) {
    for (const c of candidates) {
      if (Math.ceil(m / (c * mag)) <= maxSegments) {
        step = c * mag;
        break outer;
      }
    }
  }
  const max = Math.ceil(m / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += step) ticks.push(v);
  return { max, ticks };
}

export function linear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v) => r0 + (v - d0) * k;
}

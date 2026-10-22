import type { GameRecord } from '../storage/gameStore';

export type RangeFilter = 'today' | 'all';

export interface Summary {
  count: number;
  total: number;
  /** null bei leerem Zeitraum (Anzeige „–“). */
  best: number | null;
  /** Auf eine Nachkommastelle gerundet; null bei leerem Zeitraum. */
  average: number | null;
}

/** Beginn des lokalen Kalendertags (Zeitzone des Geräts). */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function sameLocalDay(a: number, b: number): boolean {
  return startOfLocalDay(a) === startOfLocalDay(b);
}

export function filterGames(games: GameRecord[], range: RangeFilter, now: number): GameRecord[] {
  if (range === 'all') return games.slice();
  const dayStart = startOfLocalDay(now);
  const next = new Date(dayStart);
  next.setDate(next.getDate() + 1);
  const dayEnd = next.getTime();
  return games.filter((g) => g.startTime >= dayStart && g.startTime < dayEnd);
}

export function summarize(games: GameRecord[]): Summary {
  if (games.length === 0) return { count: 0, total: 0, best: null, average: null };
  let total = 0;
  let best = 0;
  for (const g of games) {
    total += g.hits;
    if (g.hits > best) best = g.hits;
  }
  return {
    count: games.length,
    total,
    best,
    average: Math.round((total / games.length) * 10) / 10,
  };
}

/** Bestwert über den gesamten gespeicherten Verlauf. */
export function bestOverall(games: GameRecord[]): number | null {
  return summarize(games).best;
}

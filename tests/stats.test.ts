import { describe, expect, it } from 'vitest';
import { countAxis, spansMultipleDays, timeDomain, timeTicks } from '../src/chart/scales';
import { bestOverall, filterGames, summarize } from '../src/stats/stats';
import type { GameRecord } from '../src/storage/gameStore';

// Läuft mit TZ=Asia/Nicosia (siehe npm test), damit „Heute“ das lokale Datum prüft.
const g = (n: number, iso: string, hits: number): GameRecord => {
  const start = Date.parse(iso);
  return { id: `t${n}`, number: n, startTime: start, endTime: start + 60_000, activeMs: 60_000, hits };
};

describe('Kennzahlen', () => {
  const games = [g(1, '2026-10-21T20:30:00Z', 40), g(2, '2026-10-21T21:30:00Z', 12), g(3, '2026-10-22T08:00:00Z', 7), g(4, '2026-10-22T09:00:00Z', 8)];

  it('„Heute“ nutzt das lokale Datum des Geräts', () => {
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Asia/Nicosia');
    const now = Date.parse('2026-10-22T10:00:00Z'); // 13:00 Ortszeit
    // 21:30Z am 21.10. ist 00:30 Ortszeit am 22.10. → zählt zu heute
    expect(filterGames(games, 'today', now).map((x) => x.number)).toEqual([2, 3, 4]);
    expect(filterGames(games, 'all', now)).toHaveLength(4);
  });

  it('berechnet Anzahl, Summe, Bestwert und Durchschnitt (1 Nachkommastelle)', () => {
    const s = summarize(games.slice(1));
    expect(s).toEqual({ count: 3, total: 27, best: 12, average: 9 });
    expect(summarize([g(1, '2026-10-22T08:00:00Z', 1), g(2, '2026-10-22T08:10:00Z', 2), g(3, '2026-10-22T08:20:00Z', 2)]).average).toBe(1.7);
  });

  it('leerer Zeitraum liefert keine irreführenden Zahlen', () => {
    expect(summarize([])).toEqual({ count: 0, total: 0, best: null, average: null });
    expect(bestOverall([])).toBeNull();
  });

  it('Bestwert gesamt bezieht sich auf alle Spiele', () => {
    expect(bestOverall(games)).toBe(40);
  });
});

describe('Diagrammachsen', () => {
  it('einzelner Punkt bekommt einen sichtbaren Zeitbereich', () => {
    const t = Date.parse('2026-10-22T10:00:00Z');
    const d = timeDomain([t])!;
    expect(d.min).toBeLessThan(t);
    expect(d.max).toBeGreaterThan(t);
    expect(timeDomain([])).toBeNull();
  });

  it('Zeitachse ist echt: Ticks aufsteigend, im Bereich, an runden Uhrzeiten', () => {
    const times = [Date.parse('2026-10-22T09:03:00Z'), Date.parse('2026-10-22T09:40:00Z'), Date.parse('2026-10-22T11:55:00Z')];
    const d = timeDomain(times)!;
    const tt = timeTicks(d, 5);
    expect(tt.ticks.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < tt.ticks.length; i++) expect(tt.ticks[i]).toBeGreaterThan(tt.ticks[i - 1]);
    for (const t of tt.ticks) {
      expect(t).toBeGreaterThanOrEqual(d.min);
      expect(t).toBeLessThanOrEqual(d.max);
      expect(new Date(t).getMinutes() % 15).toBe(0);
    }
  });

  it('erkennt mehrere Tage für Datum-Beschriftung', () => {
    expect(spansMultipleDays([Date.parse('2026-10-21T15:00:00Z'), Date.parse('2026-10-22T15:00:00Z')])).toBe(true);
    expect(spansMultipleDays([Date.parse('2026-10-22T06:00:00Z'), Date.parse('2026-10-22T15:00:00Z')])).toBe(false);
  });

  it('y-Achse beginnt bei null und ist ganzzahlig', () => {
    for (const max of [0, 1, 3, 7, 12, 48, 133, 999]) {
      const a = countAxis(max);
      expect(a.ticks[0]).toBe(0);
      expect(a.max).toBeGreaterThanOrEqual(max);
      expect(a.ticks.every(Number.isInteger)).toBe(true);
      expect(a.ticks.length).toBeLessThanOrEqual(7);
    }
  });
});

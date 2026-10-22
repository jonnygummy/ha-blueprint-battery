/** Formatierung in der lokalen Zeitzone des Geräts, deutschsprachig. */

const timeFmt = new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const shortDateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' });
const weekdayFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'short' });

export function fmtTime(ts: number): string {
  return timeFmt.format(ts);
}

export function fmtDate(ts: number): string {
  return dateFmt.format(ts);
}

export function fmtShortDate(ts: number): string {
  return shortDateFmt.format(ts);
}

export function fmtWeekday(ts: number): string {
  return weekdayFmt.format(ts);
}

/** Dauer als m:ss bzw. h:mm:ss. */
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function fmtAverage(v: number | null): string {
  return v === null ? '–' : v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export function fmtInt(v: number | null): string {
  return v === null ? '–' : v.toLocaleString('de-DE');
}

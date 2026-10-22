import type { GameRecord } from '../storage/gameStore';
import { fmtShortDate, fmtTime, fmtWeekday } from '../ui/format';
import { countAxis, linear, spansMultipleDays, timeDomain, timeTicks } from './scales';

const SVG_NS = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface ChartOptions {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * Liniendiagramm: ein Punkt pro abgeschlossenem Spiel.
 * x = tatsächliche Startzeit (echte Zeitachse), y = Schläge dieses Spiels.
 * Gerade Verbindungen, keine Glättung, keine kumulierte Summe.
 */
export function renderTimeChart(host: HTMLElement, games: GameRecord[], opts: ChartOptions): void {
  host.replaceChildren();
  const sorted = games.slice().sort((a, b) => a.startTime - b.startTime);
  const times = sorted.map((g) => g.startTime);
  const domain = timeDomain(times);
  if (!domain) return;

  const width = Math.max(280, Math.round(host.clientWidth || 340));
  const multiDay = spansMultipleDays(times);
  const height = multiDay ? 264 : 248;
  const m = { top: 18, right: 18, bottom: multiDay ? 62 : 48, left: 44 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;

  const y = countAxis(Math.max(...sorted.map((g) => g.hits)));
  const sx = linear(domain.min, domain.max, m.left, m.left + innerW);
  const sy = linear(0, y.max, m.top + innerH, m.top);

  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    class: 'chart-svg',
    role: 'img',
    'aria-label': `Schläge je Spiel über die Zeit, ${sorted.length} ${sorted.length === 1 ? 'Spiel' : 'Spiele'}`,
  });

  // y-Raster und Beschriftung (ganzzahlig, ab null)
  const gridG = el('g', { class: 'chart-grid' });
  for (const v of y.ticks) {
    const yy = Math.round(sy(v)) + 0.5;
    gridG.append(el('line', { x1: m.left, x2: m.left + innerW, y1: yy, y2: yy, class: v === 0 ? 'axis-line' : 'grid-line' }));
    gridG.append(el('text', { x: m.left - 8, y: yy + 4, 'text-anchor': 'end', class: 'tick-label' }, String(v)));
  }
  svg.append(gridG);

  // x-Ticks: echte Zeitachse
  const maxTicks = Math.max(2, Math.floor(innerW / (multiDay ? 70 : 58)));
  const tt = timeTicks(domain, maxTicks);
  const xG = el('g', { class: 'chart-x' });
  for (const t of tt.ticks) {
    const xx = Math.round(sx(t)) + 0.5;
    xG.append(el('line', { x1: xx, x2: xx, y1: m.top + innerH, y2: m.top + innerH + 5, class: 'axis-line' }));
    const label = el('text', { x: xx, y: m.top + innerH + 19, 'text-anchor': 'middle', class: 'tick-label' });
    if (tt.dayStep) {
      label.textContent = fmtShortDate(t);
    } else if (multiDay) {
      label.append(el('tspan', { x: xx, dy: 0 }, `${fmtWeekday(t)} ${fmtShortDate(t)}`));
      label.append(el('tspan', { x: xx, dy: 14 }, fmtTime(t)));
    } else {
      label.textContent = fmtTime(t);
    }
    xG.append(label);
  }
  svg.append(xG);

  // Achsentitel
  svg.append(el('text', { x: m.left + innerW / 2, y: height - 6, 'text-anchor': 'middle', class: 'axis-title' }, multiDay ? 'Datum / Uhrzeit' : 'Uhrzeit'));
  svg.append(
    el('text', { x: 12, y: m.top + innerH / 2, 'text-anchor': 'middle', class: 'axis-title', transform: `rotate(-90 12 ${m.top + innerH / 2})` }, 'Schläge'),
  );

  // Linie: gerade Segmente in chronologischer Reihenfolge
  if (sorted.length > 1) {
    const pts = sorted.map((g) => `${sx(g.startTime).toFixed(1)},${sy(g.hits).toFixed(1)}`).join(' ');
    svg.append(el('polyline', { points: pts, class: 'chart-line', fill: 'none' }));
  }

  // Punkte mit großen Touch-Flächen
  const ptsG = el('g', { class: 'chart-points' });
  for (const g of sorted) {
    const cx = sx(g.startTime);
    const cy = sy(g.hits);
    const selected = g.id === opts.selectedId;
    const group = el('g', {
      class: `chart-point${selected ? ' is-selected' : ''}`,
      tabindex: 0,
      role: 'button',
      'aria-label': `Spiel ${g.number}, ${fmtShortDate(g.startTime)} ${fmtTime(g.startTime)} Uhr, ${g.hits} Schläge`,
      'aria-pressed': selected ? 'true' : 'false',
    });
    group.append(el('circle', { cx, cy, r: 22, class: 'hit-area', fill: 'transparent' }));
    if (selected) group.append(el('circle', { cx, cy, r: 12, class: 'point-halo' }));
    group.append(el('circle', { cx, cy, r: selected ? 7 : 5.5, class: 'point-dot' }));
    const select = (e: Event): void => {
      e.preventDefault();
      opts.onSelect(g.id);
    };
    group.addEventListener('click', select);
    group.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') select(e);
    });
    ptsG.append(group);
  }
  svg.append(ptsG);

  host.append(svg);
}

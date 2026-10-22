import type { AudioEngine } from '../audio/audioEngine';
import { configFromSensitivity, SENSITIVITY_DEFAULT } from '../audio/detectorCore';
import { isEmbedded } from '../audio/micErrors';
import { renderTimeChart } from '../chart/timeChart';
import { TEST_TARGET, type GameController, type Phase } from '../game/controller';
import type { ScreenWakeLock } from '../game/wakeLock';
import { bestOverall, filterGames, summarize, type RangeFilter } from '../stats/stats';
import type { GameRecord, GameStore } from '../storage/gameStore';
import { fmtAverage, fmtDate, fmtDuration, fmtInt, fmtShortDate, fmtTime, fmtWeekday } from './format';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`#${id} fehlt`);
  return node as T;
};

const STATUS_TEXT: Record<Phase, string> = {
  ready: 'Bereit',
  calibrating: 'Umgebung messen …',
  countdown: 'Gleich geht’s los',
  running: 'Zählt',
  interrupted: 'Unterbrochen',
  stopped: 'Gestoppt',
};

const SENS_KEY = 'beach-rally-sensitivity';
const PAGE_SIZE = 20;

function readSensitivity(): number {
  try {
    const v = Number(localStorage.getItem(SENS_KEY));
    if (Number.isFinite(v) && v >= 1 && v <= 10) return Math.round(v);
  } catch {
    /* ignore */
  }
  return SENSITIVITY_DEFAULT;
}

function writeSensitivity(v: number): void {
  try {
    localStorage.setItem(SENS_KEY, String(v));
  } catch {
    /* ignore */
  }
}

function button(label: string, cls: string, onClick: () => void, extra = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `btn ${cls} ${extra}`.trim();
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

export class App {
  private view: 'play' | 'stats' = 'play';
  private range: RangeFilter = 'today';
  private selectedId: string | null = null;
  private listLimit = PAGE_SIZE;
  private actionsKey = '';
  private sheetOpen = false;
  private resizeTimer: number | null = null;

  constructor(
    private readonly c: GameController,
    private readonly store: GameStore,
    private readonly audio: AudioEngine,
    private readonly wake: ScreenWakeLock,
  ) {}

  mount(): void {
    const sens = readSensitivity();
    this.c.setSensitivity(sens);
    const slider = $<HTMLInputElement>('sensitivity');
    slider.value = String(sens);
    this.renderSensitivity(sens);
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      this.c.setSensitivity(v);
      writeSensitivity(v);
      this.renderSensitivity(v);
    });

    for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
      tab.addEventListener('click', () => this.setView(tab.dataset.view === 'stats' ? 'stats' : 'play'));
    }
    for (const seg of document.querySelectorAll<HTMLButtonElement>('.seg')) {
      seg.addEventListener('click', () => {
        this.range = seg.dataset.range === 'all' ? 'all' : 'today';
        this.listLimit = PAGE_SIZE;
        this.renderStats();
      });
    }
    $('more').addEventListener('click', () => {
      this.listLimit += PAGE_SIZE;
      this.renderStats();
    });
    $('live-stop').addEventListener('click', () => this.c.stop());

    $('open-adjust').addEventListener('click', () => this.openSheet(true));
    $('close-adjust').addEventListener('click', () => this.openSheet(false));
    $('sheet-backdrop').addEventListener('click', () => this.openSheet(false));
    $('minus').addEventListener('click', () => this.c.adjust(-1));
    $('plus').addEventListener('click', () => this.c.adjust(1));
    $('recalibrate').addEventListener('click', () => this.c.recalibrate());
    $('test-toggle').addEventListener('click', () => (this.c.test ? this.c.endTest() : this.c.startTest()));
    $('test-resume').addEventListener('click', () => {
      this.openSheet(false);
      this.c.resume();
    });
    $('mic-toggle').addEventListener('click', () => (this.c.micCheck ? this.c.stopMicCheck() : this.c.startMicCheck()));

    this.c.subscribe((kind) => {
      if (kind === 'hit') {
        this.renderCounter();
        this.pulse();
        this.renderSheet();
        this.renderLive();
      } else if (kind === 'level') {
        if (this.sheetOpen) this.renderMeter();
      } else if (kind === 'games') {
        this.renderCounter();
        this.renderStats();
        this.renderSheet();
      } else {
        this.renderAll();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.c.handleHidden();
    });
    window.addEventListener('pagehide', () => this.c.handleHidden());
    window.addEventListener('resize', () => {
      if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(() => this.renderChartOnly(), 150);
    });
    window.setInterval(() => {
      this.c.tick();
      this.renderTime();
      this.renderLive();
    }, 250);

    this.renderAll();
  }

  // ---------- Ansichten ----------

  private setView(v: 'play' | 'stats'): void {
    // Interner Ansichtswechsel: kein App-Wechsel, das Spiel läuft weiter.
    this.view = v;
    $('view-play').hidden = v !== 'play';
    $('view-stats').hidden = v !== 'stats';
    for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
      if (tab.dataset.view === v) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    if (v === 'stats') this.renderStats();
    window.scrollTo(0, 0);
  }

  private openSheet(open: boolean): void {
    this.sheetOpen = open;
    $('adjust-sheet').hidden = !open;
    $('sheet-backdrop').hidden = !open;
    if (open) this.renderSheet();
    else if (this.c.micCheck) this.c.stopMicCheck();
  }

  private renderAll(): void {
    this.renderStatus();
    this.renderCounter();
    this.renderTime();
    this.renderMessage();
    this.renderActions();
    this.renderBanners();
    this.renderHints();
    this.renderLive();
    if (this.view === 'stats') this.renderStats();
    this.renderSheet();
  }

  // ---------- Spielen ----------

  private renderStatus(): void {
    const pill = $('status');
    pill.dataset.state = this.c.phase;
    pill.textContent = STATUS_TEXT[this.c.phase];
  }

  private renderCounter(): void {
    $('counter').textContent = String(this.c.hits);
    $('best').textContent = fmtInt(bestOverall(this.store.all()));
  }

  private renderTime(): void {
    $('time').textContent = fmtDuration(this.c.activeMs());
  }

  private pulse(): void {
    if (this.c.test) return;
    const wrap = $('counter-wrap');
    wrap.classList.remove('is-hit');
    void wrap.offsetWidth; // Animation neu starten
    wrap.classList.add('is-hit');
  }

  private renderMessage(): void {
    const box = $('message');
    const c = this.c;
    box.replaceChildren();
    if (c.countdown !== null) {
      const n = document.createElement('span');
      n.className = 'count';
      n.textContent = String(c.countdown);
      box.append(n, 'Gleich geht’s los – bereit machen.');
      return;
    }
    if (c.message) {
      if (c.message.endsWith('geht’s!')) {
        const s = document.createElement('span');
        s.className = 'go';
        s.textContent = c.message;
        box.append(s);
      } else {
        box.textContent = c.message;
      }
      return;
    }
    if (c.phase === 'interrupted') {
      const why =
        c.interruptReason === 'test'
          ? 'Pausiert für den Schlagtest.'
          : c.interruptReason === 'hidden'
            ? 'Pausiert, weil die App nicht im Vordergrund war.'
            : 'Pausiert, weil das Mikrofon unterbrochen wurde.';
      box.textContent = `${why} Der Spielstand bleibt erhalten.`;
      return;
    }
    if (c.phase === 'stopped' && c.stoppedRecord) {
      const saved = this.store.persistent;
      box.textContent = saved
        ? `Spiel ${c.stoppedRecord.number} gespeichert.`
        : `Spiel ${c.stoppedRecord.number} beendet – nicht dauerhaft gespeichert.`;
      return;
    }
    box.textContent = '';
  }

  private renderActions(): void {
    const c = this.c;
    const inGame = c.gameInProgress;
    const key = `${c.phase}|${inGame}`;
    if (key === this.actionsKey) return; // Buttons unter dem Finger nicht neu aufbauen
    this.actionsKey = key;
    const box = $('actions');
    box.replaceChildren();
    box.className = 'actions';
    const stop = (): HTMLButtonElement => button('Stopp', 'btn-stop btn-xl', () => c.stop());
    const next = (cls = 'btn-secondary'): HTMLButtonElement => button('Neue Runde', `${cls} btn-xl`, () => c.newRound());

    switch (c.phase) {
      case 'ready':
        box.append(button('Spiel starten', 'btn-primary btn-xl', () => c.start()));
        break;
      case 'calibrating':
      case 'countdown':
        if (inGame) {
          box.classList.add('two');
          box.append(stop(), next());
        } else {
          box.append(button('Abbrechen', 'btn-secondary btn-xl', () => c.stop()));
        }
        break;
      case 'running':
        box.classList.add('two');
        box.append(stop(), next());
        break;
      case 'interrupted':
        box.classList.add('two');
        box.append(button('Fortsetzen', 'btn-primary btn-xl', () => c.resume(), 'full'), stop(), next());
        break;
      case 'stopped':
        box.append(next('btn-primary'));
        break;
    }
  }

  private banner(kind: 'warn' | 'danger' | 'info', title: string, text: string, actions: HTMLElement[] = []): HTMLElement {
    const b = document.createElement('div');
    b.className = `banner ${kind === 'warn' ? '' : kind}`.trim();
    b.setAttribute('role', kind === 'danger' ? 'alert' : 'status');
    const t = document.createElement('div');
    t.className = 'banner-title';
    t.textContent = title;
    const p = document.createElement('p');
    p.textContent = text;
    b.append(t, p, ...actions);
    return b;
  }

  private storageBanner(): HTMLElement | null {
    if (this.store.persistent) return null;
    return this.banner(
      'warn',
      'Verlauf wird gerade nicht dauerhaft gesichert.',
      'Spielen und Zählen funktionieren weiter. Nach dem Neuladen fehlen diese Spiele. Privates Surfen verhindert oft das Speichern.',
    );
  }

  private renderBanners(): void {
    const c = this.c;
    const play: HTMLElement[] = [];
    if (c.error) {
      const acts: HTMLElement[] = [];
      if (c.error.problem === 'embedded' || c.error.problem === 'unsupported') {
        const a = document.createElement('a');
        a.className = 'btn';
        a.href = location.href;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'Im Browser öffnen';
        acts.push(a);
      }
      acts.push(button('Verstanden', '', () => c.dismissError()));
      play.push(this.banner('danger', c.error.title, c.error.action, acts));
    }
    if (c.info) play.push(this.banner('info', 'Hinweis', c.info));
    if (isEmbedded() && c.phase === 'ready' && !c.error) {
      play.push(
        this.banner('info', 'Du siehst eine eingebettete Vorschau.', 'Falls das Mikrofon hier nicht freigegeben wird: Link direkt in Safari oder Chrome öffnen.'),
      );
    }
    const sb = this.storageBanner();
    if (sb) play.push(sb);
    $('play-banners').replaceChildren(...play);

    const statsBanner = this.storageBanner();
    $('stats-banners').replaceChildren(...(statsBanner ? [statsBanner] : []));
  }

  private renderHints(): void {
    const p = this.c.phase;
    const inGame = p === 'running' || p === 'calibrating' || p === 'countdown' || p === 'interrupted';
    $('setup-hint').hidden = p === 'running';
    $('wake-hint').hidden = !(inGame && !this.wake.supported);
  }

  // ---------- Live-Leiste in der Statistik ----------

  private renderLive(): void {
    const c = this.c;
    const bar = $('live-bar');
    bar.hidden = !c.gameInProgress;
    if (!c.gameInProgress) return;
    $('live-hits').textContent = String(c.hits);
    $('live-time').textContent = fmtDuration(c.activeMs());
    $('live-state').textContent = c.phase === 'running' ? 'zählt' : c.phase === 'interrupted' ? 'unterbrochen' : 'gleich weiter';
    bar.classList.toggle('is-paused', c.phase === 'interrupted');
  }

  // ---------- Statistik ----------

  private filtered(): GameRecord[] {
    return filterGames(this.store.all(), this.range, Date.now());
  }

  private renderStats(): void {
    for (const seg of document.querySelectorAll<HTMLButtonElement>('.seg')) {
      seg.setAttribute('aria-pressed', String(seg.dataset.range === this.range));
    }
    const all = this.store.all();
    const games = this.filtered();
    const s = summarize(games);
    $('kpi-count').textContent = fmtInt(s.count);
    $('kpi-total').textContent = fmtInt(s.total);
    $('kpi-best').textContent = fmtInt(s.best);
    $('kpi-avg').textContent = fmtAverage(s.average);

    if (this.selectedId && !games.some((g) => g.id === this.selectedId)) this.selectedId = null;

    const empty = $('chart-empty');
    if (games.length === 0) {
      empty.textContent =
        all.length === 0
          ? 'Starte dein erstes Spiel – hier entsteht euer Verlauf.'
          : 'Heute noch kein Spiel. Unter „Alle“ siehst du den ganzen Verlauf.';
    }
    empty.hidden = games.length > 0;
    $('chart-tip').hidden = games.length === 0;
    this.renderChartOnly();
    this.renderDetail(games);
    this.renderList(games);
  }

  private renderChartOnly(): void {
    if (this.view !== 'stats') return;
    renderTimeChart($('chart'), this.filtered(), {
      selectedId: this.selectedId,
      onSelect: (id) => this.select(id),
    });
  }

  private select(id: string): void {
    this.selectedId = this.selectedId === id ? null : id;
    this.renderChartOnly();
    const games = this.filtered();
    this.renderDetail(games);
    this.renderList(games);
  }

  private renderDetail(games: GameRecord[]): void {
    const box = $('chart-detail');
    box.replaceChildren();
    const g = games.find((x) => x.id === this.selectedId);
    if (!g) return;
    const items: [string, string][] = [
      ['Spiel', `Nr. ${g.number}`],
      ['Datum', `${fmtWeekday(g.startTime)}, ${fmtDate(g.startTime)}`],
      ['Start', `${fmtTime(g.startTime)} Uhr`],
      ['Schläge', fmtInt(g.hits)],
      ['Aktive Dauer', fmtDuration(g.activeMs)],
    ];
    for (const [k, v] of items) {
      const d = document.createElement('div');
      const kk = document.createElement('span');
      kk.className = 'd-k';
      kk.textContent = k;
      const vv = document.createElement('span');
      vv.className = 'd-v';
      vv.textContent = v;
      d.append(kk, vv);
      box.append(d);
    }
  }

  private renderList(games: GameRecord[]): void {
    const list = $('game-list');
    const newest = games.slice().sort((a, b) => b.startTime - a.startTime || b.number - a.number);
    const shown = newest.slice(0, this.listLimit);
    list.replaceChildren(
      ...shown.map((g) => {
        const li = document.createElement('li');
        if (g.id === this.selectedId) li.classList.add('is-selected');
        const num = document.createElement('span');
        num.className = 'g-num';
        num.textContent = `#${g.number}`;
        const when = document.createElement('span');
        when.className = 'g-when';
        when.textContent = `${fmtWeekday(g.startTime)} ${fmtShortDate(g.startTime)}, ${fmtTime(g.startTime)} Uhr`;
        const small = document.createElement('small');
        small.textContent = `Dauer ${fmtDuration(g.activeMs)}`;
        when.append(small);
        const hits = document.createElement('span');
        hits.className = 'g-hits';
        hits.textContent = String(g.hits);
        const unit = document.createElement('small');
        unit.textContent = g.hits === 1 ? 'Schlag' : 'Schläge';
        hits.append(unit);
        li.append(num, when, hits);
        li.addEventListener('click', () => this.select(g.id));
        return li;
      }),
    );
    const more = $('more');
    more.hidden = newest.length <= shown.length;
    more.textContent = `Weitere Spiele laden (${newest.length - shown.length} übrig)`;
  }

  // ---------- Anpassen ----------

  private renderSensitivity(v: number): void {
    const cfg = configFromSensitivity(v);
    $('sens-value').textContent = `${v} von 10`;
    this.renderTech(cfg.thresholdDb);
  }

  private renderSheet(): void {
    if (!this.sheetOpen) return;
    const c = this.c;
    const can = c.canAdjust();
    $<HTMLButtonElement>('minus').disabled = !can || c.hits === 0;
    $<HTMLButtonElement>('plus').disabled = !can;
    $('adjust-value').textContent = can ? String(c.hits) : '–';
    $('adjust-target').textContent = can && c.currentNumber !== null ? `· Spiel ${c.currentNumber}` : '· kein Spiel';

    const busy = c.phase === 'calibrating' || c.phase === 'countdown' || c.standaloneCalibrating;
    const recal = $<HTMLButtonElement>('recalibrate');
    recal.disabled = busy || !!c.test;
    const cal = c.calibration;
    $('cal-status').textContent = c.standaloneCalibrating
      ? c.message ?? 'Umgebung messen …'
      : c.phase === 'calibrating'
        ? 'Umgebung messen …'
        : cal
          ? 'Umgebung ist gemessen. Bei Wind- oder Ortswechsel neu kalibrieren.'
          : 'Wird beim Spielstart automatisch gemessen.';

    const t = c.test;
    $('test-box').hidden = !t;
    const toggle = $<HTMLButtonElement>('test-toggle');
    toggle.textContent = t ? 'Test beenden' : 'Schlagtest starten';
    toggle.disabled = !t && busy;
    const advice = $('test-advice');
    if (t) {
      $('test-count').textContent = String(t.count);
      $('test-label').textContent = t.listening ? `von ${TEST_TARGET} erkannt` : 'Umgebung messen …';
      advice.hidden = !t.listening || t.count === 0;
      advice.textContent =
        t.count < TEST_TARGET
          ? 'Nicht alle erkannt? Empfindlichkeit erhöhen und nochmal testen.'
          : t.count > TEST_TARGET
            ? 'Mehr als 5 erkannt? Empfindlichkeit verringern.'
            : 'Passt. Alle 5 Schläge erkannt.';
    } else {
      advice.hidden = true;
    }
    $('test-resume').hidden = !(c.phase === 'interrupted' && !t);

    const mic = $<HTMLButtonElement>('mic-toggle');
    mic.textContent = c.micCheck ? 'Mikrofontest beenden' : 'Mikrofon testen';
    const showMeter = c.micCheck || !!t || c.phase === 'running';
    $('meter').hidden = !showMeter;
    $('meter-floor').hidden = true;
    this.renderMeter();
    this.renderTech(configFromSensitivity(Number($<HTMLInputElement>('sensitivity').value)).thresholdDb);
  }

  private renderMeter(): void {
    const lvl = this.c.level;
    const pct = lvl ? Math.max(0, Math.min(100, ((lvl.rawDb + 90) / 90) * 100)) : 0;
    $('meter-fill').style.width = `${pct.toFixed(1)}%`;
  }

  private renderTech(thresholdDb: number): void {
    const info = this.audio.getTechInfo();
    const onOff = (v: boolean | null): string => (v === null ? 'unbekannt' : v ? 'an' : 'aus');
    const rows: [string, string][] = [
      ['Abtastrate', info ? `${info.sampleRate} Hz` : '–'],
      ['Verarbeitung', info ? (info.backend === 'AudioWorklet' ? 'AudioWorklet' : 'Fallback (ScriptProcessor)') : '–'],
      ['Echo-Unterdrückung', info ? onOff(info.echoCancellation) : '–'],
      ['Rauschunterdrückung', info ? onOff(info.noiseSuppression) : '–'],
      ['Pegelautomatik', info ? onOff(info.autoGainControl) : '–'],
      ['Hintergrund', this.c.level ? `${this.c.level.floorDb.toFixed(0)} dB` : '–'],
      ['Schwelle über Hintergrund', `${thresholdDb.toFixed(1)} dB`],
      ['Sperrzeit', '180 ms'],
      ['Speicher', this.store.persistent ? 'IndexedDB aktiv' : 'nicht dauerhaft'],
    ];
    const dl = $('tech-list');
    dl.replaceChildren(
      ...rows.flatMap(([k, v]) => {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        return [dt, dd];
      }),
    );
  }
}

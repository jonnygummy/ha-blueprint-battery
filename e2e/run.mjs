// End-to-End-Test in Headless-Chromium mit simuliertem Mikrofon (WAV-Datei), Kamera-Bestätigung aus.
// Prüft die echte Kette getUserMedia → AudioWorklet → Zähler → IndexedDB → Diagramm.
// Ersetzt keinen Test am echten Smartphone am Strand.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import chromiumPkg from '@sparticuz/chromium';
import { chromium } from 'playwright-core';

const OUT = process.argv[2] ?? 'e2e/out';
mkdirSync(OUT, { recursive: true });
const SR = 48000;
const HIT_TIMES = [7, 8.1, 9.0, 10.2, 11.0, 12.3, 13.1, 14.0, 15.2, 16.0]; // 10 Schläge
const DURATION = 22;

// --- WAV erzeugen ---
function makeWav() {
  let seed = 12345;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-12, rand()))) * Math.cos(2 * Math.PI * rand());
  const n = SR * DURATION;
  const x = new Float32Array(n);
  const noiseAmp = Math.pow(10, -52 / 20);
  for (let i = 0; i < n; i++) x[i] = gauss() * noiseAmp;
  // tiefes Windrumpeln
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
  const p = join(OUT, 'fake-mic.wav');
  writeFileSync(p, buf);
  return p;
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const wav = makeWav();
const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort', '--host', '127.0.0.1'], { stdio: 'pipe' });
await new Promise((r) => setTimeout(r, 2500));

const exe = await chromiumPkg.executablePath();
const args = chromiumPkg.args.filter((a) => !a.startsWith('--window-size') && a !== '--mute-audio');
const browser = await chromium.launch({
  executablePath: exe,
  args: [
    ...args,
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}%noloop`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});

async function newPage(ctx) {
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text()); });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  return page;
}

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'], colorScheme: 'light' });
  await ctx.addInitScript(() => localStorage.setItem('beach-rally-camera', JSON.stringify({ enabled: false, facing: 'environment', motion: 6 })));
  let page = await newPage(ctx);
  await page.goto('http://127.0.0.1:4173/');
  await page.waitForSelector('text=Spiel starten');
  await page.screenshot({ path: join(OUT, '1-bereit.png') });

  const t0 = Date.now();
  await page.click('text=Spiel starten');
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Umgebung messen …');
  check('Status während Kalibrierung', true, 'Umgebung messen …');
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Zählt', null, { timeout: 10000 });
  const runAfter = (Date.now() - t0) / 1000;
  check('Kalibrierung ~3 s, danach „Zählt“', runAfter > 2.9 && runAfter < 6, `${runAfter.toFixed(1)} s`);
  check('Kalibrierung zählt keine Schläge', (await page.textContent('#counter')) === '0');
  await page.screenshot({ path: join(OUT, '2-zaehlt.png') });

  // Wechsel zur Statistik während des Spiels: Zählung läuft weiter
  await page.waitForTimeout(Math.max(0, 9500 - (Date.now() - t0)));
  await page.click('.tab[data-view="stats"]');
  check('Live-Leiste in Statistik sichtbar', await page.isVisible('#live-bar'));
  await page.waitForTimeout(Math.max(0, 13500 - (Date.now() - t0)));
  await page.screenshot({ path: join(OUT, '3-statistik-live.png') });
  await page.click('.tab[data-view="play"]');

  await page.waitForTimeout(Math.max(0, 18000 - (Date.now() - t0)));
  const tech = await page.evaluate(() => document.getElementById('tech-list')?.textContent ?? '');
  const alog = await page.evaluate(() => ({ now: performance.now(), a: window.beachRallyDebug?.audio ?? [] }));
  const el = (Date.now() - t0) / 1000;
  console.log('  Ton-Ereignisse (s seit Klick @ dB):', alog.a.map((x) => `${(el - (alog.now - x.t) / 1000).toFixed(2)}@${x.strengthDb.toFixed(0)}`).join(' '));
  const before = await page.textContent('#counter');
  await page.click('button:has-text("Stopp")');
  const counted = Number(before);
  check('Echte Audio-Kette zählt 10 eingespielte Schläge', counted === 10, `gezählt: ${counted}`);
  await page.waitForTimeout(1500);
  check('Nach Stopp keine weiteren Zählungen', (await page.textContent('#counter')) === before);
  check('Status „Gestoppt“', (await page.textContent('#status')) === 'Gestoppt');
  const msg = await page.textContent('#message');
  check('Spiel als gespeichert gemeldet', /Spiel 1 gespeichert/.test(msg ?? ''), msg ?? '');
  await page.screenshot({ path: join(OUT, '4-gestoppt.png') });

  // Korrektur +1 nach Stopp
  await page.click('#open-adjust');
  await page.click('#plus');
  await page.screenshot({ path: join(OUT, '5-anpassen.png') });
  await page.click('#close-adjust');
  check('Korrektur ändert Anzeige', (await page.textContent('#counter')) === String(counted + 1));

  await page.click('.tab[data-view="stats"]');
  const points = await page.locator('.chart-point').count();
  check('Diagramm hat genau 1 Punkt', points === 1, `${points}`);
  check('Kennzahl „Spiele“ = 1', (await page.textContent('#kpi-count')) === '1');
  check('Bestes Spiel enthält Korrektur', (await page.textContent('#kpi-best')) === String(counted + 1));
  await page.click('.chart-point');
  const detail = await page.textContent('#chart-detail');
  check('Tippen auf Punkt zeigt Details', /Nr\. 1/.test(detail ?? '') && /Aktive Dauer/.test(detail ?? ''), detail ?? '');
  await page.screenshot({ path: join(OUT, '6-statistik.png'), fullPage: true });

  // Neuladen: Verlauf bleibt
  await page.reload();
  await page.waitForSelector('text=Spiel starten');
  await page.click('.tab[data-view="stats"]');
  check('Verlauf nach Neuladen erhalten', (await page.locator('.chart-point').count()) === 1 && (await page.textContent('#kpi-best')) === String(counted + 1));
  check('Bestwert in Spielansicht nach Neuladen', true);
  await page.close();

  // Dunkles Farbschema + Mikrofontest mit Live-Pegel (neuer Kontext, frischer Fake-Stream)
  const dark = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone'], colorScheme: 'dark' });
  await dark.addInitScript(() => localStorage.setItem('beach-rally-camera', JSON.stringify({ enabled: false, facing: 'environment', motion: 6 })));
  page = await newPage(dark);
  await page.goto('http://127.0.0.1:4173/');
  await page.waitForSelector('text=Spiel starten');
  await page.click('#open-adjust');
  await page.click('#mic-toggle');
  await page.waitForTimeout(7300); // im WAV liegt bei 7 s ein Schlag
  const width = await page.evaluate(() => document.getElementById('meter-fill')?.style.width);
  check('Mikrofontest zeigt Live-Pegel aus echten Audiodaten', parseFloat(width ?? '0') > 0, `Balken ${width}`);
  await page.click('summary');
  await page.screenshot({ path: join(OUT, '7-mikrofontest-dunkel.png') });
  await page.click('#close-adjust');
  await page.screenshot({ path: join(OUT, '8-bereit-dunkel.png') });
  console.log('Technik:', tech.replace(/\s+/g, ' '));
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
process.exit(failed.length ? 1 : 0);

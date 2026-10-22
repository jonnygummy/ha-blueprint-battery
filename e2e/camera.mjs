// Browser-Test der Kamera-Bestätigung mit Fake-Mikrofon UND Fake-Kamera.
// 10 Schlaggeräusche, aber nur bei 8 davon ein Schwung im Bild → 8 erwartet.
// Ersetzt keinen Test am echten Smartphone am Strand.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import chromiumPkg from '@sparticuz/chromium';
import { chromium } from 'playwright-core';
import { HIT_TIMES, makeWav, makeY4m } from './media.mjs';

const OUT = process.argv[2] ?? 'e2e/out';
mkdirSync(OUT, { recursive: true });
const NO_SWING = new Set([3, 7]);
const swingAt = HIT_TIMES.filter((_, i) => !NO_SWING.has(i));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const wav = makeWav(OUT);
const y4m = makeY4m(OUT, swingAt);
const server = spawn('npx', ['vite', 'preview', '--port', '4174', '--strictPort', '--host', '127.0.0.1'], { stdio: 'pipe' });
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
    `--use-file-for-fake-video-capture=${y4m}`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});

try {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ['microphone', 'camera'], colorScheme: 'light' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text()); });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  await page.goto('http://127.0.0.1:4174/');
  await page.waitForSelector('text=Spiel starten');

  const t0 = Date.now();
  await page.click('text=Spiel starten');
  await page.waitForFunction(() => document.getElementById('status')?.textContent === 'Zählt', null, { timeout: 10000 });
  await page.waitForFunction(() => document.getElementById('cam-title')?.textContent === 'Kamera prüft Schläge', null, { timeout: 5000 });
  check('Kamera läuft parallel zur Kalibrierung an', true);
  check('Kamera-Vorschau im Spiel sichtbar', await page.isVisible('#cam-thumb video'));
  await page.waitForTimeout(Math.max(0, 11500 - (Date.now() - t0)));
  await page.screenshot({ path: join(OUT, 'c1-spiel-mit-kamera.png') });

  await page.waitForTimeout(Math.max(0, 18000 - (Date.now() - t0)));
  const log = await page.evaluate(() => {
    const d = window.beachRallyDebug?.decisions ?? [];
    return { now: performance.now(), d: d.map((x) => ({ t: x.t, o: x.outcome, p: x.peak, ty: x.typical })) };
  });
  const elapsed = (Date.now() - t0) / 1000;
  for (const x of log.d) {
    const at = elapsed - (log.now - x.t) / 1000; // Sekunden seit Klick
    console.log(`  Entscheidung bei ~${at.toFixed(2)} s: ${x.o} (Spitze ${x.p?.toFixed(1)}, üblich ${x.ty?.toFixed(1)})`);
  }
  const counted = Number(await page.textContent('#counter'));
  const camSub = await page.textContent('#cam-sub');
  await page.click('button:has-text("Stopp")');
  check('Nur Töne mit Schwung im Bild gezählt (8 von 10)', counted === 8, `gezählt: ${counted}, Kamera: ${camSub}`);
  await page.waitForTimeout(800);

  const rec = await page.evaluate(
    () =>
      new Promise((res) => {
        const r = indexedDB.open('beach-rally');
        r.onsuccess = () => {
          const q = r.result.transaction('games').objectStore('games').getAll();
          q.onsuccess = () => res(q.result);
        };
      }),
  );
  const g = rec[0];
  check('Kamera-Prüfung im Spiel gespeichert', !!g?.cameraCheck, JSON.stringify(g?.cameraCheck));
  check('Verworfene Töne erfasst (2 ohne Schwung)', (g?.cameraCheck?.rejected ?? 0) >= 2, `verworfen: ${g?.cameraCheck?.rejected}`);
  check('Kamera nach Stopp freigegeben', (await page.locator('#cam-thumb video').count()) === 0);

  await page.click('#open-adjust');
  await page.screenshot({ path: join(OUT, 'c2-anpassen-kamera.png') });
  await page.click('#cam-align-toggle');
  await page.waitForTimeout(1500);
  check('Ausrichten zeigt Kamerabild', await page.isVisible('#cam-align-frame video'));
  await page.screenshot({ path: join(OUT, 'c3-ausrichten.png') });
  await page.click('#close-adjust');

  await page.click('.tab[data-view="stats"]');
  await page.click('.chart-point');
  const detail = await page.textContent('#chart-detail');
  check('Statistik-Detail nennt Kamera-Prüfung', /Kamera/.test(detail ?? ''), detail ?? '');
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} Prüfungen bestanden`);
process.exit(failed.length ? 1 : 0);

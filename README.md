# Beach Rally

Mobile Web-App: zählt beim Beachball die Kontakte zwischen Ball und Schläger über das Smartphone-Mikrofon
und dokumentiert alle Spiele mit Statistik und Liniendiagramm. Audio wird nur lokal und flüchtig verarbeitet.

- `src/audio` – Mikrofon, AudioWorklet, Impulsdetektor
- `src/game` – Spielablauf (Zustandsmaschine), Wake Lock
- `src/storage` – IndexedDB-Verlauf
- `src/stats` – Kennzahlen
- `src/chart` – SVG-Liniendiagramm mit echter Zeitachse
- `src/ui` – Oberfläche

`npm test` (Einheitentests mit synthetischen Signalen), `npm run build` → `dist/` (wird in Branch `gh-pages` veröffentlicht).

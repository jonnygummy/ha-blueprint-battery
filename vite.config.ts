/// <reference types="vitest" />
import { defineConfig } from 'vite';

// Relative base, damit die App unter jeder HTTPS-Unteradresse (z. B. GitHub Pages) läuft.
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});

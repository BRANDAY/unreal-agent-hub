import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run build` writes ../web/index.html and ../web/assets/ (the hub serves web/). web/i18n and web/favicon.svg are
// kept: they are sources too, fetched by the page at run time. `npm run dev` proxies the data to a running board.
const OUT = path.resolve(import.meta.dirname, '..', 'web');
const board = process.env.UAH_BOARD || 'http://127.0.0.1:8790';

export default defineConfig({
  plugins: [react(), {
    name: 'clean-assets',
    apply: 'build',
    buildStart() { fs.rmSync(path.join(OUT, 'assets'), { recursive: true, force: true }); },
  }],
  base: './',
  publicDir: false,
  build: { outDir: OUT, emptyOutDir: false, chunkSizeWarningLimit: 2500 },
  server: { proxy: { '/events': board, '/state': board, '/api': board, '/i18n': board, '/favicon.svg': board } },
});

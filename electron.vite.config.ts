import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const shared = { '@shared': resolve('src/shared') };

export default defineConfig({
  main: {
    resolve: { alias: shared },
    // frida ships a native addon; it must stay a runtime require, never bundled.
    build: { externalizeDeps: true },
  },
  preload: {
    resolve: { alias: shared },
    build: { externalizeDeps: true },
  },
  renderer: {
    resolve: { alias: shared },
    plugins: [react(), tailwindcss()],
  },
});

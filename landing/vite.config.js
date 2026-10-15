import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Landing build emits into docs/ for GitHub Pages. emptyOutDir MUST stay
// false: docs/ also carries the hand-managed brand assets (docs/assets) and
// is committed together with this source.
export default defineConfig({
  root: 'landing',
  base: '/shengchang-ai-studio/',
  plugins: [react()],
  publicDir: false,
  build: { outDir: '../docs', emptyOutDir: false, assetsDir: 'vite' },
});

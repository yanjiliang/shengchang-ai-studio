import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Landing build emits into docs/ for GitHub Pages. emptyOutDir MUST stay
// false: docs/ also carries the hand-managed brand assets (docs/assets) and
// is committed together with this source.
// 试听区开关（构建期）。默认关：试听区和导航链接都不渲染，产物里不引用 mp3。
// 打开：LISTEN_SAMPLE_ENABLED=true npm run build:landing（需要 docs/assets/samples/ 里有示例 mp3）。
const LISTEN_SAMPLE_ENABLED = process.env.LISTEN_SAMPLE_ENABLED === 'true';

export default defineConfig({
  root: 'landing',
  base: '/shengchang-ai-studio/',
  plugins: [react()],
  define: { __LISTEN_SAMPLE_ENABLED__: JSON.stringify(LISTEN_SAMPLE_ENABLED) },
  publicDir: false,
  build: { outDir: '../docs', emptyOutDir: false, assetsDir: 'vite' },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 默认转发到 4174；SHENGCHANG_API_PORT 可改（本机 4174 被占用时）。
// 不再有前端 mock：开发 / 点测都连真实服务端，Breeze 用 scripts/mock-breeze.mjs。
const apiTarget = `http://127.0.0.1:${process.env.SHENGCHANG_API_PORT || 4174}`;

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': apiTarget, '/media': apiTarget } },
});

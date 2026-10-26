// Breeze 相关 HTTP 路由。单独成模块，测试可以挂到一个临时 express app 上
// （index.js 在 import 时就 listen，没法直接拿来测）。鉴权沿用 index.js 的
// 本机 Host/Origin 守卫：这些路由挂在 /api 下，守卫先于它们执行。
import { readConfig } from './config-store.js';
import { breezeHealth } from './breeze.js';

export function registerBreezeRoutes(app) {
  // 永远 200：reachable 告诉前端服务在不在；active 表示当前是否选用 Breeze。
  app.get('/api/engines/breeze/health', async (_request, response, next) => {
    try {
      const config = await readConfig();
      response.json({ ...(await breezeHealth(config)), active: config.provider === 'breeze', timeoutMs: config.breezeTimeoutMs });
    } catch (error) { next(error); }
  });
}

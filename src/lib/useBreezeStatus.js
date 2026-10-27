import { useCallback, useEffect, useRef, useState } from 'react';
import { chainApi } from './chain-api.js';
import { normalizeBreezeStatus } from './engine.js';
import { steadyBreezeStatus } from './breeze-outage.js';

// Breeze 服务状态（GET /api/engines/breeze/status）。enabled=false 时不请求。
// generating=true（正在生成 / 一键成片在跑）时，健康检查失败不算断开：顶部不闪「未连接」。
// 真断开由任务自己报（BREEZE_UNREACHABLE 横幅）。这里也绝不改引擎。
export function useBreezeStatus(enabled = true, { intervalMs = 15000, generating = false } = {}) {
  const [status, setStatus] = useState({ state: 'checking', label: '正在连接…', detail: '' });
  const generatingRef = useRef(generating);
  generatingRef.current = generating;
  const [checking, setChecking] = useState(false);
  const refresh = useCallback(async () => {
    setChecking(true);
    const { payload, httpStatus, error } = await chainApi.breezeStatus();
    const next = normalizeBreezeStatus(payload, { httpStatus });
    const withDetail = next.state === 'disconnected' && !next.detail && error ? { ...next, detail: error } : next;
    setStatus((previous) => steadyBreezeStatus(previous, withDetail, { generating: generatingRef.current }));
    setChecking(false);
    return withDetail;
  }, []);
  useEffect(() => {
    if (!enabled) return undefined;
    refresh();
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  }, [enabled, refresh, intervalMs]);
  return { status, checking, refresh };
}

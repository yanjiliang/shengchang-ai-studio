import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { exportLockState } from './export-lock.js';

// 读服务端任务列表推出「导出要不要停用」。锁着时 2 秒一查，没锁时 5 秒一查
// （别的标签页 / 刷新前开始的一键成片也能被发现）。读取失败时保留上一次的结果。
export function useExportLock(projectId, { pendingTaskId = '', refreshToken = 0, activeMs = 2000, idleMs = 5000 } = {}) {
  const [tasks, setTasks] = useState(null);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const result = await api.listTasks(projectId, { limit: 100 });
      if (projectRef.current === projectId) setTasks(result.tasks || []);
    } catch { /* 保留上一次的结果 */ }
  }, [projectId]);
  useEffect(() => { setTasks(null); }, [projectId]);
  useEffect(() => { load(); }, [load, refreshToken, pendingTaskId]);
  const state = exportLockState({ tasks, pendingTaskId });
  useEffect(() => {
    if (!projectId) return undefined;
    const timer = setInterval(load, state.locked ? activeMs : idleMs);
    return () => clearInterval(timer);
  }, [projectId, load, state.locked, activeMs, idleMs]);
  return { ...state, tasks, refresh: load };
}

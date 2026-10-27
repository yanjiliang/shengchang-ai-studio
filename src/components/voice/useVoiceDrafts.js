import { useCallback, useEffect, useRef, useState } from 'react';
import { chainApi } from '../../lib/chain-api.js';
import { TAKE_COUNT, applyJobEvent, emptyDraft, failActiveTakes, requestCancel, retrySlot, startDraft } from '../../lib/voice-design.js';

// 各角色的声音设计草稿（试听批次）。放在 App 里，切换角色 / 页面不会丢；换作品时清空。
export function useVoiceDrafts(projectId, { onError } = {}) {
  const [drafts, setDrafts] = useState({});
  const watchers = useRef(new Map());
  const update = useCallback((roleId, fn) => setDrafts((current) => ({ ...current, [roleId]: fn(current[roleId] || emptyDraft()) })), []);
  const stopAll = useCallback(() => { for (const stop of watchers.current.values()) stop(); watchers.current.clear(); }, []);
  useEffect(() => { setDrafts({}); return stopAll; }, [projectId, stopAll]);

  // slotOffset：重做某一版时任务只生成 1 版（candidateIndex 0），要落回原来的位置。
  const watch = useCallback((roleId, jobId, slotOffset = 0) => {
    const stop = chainApi.watchJob(jobId, (event) => update(roleId, (draft) => applyJobEvent(draft, event)), { slotOffset });
    watchers.current.set(jobId, stop);
  }, [update]);

  const run = useCallback(async (roleId, { description, referenceText, testLines, count = TAKE_COUNT }) => {
    const result = await chainApi.startVoiceDesign(roleId, { projectId, description, testLines, count });
    if (!result?.jobId) throw new Error('服务端没有返回 jobId');
    // 参考文本 = 试听用的那句（锁定时服务端用 testLines[lineIndex] 当 transcript）。
    return { jobId: result.jobId, referenceText: testLines?.[0] || referenceText || '' };
  }, [projectId]);

  return {
    drafts,
    setDescription: (roleId, description, { edited = false } = {}) => update(roleId, (draft) => ({ ...draft, description, ...(edited ? { edited: true } : {}) })),
    pick: (roleId, takeId) => update(roleId, (draft) => ({ ...draft, pickedTakeId: takeId })),
    clear: (roleId) => update(roleId, (draft) => ({ ...emptyDraft(draft.description) })),
    async generate(roleId, input) {
      try {
        const { jobId, referenceText } = await run(roleId, input);
        update(roleId, (draft) => ({ ...startDraft({ ...draft, description: input.description }, { jobId }), referenceText }));
        watch(roleId, jobId);
      } catch (error) { onError?.(error); throw error; }
    },
    async retry(roleId, slot, input) {
      try {
        const { jobId } = await run(roleId, { ...input, count: 1 });
        update(roleId, (draft) => retrySlot(draft, slot, { jobId }));
        watch(roleId, jobId, slot);
      } catch (error) { onError?.(error); throw error; }
    },
    async cancel(roleId) {
      const jobId = drafts[roleId]?.jobId;
      update(roleId, requestCancel);
      if (!jobId) return;
      try { await chainApi.cancelJob(jobId); } catch (error) { onError?.(error); }
    },
    disconnected() { setDrafts((current) => Object.fromEntries(Object.entries(current).map(([roleId, draft]) => [roleId, failActiveTakes(draft)]))); },
  };
}

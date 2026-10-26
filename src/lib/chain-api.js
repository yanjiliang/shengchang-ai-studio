// 生产链路接口的客户端。字段以 docs/openapi.yaml（v0.3.0）为准；服务端的形状在这里
// 统一换成界面用的形状（hooks / 组件不直接认服务端字段）。openapi 里没有的能力
// （解除锁定、换回旧参考音、标记、待确认、撤销混音）不发请求：capabilities 告诉界面
// 哪些按钮不显示，标记 / 待确认存在台词上，跟作品一起自动保存。见 docs/chain-contract.md。

export class ApiError extends Error {
  constructor(message, status, payload) { super(message); this.status = status; this.payload = payload; this.code = payload?.code || ''; }
}

// openapi 里没有对应接口的能力。
export const capabilities = Object.freeze({ unlockReference: false, referenceHistory: false, undoRemix: false, takeTextOverride: false });

const enc = encodeURIComponent;
const finalStatus = (status) => ['cancelled', 'completed', 'failed'].includes(status);

// GET /api/engines/breeze/health → 界面用的 Breeze 状态载荷（engine.js normalizeBreezeStatus 认）。
export function breezeHealthPayload(health = {}) {
  const queue = health.queue || {};
  const queueLength = Number(queue.waiting) || 0;
  return { connected: health.reachable === true, endpoint: health.endpoint || '', latencyMs: health.latencyMs, error: health.error || '', queueLength, busy: queueLength > 0 || Boolean(queue.inFlight), voiceCount: health.voiceCount ?? null, active: health.active === true };
}

// LineTakes → { takes, activeTakeId, currentAudioUrl, audioSeed, line }。
// 原版音频（批量生成的那条）不在 takes 里：acceptedTakeId 为空时补一条 original，只用来对比。
export function normalizeLineTakes(payload = {}) {
  const takes = (payload.takes || []).map((take) => ({ ...take, status: 'ready' }));
  const activeTakeId = payload.acceptedTakeId || null;
  const original = !activeTakeId && payload.currentAudioUrl && !takes.some((take) => take.audioUrl === payload.currentAudioUrl)
    ? [{ takeId: 'original', original: true, audioUrl: payload.currentAudioUrl, seed: payload.audioSeed ?? null, status: 'ready', createdAt: 0 }] : [];
  return { takes: [...original, ...takes], activeTakeId: activeTakeId || original[0]?.takeId || null, currentAudioUrl: payload.currentAudioUrl || '', audioSeed: payload.audioSeed ?? null, line: payload.line || null };
}

// 任务（GET /api/jobs/{id}）→ 界面事件。progress 0–100 换成 0–1。
// 音色设计任务：result.events 里新的 take / take_failed 各发一个带 takeId 的事件，
// slot = candidateIndex + slotOffset（重做某一版时 count=1，candidateIndex 永远是 0）。
export function jobEvents(task, { seen = 0, slotOffset = 0 } = {}) {
  const events = [];
  const all = task?.result?.events || [];
  if (task?.kind === 'voice-design') {
    for (const event of all.slice(seen)) {
      if (event.type === 'take' && (event.lineIndex ?? 0) === 0) events.push({ jobId: task.id, takeId: event.takeId, slot: (event.candidateIndex ?? 0) + slotOffset, status: 'ready', audioUrl: event.audioUrl, seed: event.seed ?? null });
      if (event.type === 'take_failed' && (event.lineIndex ?? 0) === 0) events.push({ jobId: task.id, takeId: `${task.id}-failed-${event.candidateIndex ?? 0}`, slot: (event.candidateIndex ?? 0) + slotOffset, status: 'error', error: event.error || 'Breeze 返回错误' });
    }
  }
  const job = { jobId: task?.id, status: task?.status, progress: task?.status === 'queued' || !Number.isFinite(task?.progress) ? 0 : task.progress / 100, message: task?.message || '', queuePosition: task?.queuePosition ?? null };
  if (task?.status === 'completed') job.result = task.result;
  if (task?.result?.take) job.take = task.result.take;
  if (task?.status === 'failed') {
    const failed = [...all].reverse().find((event) => event.type === 'failed') || {};
    job.error = task.error || failed.error || '任务失败';
    job.code = failed.code || task.result?.code || '';
    // 0037：Breeze 连不上时失败事件带 causeCode（BREEZE_UNREACHABLE / BREEZE_TIMEOUT）和句数。
    for (const key of ['causeCode', 'completedLineCount', 'remainingLineCount']) if (failed[key] !== undefined) job[key] = failed[key];
  }
  events.push(job);
  return { events, seen: all.length };
}

export function normalizeReference(payload = {}) {
  return { ...payload, warnings: Array.isArray(payload.warnings) ? payload.warnings : [] };
}

export function normalizeCancel(payload) {
  const flag = (value) => Array.isArray(value) ? value.length > 0 : Boolean(value);
  return { ...payload, removed: flag(payload?.removed), discardedInFlight: flag(payload?.discardedInFlight) };
}

export function createChainApi({ fetchImpl = (...args) => globalThis.fetch(...args), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const request = async (path, options = {}) => {
    const isForm = typeof FormData !== 'undefined' && options.body instanceof FormData;
    const response = await fetchImpl(path, { ...options, headers: options.body && !isForm ? { 'Content-Type': 'application/json', ...options.headers } : options.headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new ApiError(payload.error || `请求失败 (${response.status})`, response.status, payload);
    return payload;
  };
  const json = (body) => JSON.stringify(body);
  const role = (projectId, roleId) => `/api/projects/${enc(projectId)}/roles/${enc(roleId)}`;
  const line = (lineId) => `/api/lines/${enc(lineId)}`;

  const api = {
    capabilities,
    async breezeStatus() {
      try { return { payload: breezeHealthPayload(await request('/api/engines/breeze/health')), httpStatus: 200 }; }
      catch (error) { return { payload: error.payload || null, httpStatus: error.status || 0, error: error.message }; }
    },
    // → JobAccepted { jobId, queuePosition, deduplicated, task }
    startVoiceDesign: (roleId, { projectId, description, testLines = [], count = 3 } = {}) =>
      request(`${role(projectId, roleId)}/voice-design/takes`, { method: 'POST', body: json({ description, testLines, count }) }),
    getJob: (jobId) => request(`/api/jobs/${enc(jobId)}`),
    // → { jobId, status, removed, discardedInFlight, task }；完成 / 失败的任务 409 JOB_NOT_CANCELLABLE。
    // removed / discardedInFlight 以前是计数、0020 起是布尔：都按真值读。
    cancelJob: async (jobId) => normalizeCancel(await request(`/api/jobs/${enc(jobId)}`, { method: 'DELETE' })),
    getReference: (roleId, { projectId }) => request(`${role(projectId, roleId)}/voice-reference`),
    // → VoiceReference { referenceId, audioHash, source: design|upload, version, breezeVoiceId, audioUrl, transcript, unchanged }
    // 0026 起锁定结果总带 warnings[]（REFERENCE_SHORT = 上传 5–10 秒）；老服务端没有就补 []。
    lockDesignedReference: async (roleId, { projectId, takeId }) => normalizeReference(await request(`${role(projectId, roleId)}/voice-reference`, { method: 'POST', body: json({ takeId }) })),
    uploadReference: async (roleId, { projectId, file, transcript, description = '' }) => {
      const form = new FormData();
      form.append('file', file); form.append('transcript', transcript);
      if (description) form.append('description', description);
      return normalizeReference(await request(`${role(projectId, roleId)}/voice-reference`, { method: 'POST', body: form }));
    },
    // → { affectedLineCount, lineIds }
    voiceImpact: (roleId, { projectId }) => request(`${role(projectId, roleId)}/voice-reference/impact`),
    voiceReadiness: (projectId) => request(`/api/projects/${enc(projectId)}/voice-readiness`),
    // 「换一条」：只有 { projectId, seed? }；文本 / 情绪改动要先随作品保存，服务端按当前台词生成。
    startLineTake: (lineId, { projectId, seed } = {}) => request(`${line(lineId)}/takes`, { method: 'POST', body: json({ projectId, ...(Number.isInteger(seed) ? { seed } : {}) }) }),
    lineTakes: async (lineId, { projectId } = {}) => normalizeLineTakes(await request(`${line(lineId)}/takes?projectId=${enc(projectId)}`)),
    acceptLineTake: async (lineId, takeId, { projectId } = {}) => normalizeLineTakes(await request(`${line(lineId)}/takes/${enc(takeId)}/accept`, { method: 'POST', body: json({ projectId }) })),
    // 整集：时间轴（不渲染）和导出（渲染 mp3 + 测响度）。「重新混音」就是再导出一次。
    timeline: (projectId) => request(`/api/projects/${enc(projectId)}/timeline`),
    // → ExportPrecheck { staleLineCount, staleLines[{ sceneId, lineId, staleReason }], missingAudioLineCount, ok }；只读。
    exportPrecheck: (projectId, { sceneId } = {}) => request(`/api/projects/${enc(projectId)}/export-precheck${sceneId ? `?sceneId=${enc(sceneId)}` : ''}`),
    exportEpisode: async (projectId) => { const task = await request(`/api/projects/${enc(projectId)}/export-episode`, { method: 'POST' }); return { ...task, jobId: task.jobId || task.id }; },
  };

  // 轮询 GET /api/jobs/{id}（openapi 没有事件流）。返回 stop()。
  api.watchJob = (jobId, onEvent, { pollMs = 700, slotOffset = 0 } = {}) => {
    let stopped = false; let seen = 0;
    (async () => {
      while (!stopped) {
        try {
          const task = await api.getJob(jobId);
          if (stopped) return;
          const out = jobEvents(task, { seen, slotOffset });
          seen = out.seen;
          for (const event of out.events) { if (stopped) return; onEvent(event); }
          if (finalStatus(task.status)) return;
        } catch (error) {
          onEvent({ jobId, transportError: error.message, ...(error.status === 404 ? { status: 'cancelled' } : {}) });
          if (error.status === 404) return;
        }
        await sleep(pollMs);
      }
    })();
    return () => { stopped = true; };
  };
  return api;
}

export const chainApi = createChainApi();

import { useCallback, useEffect, useRef, useState } from 'react';
import { chainApi } from '../../lib/chain-api.js';
import { audioSnapshot, mixFromExport, takeJobPatch } from '../../lib/review.js';
import { lineTakeError } from '../../lib/breeze-outage.js';

// 混音 / 导出这类服务端任务：等到 completed（返回 result）或 failed。
export function watchToEnd(jobId, onProgress, stopRef = { current: null }) {
  return new Promise((resolve, reject) => {
    stopRef.current?.();
    const stop = chainApi.watchJob(jobId, (event) => {
      if (event.takeId) return;
      if (event.status === 'running' || Number.isFinite(event.progress)) onProgress?.(event.progress ?? 0, event.message || '');
      if (event.status === 'completed' || event.status === 'done') { stop(); resolve(event.result); }
      else if (event.status === 'failed' || event.status === 'cancelled') { stop(); reject(new Error(event.error || event.transportError || '任务失败')); }
    });
    stopRef.current = stop;
  });
}

// 整集混音 = 整集导出（POST /api/projects/{id}/export-episode，FFmpeg 拼接 + 统一响度，不走 Breeze / 豆包）。
// 打开时读 GET /api/projects/{id}/timeline 的 lastExport。服务端只保留最新一份成片（同名文件覆盖），
// 所以「撤销重新混音」做不到（chainApi.capabilities.undoRemix = false）。
// 每次导出时浏览器存一份 { taskId, audio, segments }，用来判断「需要重新混音」和导出那一刻的时间轴。
const mixKey = (projectId) => `shengchang.mix.${projectId}`;
const readSnapshot = (projectId) => { try { return JSON.parse(window.localStorage.getItem(mixKey(projectId)) || 'null'); } catch { return null; } };
const writeSnapshot = (projectId, snapshot) => { try { window.localStorage.setItem(mixKey(projectId), JSON.stringify(snapshot)); } catch { /* 存不下就只是少了「需重新混音」提示 */ } };

export function useEpisodeMix(projectId, { hasAudio, lines = [] }) {
  const [state, setState] = useState({ status: 'loading', mix: null, progress: 0, message: '', error: '', previousMixId: null });
  const stopRef = useRef(null);
  const autoRef = useRef(false);
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const patch = (next) => setState((current) => ({ ...current, ...next }));
  useEffect(() => () => stopRef.current?.(), []);
  const runJob = useCallback((jobId) => watchToEnd(jobId, (progress, message) => patch({ progress, message }), stopRef), []);
  const remix = useCallback(async () => {
    patch({ status: 'remixing', progress: 0, message: '正在准备音频', error: '' });
    try {
      const audio = audioSnapshot(linesRef.current);
      const { jobId } = await chainApi.exportEpisode(projectId);
      const result = await runJob(jobId);
      if (!result?.url) throw new Error('导出没有返回音频');
      writeSnapshot(projectId, { taskId: jobId, audio, segments: result.segments || [] });
      const mix = mixFromExport({ taskId: jobId, ...result }, audio);
      patch({ status: 'ready', mix, previousMixId: null });
      return { ...mix, result };
    } catch (error) { patch({ status: state.mix ? 'ready' : 'none', error: error.message }); throw error; }
  }, [projectId, runJob, state.mix]);
  const restore = useCallback(async () => { throw new Error('服务端只保留最新一份成片，没法换回上一份'); }, []);
  const load = useCallback(async () => {
    const timeline = await chainApi.timeline(projectId);
    const last = timeline.lastExport;
    if (!last?.url) return null;
    const snapshot = readSnapshot(projectId);
    // 本机导出的：用导出那一刻的时间轴和音频指纹；别处导出（如一键配音）：没有快照，按现在的算。
    if (snapshot?.taskId === last.taskId) return mixFromExport({ ...last, segments: snapshot.segments }, snapshot.audio);
    const audio = audioSnapshot(linesRef.current);
    writeSnapshot(projectId, { taskId: last.taskId, audio, segments: timeline.segments || [] });
    return mixFromExport({ ...last, segments: timeline.segments }, audio);
  }, [projectId]);
  useEffect(() => {
    let alive = true;
    autoRef.current = false;
    load().then((mix) => { if (alive) patch(mix ? { status: 'ready', mix } : { status: 'none', mix: null }); })
      .catch((error) => { if (alive) patch({ status: 'none', mix: null, error: error.message }); });
    return () => { alive = false; };
  }, [load]);
  useEffect(() => {
    if (state.status === 'none' && hasAudio && !autoRef.current && !state.error) { autoRef.current = true; remix().catch(() => {}); }
  }, [state.status, state.error, hasAudio, remix]);
  const reload = useCallback(async () => {
    const mix = await load().catch(() => null);
    if (mix) patch({ status: 'ready', mix });
    return mix;
  }, [load]);
  return { ...state, remix, restore, reload, runJob };
}

// 「换一条」任务：每句最多一个。status: queued | running | stopping | failed | cancelled。
export function useLineJobs(projectId, { onCompleted }) {
  const [jobs, setJobs] = useState({});
  const stops = useRef(new Map());
  const completedRef = useRef(onCompleted);
  completedRef.current = onCompleted;
  useEffect(() => () => { for (const stop of stops.current.values()) stop(); }, []);
  const set = (lineId, next) => setJobs((current) => {
    const copy = { ...current };
    if (next === null) delete copy[lineId]; else copy[lineId] = { ...current[lineId], ...next };
    return copy;
  });
  const start = async (line, params) => {
    stops.current.get(line.id)?.();
    set(line.id, { status: 'queued', queuePosition: 0, error: '', params, etaS: null, progress: 0 });
    try {
      // POST 回包可能已带 status / progress / startedAt（0036 起），progress 从 0 开始；多出来的字段不影响。
      const started = await chainApi.startLineTake(line.id, { projectId, seed: params?.seed });
      const { jobId, queuePosition } = started;
      set(line.id, { jobId, queuePosition: started.status === 'running' ? null : queuePosition ?? 0, ...(started.status === 'running' ? { status: 'running', progress: Number.isFinite(started.progress) ? started.progress : 0 } : {}) });
      let done = false;
      const stop = chainApi.watchJob(jobId, (event) => {
        if (event.transportError && !event.status) return;
        const status = event.status === 'cancelling' ? 'stopping' : event.status;
        if (['queued', 'running', 'stopping'].includes(status)) set(line.id, takeJobPatch(event)); // 排队不算开始
        else if (status === 'failed') { set(line.id, takeJobPatch(event, lineTakeError(event))); stop?.(); } // 0043：可能 queued 直接 failed
        else if (status === 'cancelled') { set(line.id, takeJobPatch(event)); setTimeout(() => set(line.id, null), 2500); }
        else if (status === 'completed' && event.take && !done) {
          // result.take = openapi LineTake；只回调一次（轮询可能把 completed 发两次）。
          done = true; set(line.id, null); stops.current.get(line.id)?.(); completedRef.current?.(line.id, { ...event.take, status: 'ready' });
        } else if (status === 'completed' && !done) { done = true; set(line.id, { status: 'failed', error: '服务端没有返回这条' }); }
      });
      stops.current.set(line.id, stop);
    } catch (error) { set(line.id, { status: 'failed', error: error.message }); }
  };
  const cancel = async (line) => {
    const job = jobs[line.id];
    if (!job?.jobId) { set(line.id, null); return; }
    // DELETE /api/jobs/{id}：排队的直接移除；正在生成的这条生成完就丢掉（discardedInFlight）。
    try { const result = await chainApi.cancelJob(job.jobId); const stopping = result.discardedInFlight && result.status !== 'cancelled'; set(line.id, { status: stopping ? 'stopping' : 'cancelled' }); if (!stopping) { stops.current.get(line.id)?.(); setTimeout(() => set(line.id, null), 2500); } }
    catch (error) { set(line.id, { error: error.message }); }
  };
  const clear = (line) => set(line.id, null);
  return { jobs, start, cancel, clear };
}

// 这句的版本记录：GET /api/lines/{lineId}/takes（acceptedTakeId；最多 5 条）。
// 「待定」不是服务端状态：存在台词上（line.pendingTakeId），随作品保存。
export function useLineTakes(projectId, lineId, refreshKey, pendingTakeId = null) {
  const [state, setState] = useState({ loading: true, takes: [], activeTakeId: null, pendingTakeId: null, mixTakeId: null, error: '' });
  useEffect(() => {
    if (!lineId) return undefined;
    let alive = true;
    setState((current) => ({ ...current, loading: true, error: '' }));
    chainApi.lineTakes(lineId, { projectId }).then((result) => { if (alive) setState({ loading: false, error: '', takes: result.takes || [], activeTakeId: result.activeTakeId, pendingTakeId: (result.takes || []).some((take) => take.takeId === pendingTakeId) ? pendingTakeId : null, mixTakeId: null }); })
      .catch((error) => { if (alive) setState({ loading: false, takes: [], activeTakeId: null, pendingTakeId: null, mixTakeId: null, error: error.message }); });
    return () => { alive = false; };
  }, [projectId, lineId, refreshKey, pendingTakeId]);
  return state;
}

// 小 toast：可带一个操作（「撤销」「查看」）。
export function useReviewToast() {
  const [toast, setToast] = useState(null);
  const timer = useRef(null);
  const show = useCallback((text, action) => {
    clearTimeout(timer.current);
    setToast({ text, action, id: Date.now() });
    timer.current = setTimeout(() => setToast(null), 8000);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { toast, show, hide: () => setToast(null) };
}

export function useMediaQuery(query) {
  const get = () => typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    list.addEventListener('change', onChange);
    onChange();
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

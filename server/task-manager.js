import { access, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { readConfig } from './config-store.js';
import { audioContentHash, cacheAudio, createPersistentTask, deleteAudioCache, findCachedAudio, getPersistentTask, getProject, listAudioCache, listProjects, nextQueuedTask, requestTaskCancellation, updatePersistentTask, updateProject } from './database.js';
import { exportProjectTimeline, runtimePaths, saveMedia } from './media-store.js';
import { synthesize } from './model-adapters.js';
import { analyzeNovel } from './story-analyzer.js';

const MAX_CONCURRENCY = 2;
let activeWorkers = 0;

function extensionForMime(mime, configuredFormat) {
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('ogg')) return 'ogg';
  return configuredFormat === 'wav' ? 'wav' : 'mp3';
}

async function validCache(cache) {
  if (!cache) return false;
  try { await access(path.join(runtimePaths.MEDIA_DIR, path.basename(cache.url))); return true; }  catch { return false; }
}

const KNOWN_AUDIO_EXTENSIONS = [['mp3', 'audio/mpeg'], ['wav', 'audio/wav'], ['ogg', 'audio/ogg']];

// Eviction drops the cache row but keeps files still referenced by project
// lines. Before paying for a new synthesis, re-index such a file from disk.
export async function recoverCachedAudioFromDisk(contentHash) {
  for (const [extension, mime] of KNOWN_AUDIO_EXTENSIONS) {
    try {
      await access(path.join(runtimePaths.MEDIA_DIR, `${contentHash}.${extension}`));
      return { url: `/media/${contentHash}.${extension}`, mime };
    } catch { /* try the next extension */ }
  }
  return null;
}

// Evict oldest cache entries once cached audio exceeds cacheLimitGb. Files
// still referenced by a project line are kept on disk (only the cache row is
// dropped); unreferenced files are removed.
async function evictAudioCacheIfNeeded(limitGb) {
  const limitBytes = (Number(limitGb) || 0) * 1024 ** 3;
  if (!limitBytes) return;
  const referenced = new Set();
  for (const summary of listProjects()) {
    const project = getProject(summary.id);
    for (const scene of project?.state?.scenes || []) {
      for (const line of scene.lines || []) {
        if (line.audioUrl) referenced.add(path.basename(line.audioUrl));
        if (line.assetUrl) referenced.add(path.basename(line.assetUrl));
      }
    }
  }
  let total = 0;
  const entries = [];
  for (const row of listAudioCache()) {
    const file = path.join(runtimePaths.MEDIA_DIR, path.basename(row.url));
    const size = await stat(file).then((info) => info.size).catch(() => 0);
    entries.push({ row, file, size });
    total += size;
  }
  for (const entry of entries) {
    if (total <= limitBytes) break;
    deleteAudioCache(entry.row.content_hash);
    if (!referenced.has(path.basename(entry.row.url))) await unlink(entry.file).catch(() => {});
    total -= entry.size;
  }
}

// Exported for tests. The audio fields here are server-owned; trustedAudio
// tells updateProject to skip the browser-snapshot merge for this write.
export function applyResultsToProject(projectId, sceneId, results) {
  const project = getProject(projectId);
  if (!project) return;
  const resultByScene = new Map();
  for (const result of results) {
    const targetSceneId = result.sceneId || sceneId;
    if (!resultByScene.has(targetSceneId)) resultByScene.set(targetSceneId, []);
    resultByScene.get(targetSceneId).push(result);
  }
  const state = { ...project.state, scenes: (project.state.scenes || []).map((scene) => !resultByScene.has(scene.id) ? scene : {
    ...scene,
    status: 'ready',
    lines: scene.lines.map((line) => {
      const result = resultByScene.get(scene.id).find((item) => item.lineId === line.id);
      if (!result) return line;
      return {
        ...line,
        audioUrl: result.url,
        audioMime: result.mime,
        audioHash: result.contentHash,
        generatedAt: result.createdAt,
        synthesizedText: result.synthesizedText,
        // The request captured the text at enqueue time. If the line has been
        // edited since, this fresh clip is already stale for the current text;
        // otherwise the regeneration must clear the badge.
        audioStale: String(line.text ?? '') !== String(result.text ?? ''),
      };
    }),
  }) };
  updateProject(projectId, { state, trustedAudio: true });
}

function applyPronunciation(text, dictionary = []) {
  return dictionary.reduce((value, entry) => {
    const term = String(entry.term || '').trim();
    const replacement = String(entry.replacement || '').trim();
    return term && replacement ? value.split(term).join(replacement) : value;
  }, text);
}

async function runTask(task) {
  const config = await readConfig();
  if (task.kind === 'export-project') {
    updatePersistentTask(task.id, { status: 'running', progress: 5, message: '正在准备整集时间轴', startedAt: Date.now(), error: '' });
    try {
      const project = getProject(task.projectId);
      if (!project) throw new Error('导出目标项目不存在');
      const result = await exportProjectTimeline({
        project, targetLufs: config.targetLufs,
        shouldCancel: () => Boolean(getPersistentTask(task.id)?.cancelRequested),
        onProgress: ({ progress, message }) => updatePersistentTask(task.id, { progress, message }),
      });
      updatePersistentTask(task.id, { status: 'completed', progress: 100, message: `整集导出完成，共 ${result.sceneCount} 个场景`, result, completedAt: Date.now() });
    } catch (error) {
      if (error.code === 'TASK_CANCELLED') updatePersistentTask(task.id, { status: 'cancelled', message: '整集导出已取消', error: '', completedAt: Date.now() });
      else updatePersistentTask(task.id, { status: 'failed', message: '整集导出失败', error: error.message, completedAt: Date.now() });
    }
    return;
  }
  if (task.kind === 'analyze-novel') {
    updatePersistentTask(task.id, { status: 'running', progress: 8, message: '正在理解人物、场景与剧情结构', startedAt: Date.now(), error: '' });
    try {
      const analyzed = await analyzeNovel(config, task.payload, {
        shouldCancel: () => Boolean(getPersistentTask(task.id)?.cancelRequested),
        onProgress: ({ current, total, progress }) => updatePersistentTask(task.id, { progress, message: `正在拆解原文 ${current} / ${total} 段` }),
      });
      const project = getProject(task.projectId);
      if (!project) throw new Error('分析目标项目不存在');
      updateProject(task.projectId, { name: analyzed.name, genre: analyzed.genre, sourceFilename: task.payload.filename, sourceText: task.payload.text, trustedAudio: true, state: { ...project.state, characters: analyzed.characters, scenes: analyzed.scenes, assets: project.state.assets || [], breakdown: analyzed.breakdown } });
      updatePersistentTask(task.id, { status: 'completed', progress: 100, message: `拆解完成${analyzed.breakdown === 'heuristic' ? '（未配置文本模型，规则拆解结果建议人工校对）' : ''}，共 ${analyzed.scenes.length} 个场景`, result: { sceneCount: analyzed.scenes.length, characterCount: analyzed.characters.length, breakdown: analyzed.breakdown }, completedAt: Date.now() });
    } catch (error) {
      if (error.code === 'TASK_CANCELLED') updatePersistentTask(task.id, { status: 'cancelled', message: '小说拆解已取消', error: '', completedAt: Date.now() });
      else updatePersistentTask(task.id, { status: 'failed', message: '小说拆解失败', error: error.name === 'AbortError' ? '文本模型请求超时' : error.message, completedAt: Date.now() });
    }
    return;
  }
  const requests = task.payload.requests || [];
  const results = [];
  const projectDictionary = getProject(task.projectId)?.state?.pronunciationDictionary || [];
  updatePersistentTask(task.id, { status: 'running', progress: 2, message: '正在准备生成参数', startedAt: Date.now(), error: '' });
  try {
    for (let index = 0; index < requests.length; index += 1) {
      const latest = getPersistentTask(task.id);
      if (latest.cancelRequested) {
        updatePersistentTask(task.id, { status: 'cancelled', message: '任务已取消', result: { results }, completedAt: Date.now() });
        return;
      }
      const request = requests[index];
      const resolved = { ...request, text: applyPronunciation(request.text, projectDictionary) };
      const contentHash = audioContentHash(config, resolved);
      const cached = findCachedAudio(contentHash);
      updatePersistentTask(task.id, { message: `正在处理 ${index + 1} / ${requests.length} 句`, progress: Math.max(3, Math.round((index / requests.length) * 90)) });
      if (await validCache(cached)) {
        // Re-insert to bump created_at: eviction removes the least recently
        // *used* entries, not the least recently generated ones.
        cacheAudio({ contentHash, url: cached.url, mime: cached.mime, provider: cached.provider, model: cached.model, voiceId: cached.voice_id });
        results.push({ lineId: request.lineId, sceneId: request.sceneId || task.sceneId, url: cached.url, mime: cached.mime, text: request.text, synthesizedText: resolved.text, contentHash, cached: true, createdAt: Date.now() });
      } else {
        const recovered = await recoverCachedAudioFromDisk(contentHash);
        if (recovered) {
          cacheAudio({ contentHash, url: recovered.url, mime: recovered.mime, provider: config.provider, model: config.model, voiceId: resolved.voiceId || '' });
          results.push({ lineId: request.lineId, sceneId: request.sceneId || task.sceneId, url: recovered.url, mime: recovered.mime, text: request.text, synthesizedText: resolved.text, contentHash, cached: true, createdAt: Date.now() });
        } else {
          const audio = await synthesize(config, resolved);
          const extension = extensionForMime(audio.mime, config.audioFormat);
          const saved = await saveMedia(contentHash, extension, audio.buffer);
          cacheAudio({ contentHash, url: saved.url, mime: audio.mime, provider: config.provider, model: config.model, voiceId: resolved.voiceId || '' });
          results.push({ lineId: request.lineId, sceneId: request.sceneId || task.sceneId, url: saved.url, mime: audio.mime, text: request.text, synthesizedText: resolved.text, contentHash, cached: false, createdAt: Date.now() });
        }
      }
    }
    applyResultsToProject(task.projectId, task.sceneId, results);
    await evictAudioCacheIfNeeded(config.cacheLimitGb);
    const cacheHits = results.filter((item) => item.cached).length;
    updatePersistentTask(task.id, { status: 'completed', progress: 100, message: cacheHits ? `生成完成，复用了 ${cacheHits} 条缓存` : '语音已生成并写入项目', result: { results, cacheHits }, completedAt: Date.now() });
  } catch (error) {
    // Partial results stay in the audio cache, so a retry replays them for
    // free; say so, or the failure reads as total loss.
    const message = results.length ? `生成失败；已完成的 ${results.length} 句已进入缓存，重试时直接复用` : '生成失败';
    updatePersistentTask(task.id, { status: 'failed', message, error: error.name === 'AbortError' ? '模型请求超时' : error.message, result: { results }, completedAt: Date.now() });
  }
}

function pumpQueue() {
  while (activeWorkers < MAX_CONCURRENCY) {
    const task = nextQueuedTask();
    if (!task) break;
    activeWorkers += 1;
    updatePersistentTask(task.id, { status: 'running', message: '本地工作进程已领取任务', startedAt: Date.now() });
    runTask(task).finally(() => { activeWorkers -= 1; queueMicrotask(pumpQueue); });
  }
}

const GENERATION_KINDS = new Set(['scene', 'line', 'batch-missing', 'batch-stale']);

export function enqueueGeneration(input) {
  const kind = GENERATION_KINDS.has(input.kind) ? input.kind : 'scene';
  const task = createPersistentTask({ kind, projectId: input.projectId, sceneId: input.sceneId || '', payload: { requests: input.requests } });
  queueMicrotask(pumpQueue);
  return task;
}

export function enqueueNovelAnalysis(input) {
  const task = createPersistentTask({ kind: 'analyze-novel', projectId: input.projectId, payload: { text: input.text, filename: input.filename, name: input.name } });
  queueMicrotask(pumpQueue);
  return task;
}

export function enqueueProjectExport(input) {
  const task = createPersistentTask({ kind: 'export-project', projectId: input.projectId, payload: {} });
  queueMicrotask(pumpQueue);
  return task;
}

export function retryTask(taskId) {
  const task = getPersistentTask(taskId);
  if (!task) throw new Error('任务不存在');
  if (!['failed', 'cancelled'].includes(task.status)) throw new Error('只有失败或已取消的任务可以重试');
  const retried = createPersistentTask({ kind: task.kind, projectId: task.projectId, sceneId: task.sceneId, payload: task.payload });
  queueMicrotask(pumpQueue);
  return retried;
}

export { getPersistentTask as getTask, requestTaskCancellation as cancelTask };

queueMicrotask(pumpQueue);

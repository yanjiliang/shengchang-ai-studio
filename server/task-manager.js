import { access, stat, unlink, writeFile } from 'node:fs/promises';
import { mergeAnalyzedCharacters } from './character-meta.js';
import path from 'node:path';
import { readConfig } from './config-store.js';
import { audioContentHash, cacheAudio, createPersistentTask, deleteAudioCache, findCachedAudio, getPersistentTask, getProject, listAudioCache, listProjects, nextQueuedTask, requestTaskCancellation, soundContentHash, updatePersistentTask, updateProject } from './database.js';
import { exportProjectTimeline, runtimePaths, saveMedia } from './media-store.js';
import { synthesize, synthesizeSound } from './model-adapters.js';
import { analyzeNovel } from './story-analyzer.js';
import { runOneClickPipeline } from './one-click.js';
import { buildAttribution } from './attribution.js';
import { ensureBuiltinAssets } from './builtin-assets.js';

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
  const state = { ...project.state, scenes: (project.state.scenes || []).map((scene) => {
    if (!resultByScene.has(scene.id)) return scene;
    const lines = scene.lines.map((line) => {
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
    });
    // A scene is only ready once every dialogue line actually has audio; a
    // partially-failed run must not relabel the scene as finished.
    const complete = lines.some((line) => line.type === 'dialogue') && lines.every((line) => line.type !== 'dialogue' || line.audioUrl);
    return { ...scene, status: complete ? 'ready' : scene.status, lines };
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

// B3: the single pipeline every generation flow - manual scene/line, batch
// fill/stale, and the future one-click orchestrator - runs requests through.
// Per-line failures are collected and the run continues (TODO-2): one bad
// line must not hide the state of the lines after it. synthesize is
// injectable so tests can fail specific lines on demand.
export async function runGenerationRequests(config, requests, { projectId, sceneId, onProgress, shouldCancel, synthesize: synthesizeLine = synthesize } = {}) {
  const results = [];
  const failures = [];
  const projectDictionary = getProject(projectId)?.state?.pronunciationDictionary || [];
  for (let index = 0; index < requests.length; index += 1) {
    if (shouldCancel?.()) return { status: 'cancelled', results, failures };
    const request = requests[index];
    onProgress?.({ index, total: requests.length, message: `正在处理 ${index + 1} / ${requests.length} 句` });
    try {
      const resolved = { ...request, text: applyPronunciation(request.text, projectDictionary) };
      const contentHash = audioContentHash(config, resolved);
      const cached = findCachedAudio(contentHash);
      if (await validCache(cached)) {
        // Re-insert to bump created_at: eviction removes the least recently
        // *used* entries, not the least recently generated ones.
        cacheAudio({ contentHash, url: cached.url, mime: cached.mime, provider: cached.provider, model: cached.model, voiceId: cached.voice_id });
        results.push({ lineId: request.lineId, sceneId: request.sceneId || sceneId, url: cached.url, mime: cached.mime, text: request.text, synthesizedText: resolved.text, contentHash, cached: true, createdAt: Date.now() });
      } else {
        const recovered = await recoverCachedAudioFromDisk(contentHash);
        if (recovered) {
          cacheAudio({ contentHash, url: recovered.url, mime: recovered.mime, provider: config.provider || '', model: config.model || '', voiceId: resolved.voiceId || '' });
          results.push({ lineId: request.lineId, sceneId: request.sceneId || sceneId, url: recovered.url, mime: recovered.mime, text: request.text, synthesizedText: resolved.text, contentHash, cached: true, createdAt: Date.now() });
        } else {
          const audio = await synthesizeLine(config, resolved);
          const extension = extensionForMime(audio.mime, config.audioFormat);
          const saved = await saveMedia(contentHash, extension, audio.buffer);
          cacheAudio({ contentHash, url: saved.url, mime: audio.mime, provider: config.provider || '', model: config.model || '', voiceId: resolved.voiceId || '' });
          results.push({ lineId: request.lineId, sceneId: request.sceneId || sceneId, url: saved.url, mime: audio.mime, text: request.text, synthesizedText: resolved.text, contentHash, cached: false, usage: audio.usage || null, createdAt: Date.now() });
        }
      }
    } catch (error) {
      failures.push({ lineId: request.lineId, sceneId: request.sceneId || sceneId, text: request.text, error: error.name === 'AbortError' ? '模型请求超时' : error.message });
    }
  }
  return { status: 'done', results, failures };
}

// 计费字数只统计真正调用了模型的句子（缓存命中不计费）；没有 usage 的
// 提供方（demo / custom）返回 null，避免把“未知”显示成 0。
export function sumBilledCharacters(results) {
  const billed = results.map((item) => item.usage?.billedCharacters).filter((value) => Number.isFinite(value));
  return billed.length ? billed.reduce((sum, value) => sum + value, 0) : null;
}

async function runGenerationTask(task, config) {
  const requests = task.payload.requests || [];
  // Direction-lab takes (design Approach C) are auditions only: same line,
  // different 潜台词/情绪/强度/距离. The clips land in the audio cache (keyed
  // by those params), so applying a take to the line and regenerating hits
  // the cache for free — but the take itself must never overwrite the line.
  const isDirectionLab = task.kind === 'direction-lab';
  updatePersistentTask(task.id, { status: 'running', progress: 2, message: isDirectionLab ? '正在生成方向对比' : '正在准备生成参数', startedAt: Date.now(), error: '' });
  try {
    const outcome = await runGenerationRequests(config, requests, {
      projectId: task.projectId,
      sceneId: task.sceneId,
      onProgress: ({ index, total, message }) => updatePersistentTask(task.id, { message, progress: Math.max(3, Math.round((index / total) * 90)) }),
      shouldCancel: () => Boolean(getPersistentTask(task.id)?.cancelRequested),
    });
    if (outcome.status === 'cancelled') {
      updatePersistentTask(task.id, { status: 'cancelled', message: '任务已取消', result: { results: outcome.results }, completedAt: Date.now() });
      return;
    }
    if (!isDirectionLab) applyResultsToProject(task.projectId, task.sceneId, outcome.results);
    await evictAudioCacheIfNeeded(config.cacheLimitGb);
    const { results, failures } = outcome;
    const cacheHits = results.filter((item) => item.cached).length;
    const billedCharacters = sumBilledCharacters(results);
    if (failures.length) {
      // All-failed runs keep the failed status so one-click retry applies;
      // partial failures complete so the good audio lands in the project.
      // Successful lines stay in the audio cache, so a retry replays them
      // for free and only pays for the failed ones.
      const allFailed = !results.length;
      updatePersistentTask(task.id, {
        status: allFailed ? 'failed' : 'completed', progress: 100,
        message: allFailed ? `生成失败：${failures.length} 句全部失败` : `生成完成：${results.length} 句成功，${failures.length} 句失败（任务历史可逐句查看）`,
        error: allFailed ? failures[0].error : '',
        result: { results, failures, cacheHits, billedCharacters }, completedAt: Date.now(),
      });
      return;
    }
    updatePersistentTask(task.id, { status: 'completed', progress: 100, message: isDirectionLab
      ? `方向对比已生成（${results.length} 组，可在检查器试听）`
      : cacheHits ? `生成完成，复用了 ${cacheHits} 条缓存` : '语音已生成并写入项目', result: { results, cacheHits, billedCharacters }, completedAt: Date.now() });
  } catch (error) {
    updatePersistentTask(task.id, { status: 'failed', message: '生成失败', error: error.name === 'AbortError' ? '模型请求超时' : error.message, completedAt: Date.now() });
  }
}

async function runTask(task) {
  const config = await readConfig();
  if (task.kind === 'one-click') {
    // The pipeline owns its progress/message/status writes; this wrapper only
    // maps its outcomes onto task status.
    updatePersistentTask(task.id, { status: 'running', progress: 2, message: '一键成片启动', startedAt: Date.now(), error: '' });
    try {
      await runOneClickPipeline(task, config);
    } catch (error) {
      if (error.code === 'TASK_CANCELLED') updatePersistentTask(task.id, { status: 'cancelled', message: '一键成片已取消', error: '', completedAt: Date.now() });
      else updatePersistentTask(task.id, { status: 'failed', message: '一键成片失败', error: error.message, completedAt: Date.now() });
    }
    return;
  }
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
      // The attribution sheet rides along with the episode: the creator sees
      // exactly which sound assets went into it and what each source permits.
      try {
        const lines = (project.state.scenes || []).flatMap((scene) => scene.lines || []);
        const attribution = buildAttribution({ lines, assets: project.state.assets || [], builtinIndex: await ensureBuiltinAssets() });
        const name = String(result.name || '').replace(/\.[^.]+$/, '');
        await writeFile(path.join(runtimePaths.EXPORT_DIR, `${name}-来源清单.txt`), `${attribution}\n`, 'utf8');
        result.attributionUrl = `/media/exports/${encodeURIComponent(`${name}-来源清单.txt`)}`;
      } catch { /* attribution is best-effort; the export itself is done */ }
      updatePersistentTask(task.id, { status: 'completed', progress: 100, message: `整集导出完成，共 ${result.sceneCount} 个场景`, result, completedAt: Date.now() });
    } catch (error) {
      if (error.code === 'TASK_CANCELLED') updatePersistentTask(task.id, { status: 'cancelled', message: '整集导出已取消', error: '', completedAt: Date.now() });
      else updatePersistentTask(task.id, { status: 'failed', message: '整集导出失败', error: error.message, completedAt: Date.now() });
    }
    return;
  }
  if (task.kind === 'sound-generate') {
    const sound = task.payload.sound || {};
    updatePersistentTask(task.id, { status: 'running', progress: 10, message: `正在生成声音素材：${String(sound.prompt || '').slice(0, 30)}`, startedAt: Date.now(), error: '' });
    try {
      // Same content-addressed cache as speech, keyed by prompt + params: the
      // same description reused anywhere in the project is a free hit.
      const contentHash = soundContentHash(config, sound);
      const cached = findCachedAudio(contentHash);
      let url;
      let mime;
      let durationMs = Number(sound.durationMs) || 0;
      if (await validCache(cached)) {
        cacheAudio({ contentHash, url: cached.url, mime: cached.mime, provider: config.sfxProvider || 'demo', model: config.sfxModel || '', voiceId: '' });
        url = cached.url; mime = cached.mime;
      } else {
        const recovered = await recoverCachedAudioFromDisk(contentHash);
        if (recovered) {
          cacheAudio({ contentHash, url: recovered.url, mime: recovered.mime, provider: config.sfxProvider || 'demo', model: config.sfxModel || '', voiceId: '' });
          url = recovered.url; mime = recovered.mime;
        } else {
          const audio = await synthesizeSound(config, sound);
          const extension = extensionForMime(audio.mime, 'mp3');
          const saved = await saveMedia(contentHash, extension, audio.buffer);
          cacheAudio({ contentHash, url: saved.url, mime: audio.mime, provider: config.sfxProvider || 'demo', model: config.sfxModel || '', voiceId: '' });
          url = saved.url; mime = audio.mime;
        }
      }
      await evictAudioCacheIfNeeded(config.cacheLimitGb);
      updatePersistentTask(task.id, {
        status: 'completed', progress: 100, message: `声音素材已生成：${String(sound.prompt || '').slice(0, 30)}`,
        result: { url, name: `${String(sound.prompt || '声音素材').slice(0, 24)}`, contentHash, durationMs, prompt: sound.prompt, type: sound.type, provider: config.sfxProvider || 'demo' },
        completedAt: Date.now(),
      });
    } catch (error) {
      updatePersistentTask(task.id, { status: 'failed', message: '声音素材生成失败', error: error.message, completedAt: Date.now() });
    }
    return;
  }
  if (task.kind === 'analyze-novel') {
    updatePersistentTask(task.id, { status: 'running', progress: 8, message: '正在理解人物、场景与剧情结构', startedAt: Date.now(), error: '' });
    try {
      const analyzed = await analyzeNovel(config, task.payload, {
        shouldCancel: () => Boolean(getPersistentTask(task.id)?.cancelRequested),
        onProgress: ({ current, total, progress }) => updatePersistentTask(task.id, { progress, message: `正在拆解原文 ${current} / ${total} 段` }),
        // Chunk checkpoints land in the task payload; retryTask copies the
        // payload, so a failed multi-chunk run resumes from the last completed
        // chunk instead of re-paying for every LLM call.
        resume: task.payload.resume,
        onCheckpoint: (checkpoint) => updatePersistentTask(task.id, { payload: { resume: checkpoint } }),
      });
      const project = getProject(task.projectId);
      if (!project) throw new Error('分析目标项目不存在');
      updateProject(task.projectId, { name: analyzed.name, genre: analyzed.genre, sourceFilename: task.payload.filename, sourceText: task.payload.text, trustedAudio: true, state: { ...project.state, characters: mergeAnalyzedCharacters(project.state.characters, analyzed.characters), scenes: analyzed.scenes, assets: project.state.assets || [], breakdown: analyzed.breakdown } });
      updatePersistentTask(task.id, { status: 'completed', progress: 100, message: `拆解完成${analyzed.breakdown === 'heuristic' ? '（未配置文本模型，规则拆解结果建议人工校对）' : ''}，共 ${analyzed.scenes.length} 个场景`, result: { sceneCount: analyzed.scenes.length, characterCount: analyzed.characters.length, breakdown: analyzed.breakdown }, completedAt: Date.now() });
    } catch (error) {
      if (error.code === 'TASK_CANCELLED') updatePersistentTask(task.id, { status: 'cancelled', message: '小说拆解已取消', error: '', completedAt: Date.now() });
      else updatePersistentTask(task.id, { status: 'failed', message: '小说拆解失败', error: error.name === 'AbortError' ? '文本模型请求超时' : error.message, completedAt: Date.now() });
    }
    return;
  }
  await runGenerationTask(task, config);
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

const GENERATION_KINDS = new Set(['scene', 'line', 'batch-missing', 'batch-stale', 'direction-lab']);

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

export function enqueueSoundGeneration(input) {
  const task = createPersistentTask({ kind: 'sound-generate', projectId: input.projectId, payload: { sound: input.sound } });
  queueMicrotask(pumpQueue);
  return task;
}

export function enqueueProjectExport(input) {
  const task = createPersistentTask({ kind: 'export-project', projectId: input.projectId, payload: {} });
  queueMicrotask(pumpQueue);
  return task;
}

// one-click gets its own enqueue path on purpose: GENERATION_KINDS above
// would coerce the kind to 'scene' (design B3, endpoint guards).
export function enqueueOneClick({ projectId }) {
  const task = createPersistentTask({ kind: 'one-click', projectId, payload: { completedStages: [] } });
  queueMicrotask(pumpQueue);
  return task;
}

// Cache-hit prediction for the estimate endpoint (§8 follow-up): runs the
// exact hash path generation would take, minus the synthesis.
export async function estimateGeneration(config, requests, { projectId } = {}) {
  const projectDictionary = getProject(projectId)?.state?.pronunciationDictionary || [];
  let cacheHits = 0;
  for (const request of requests) {
    const resolved = { ...request, text: applyPronunciation(request.text, projectDictionary) };
    if (await validCache(findCachedAudio(audioContentHash(config, resolved)))) cacheHits += 1;
  }
  return cacheHits;
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

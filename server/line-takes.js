// 单句重生成（take）：POST /api/lines/:lineId/takes 为一句对白生成一段新试听，
// 可指定 seed（不传则服务端随机一个，立即在响应里返回）。seed 进缓存键，所以
// 换 seed 重试一定是真的新生成，不会拿回缓存里的旧音频；同 seed 同参数则命中缓存。
//
// 试听不直接覆盖台词音频：保存在 state.lineTakes[lineId].takes（服务端拥有，
// 浏览器自动保存不能覆盖），最多保留 LINE_TAKES_MAX 段供 A/B；
// POST .../takes/:takeId/accept 才把某段写成台词当前音频（旧的仍在列表里）。
//
// 任务 kind 'line-take'，走共享任务队列（交互槽 + 引擎通道 interactive 优先级），
// 事件 / 取消与音色设计一致：result.events = queued → started → take → completed |
// failed | cancelled；DELETE /api/jobs/:jobId 取消。
import { randomInt } from 'node:crypto';
import { access, unlink } from 'node:fs/promises';
import path from 'node:path';
import { buildGenerationRequest } from '../shared/generation-requests.mjs';
import { PRIORITY, queuePositionOf } from './breeze-lane.js';
import { createPersistentTask, deleteAudioCache, getPersistentTask, getProject, listPersistentTasks, listProjects, updatePersistentTask, updateProject } from './database.js';
import { runtimePaths } from './media-store.js';
import { appendEvent } from './voice-design.js';
import { generationVoiceMap } from './voice-references.js';

export const LINE_TAKES_MAX = 5;
export const SEED_MIN = 0;
export const SEED_MAX = 2 ** 31 - 1;

export class LineTakeError extends Error {
  constructor(message, { status = 400, code = 'LINE_TAKE_INVALID' } = {}) {
    super(message);
    this.name = 'LineTakeError';
    this.status = status;
    this.code = code;
  }
}

// seed：省略 / null = 随机；否则必须是 0..2^31-1 的整数（JSON number，不收字符串）。
export function normalizeSeed(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < SEED_MIN || value > SEED_MAX) {
    throw new LineTakeError(`seed 需为 ${SEED_MIN}–${SEED_MAX} 的整数`, { code: 'SEED_INVALID' });
  }
  return value;
}

// lineId 在项目内唯一，但跨项目不保证（复制项目会重复）。给了 projectId 就只在该
// 项目里找；没给则全库找，多个项目命中时要求调用方带 projectId。
export function locateLine(lineId, projectId) {
  const id = String(lineId || '');
  if (!id) throw new LineTakeError('lineId 不能为空', { code: 'LINE_ID_REQUIRED' });
  const candidates = projectId ? [getProject(String(projectId))].filter(Boolean) : listProjects().map((summary) => getProject(summary.id)).filter(Boolean);
  if (projectId && !candidates.length) throw new LineTakeError('项目不存在', { status: 404, code: 'PROJECT_NOT_FOUND' });
  const matches = [];
  for (const project of candidates) for (const scene of project.state.scenes || []) {
    const line = (scene.lines || []).find((item) => item.id === id);
    if (line) matches.push({ project, scene, line });
  }
  if (!matches.length) throw new LineTakeError('台词不存在', { status: 404, code: 'LINE_NOT_FOUND' });
  if (matches.length > 1) throw new LineTakeError('多个项目里有同一个 lineId，请在请求里带上 projectId', { status: 409, code: 'LINE_AMBIGUOUS' });
  return matches[0];
}

export function createLineTakeJob(config, { lineId, projectId, seed: rawSeed } = {}) {
  const requestedSeed = normalizeSeed(rawSeed);
  const { project, scene, line } = locateLine(lineId, projectId);
  if (line.type !== 'dialogue') throw new LineTakeError('只有对白可以生成语音试听', { status: 409, code: 'LINE_NOT_DIALOGUE' });
  if (!String(line.text || '').trim()) throw new LineTakeError('台词文本为空', { status: 409, code: 'LINE_TEXT_EMPTY' });
  const request = { ...buildGenerationRequest(line, generationVoiceMap(config, project.state)), sceneId: scene.id };
  if (!request.voiceId) throw new LineTakeError(config.provider === 'breeze' ? '该角色还没有锁定参考音（Breeze）' : '该角色还没有绑定音色', { status: 409, code: 'LINE_VOICE_UNBOUND' });
  // 显式 seed + 同一句已有同 seed 的进行中任务 → 复用（重复点击 / 网络重试幂等）。
  if (requestedSeed !== null) {
    const existing = listPersistentTasks(project.id, 100).map((item) => getPersistentTask(item.id))
      .find((task) => task?.kind === 'line-take' && ['queued', 'running'].includes(task.status) && task.payload.lineId === line.id && task.payload.seed === requestedSeed && task.payload.seedSource === 'request');
    if (existing) return { task: existing, deduplicated: true };
  }
  const seed = requestedSeed ?? randomInt(1, SEED_MAX);
  const task = createPersistentTask({ kind: 'line-take', projectId: project.id, sceneId: scene.id, payload: { lineId: line.id, sceneId: scene.id, seed, seedSource: requestedSeed === null ? 'random' : 'request', request: { ...request, seed } } });
  appendEvent(task.id, { type: 'queued', seed, queuePosition: null }, { result: { lineId: line.id, seed } });
  return { task: getPersistentTask(task.id), deduplicated: false };
}

// 项目里还有谁在用这个音频文件（台词当前音频 / 其他试听）。缓存文件按内容哈希
// 命名，同参数同 seed 的两段试听、或已采用的那段，可能指向同一个文件。
function fileStillReferenced(state, audioUrl) {
  const name = path.basename(audioUrl || '');
  for (const scene of state.scenes || []) for (const line of scene.lines || []) if (path.basename(line.audioUrl || '') === name) return true;
  for (const record of Object.values(state.lineTakes || {})) for (const take of record?.takes || []) if (path.basename(take.audioUrl || '') === name) return true;
  return false;
}

// 每句最多 LINE_TAKES_MAX 段：超出时删最旧的、既不是已采用也不是台词当前音频的
// 试听（列表项 + 缓存行 + 文件；文件仍被引用时只删列表项）。
async function storeTake(projectId, take) {
  const project = getProject(projectId);
  if (!project) return null;
  const lineTakes = { ...(project.state.lineTakes || {}) };
  const record = lineTakes[take.lineId] || { acceptedTakeId: null, takes: [] };
  const currentAudio = (project.state.scenes || []).flatMap((scene) => scene.lines || []).find((line) => line.id === take.lineId)?.audioUrl || '';
  const takes = [...record.takes.filter((item) => item.takeId !== take.takeId), take];
  const dropped = [];
  while (takes.length > LINE_TAKES_MAX) {
    const dropIndex = takes.findIndex((item) => item.takeId !== record.acceptedTakeId && item.audioUrl !== currentAudio && item.takeId !== take.takeId);
    if (dropIndex < 0) break;
    dropped.push(...takes.splice(dropIndex, 1));
  }
  lineTakes[take.lineId] = { ...record, takes };
  const state = { ...project.state, lineTakes };
  updateProject(projectId, { trustedAudio: true, state });
  for (const old of dropped) {
    // 缓存跨项目共享：其他项目的台词/试听也可能指向同一文件。
    const states = [state, ...listProjects().filter((summary) => summary.id !== projectId).map((summary) => getProject(summary.id)?.state).filter(Boolean)];
    if (states.some((item) => fileStillReferenced(item, old.audioUrl))) continue;
    if (old.contentHash) deleteAudioCache(old.contentHash);
    await unlink(path.join(runtimePaths.MEDIA_DIR, path.basename(old.audioUrl))).catch(() => {});
  }
  return lineTakes[take.lineId];
}

// 由任务泵调用；runGeneration 是 task-manager 的 runGenerationRequests（注入以避免循环依赖）。
export async function runLineTakeTask(task, config, { runGeneration }) {
  const { request, seed, lineId, sceneId } = task.payload;
  updatePersistentTask(task.id, { status: 'running', progress: 5, message: '单句试听排队中', startedAt: Date.now(), error: '' });
  appendEvent(task.id, { type: 'started', seed });
  const finishCancelled = () => appendEvent(task.id, { type: 'cancelled' }, { status: 'cancelled', message: '单句试听已取消', completedAt: Date.now(), error: '' });
  try {
    const outcome = await runGeneration(config, [request], {
      projectId: task.projectId, sceneId, jobId: task.id, priority: PRIORITY.interactive,
      shouldCancel: () => Boolean(getPersistentTask(task.id)?.cancelRequested),
      onProgress: ({ message }) => updatePersistentTask(task.id, { message, progress: 20 }),
    });
    if (outcome.status === 'cancelled' || getPersistentTask(task.id)?.cancelRequested) return finishCancelled();
    if (outcome.failures.length || !outcome.results.length) throw Object.assign(new Error(outcome.failures[0]?.error || '生成失败'), { code: outcome.failures[0]?.code || 'GENERATION_FAILED' });
    const result = outcome.results[0];
    // 缓存命中且这句已有同一缓存键（同文本/参数/seed/参考音）的试听：不再新增一段（不占
    // 5 段名额），直接返回那段，reused = true、takeId 是原来那段的（≠ 本任务 jobId）。
    const existing = result.cached ? getProject(task.projectId)?.state?.lineTakes?.[lineId]?.takes?.find((item) => item.contentHash === result.contentHash) : null;
    if (existing) {
      const take = { ...existing, cached: true, reused: true };
      appendEvent(task.id, { type: 'take', ...take, jobId: task.id, queuePosition: queuePositionOf(task.id) }, { result: { take } });
      appendEvent(task.id, { type: 'completed', takeId: take.takeId, seed: take.seed, cached: true, reused: true }, {
        status: 'completed', progress: 100, completedAt: Date.now(),
        message: `与已有试听完全相同（seed ${take.seed}），未新增试听`,
      });
      return;
    }
    const take = {
      takeId: task.id, lineId, sceneId, jobId: task.id,
      // 缓存命中时上游没有回 X-Seed，用请求的 seed（缓存键里就是它）。
      seed: Number.isSafeInteger(result.seed) ? result.seed : seed, requestedSeed: seed,
      audioUrl: result.url, mime: result.mime, contentHash: result.contentHash, voiceId: result.voiceId,
      text: result.text, synthesizedText: result.synthesizedText, engine: result.engine || config.provider || '',
      cached: Boolean(result.cached), reused: false, createdAt: result.createdAt || Date.now(),
    };
    await storeTake(task.projectId, take);
    appendEvent(task.id, { type: 'take', ...take, queuePosition: queuePositionOf(task.id) }, { result: { take } });
    appendEvent(task.id, { type: 'completed', takeId: take.takeId, seed: take.seed, cached: take.cached }, {
      status: 'completed', progress: 100, completedAt: Date.now(),
      message: `单句试听已生成（seed ${take.seed}${take.cached ? '，复用缓存' : ''}），可试听后采用`,
    });
  } catch (error) {
    if (error.code === 'TASK_CANCELLED') return finishCancelled();
    appendEvent(task.id, { type: 'failed', error: error.message, code: error.code || '' }, { status: 'failed', message: '单句试听失败', error: error.message, completedAt: Date.now() });
  }
}

export function listLineTakes(lineId, projectId) {
  const { project, scene, line } = locateLine(lineId, projectId);
  const record = project.state.lineTakes?.[line.id] || { acceptedTakeId: null, takes: [] };
  return { projectId: project.id, sceneId: scene.id, lineId: line.id, currentAudioUrl: line.audioUrl || '', audioSeed: line.audioSeed ?? null, acceptedTakeId: record.acceptedTakeId || null, takes: record.takes };
}

// 采用：写成台词当前音频（applyResults 注入，避免循环依赖）。旧试听保留可再切回。
export async function acceptLineTake(lineId, takeId, { projectId, applyResults }) {
  const { project, scene, line } = locateLine(lineId, projectId);
  const record = project.state.lineTakes?.[line.id];
  const take = record?.takes?.find((item) => item.takeId === String(takeId || ''));
  if (!take) throw new LineTakeError('试听不存在，或不属于这句台词', { status: 404, code: 'TAKE_NOT_FOUND' });
  try { await access(path.join(runtimePaths.MEDIA_DIR, path.basename(take.audioUrl))); } catch {
    throw new LineTakeError('试听音频文件已不存在，请重新生成', { status: 410, code: 'TAKE_EXPIRED' });
  }
  applyResults(project.id, scene.id, [{ lineId: line.id, sceneId: scene.id, url: take.audioUrl, mime: take.mime, contentHash: take.contentHash, text: take.text, synthesizedText: take.synthesizedText, engine: take.engine, seed: take.seed, requestSeed: take.requestedSeed, createdAt: Date.now() }]);
  const fresh = getProject(project.id);
  const lineTakes = { ...(fresh.state.lineTakes || {}), [line.id]: { ...record, acceptedTakeId: take.takeId } };
  updateProject(project.id, { trustedAudio: true, state: { ...fresh.state, lineTakes } });
  return listLineTakes(line.id, project.id);
}

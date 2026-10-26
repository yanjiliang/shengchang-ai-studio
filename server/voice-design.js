// 角色音色设计试听（Breeze /voice_design）：一次任务生成 count 个候选 × 每条测试台词
// 一段试听（take），按顺序在 Breeze 通道里排队（interactive 优先级，先于批量生成）。
// 任务本身就是一条 tasks 表记录（kind 'voice-design'），前端照常轮询
// GET /api/tasks/:id；进度事件写在 result.events，试听写在 result.takes。
//
// 同一候选的所有测试台词用同一个 seed（同 seed + 同描述 ≈ 同一个声音），不同候选
// 用不同的随机 seed，这样 3 个候选才真的不一样。
import { randomInt } from 'node:crypto';
import { readdir, stat, unlink, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { breezeAudio, BreezeError } from './breeze.js';
import { breezeLane, PRIORITY } from './breeze-lane.js';
import { createPersistentTask, getPersistentTask, listPersistentTasks, updatePersistentTask } from './database.js';
import { runtimePaths } from './media-store.js';
import { ReferenceError, requireProjectRole } from './voice-references.js';

export const DESIGN_LIMITS = Object.freeze({ descriptionMax: 500, testLinesMax: 5, testLineMaxChars: 200, countMin: 1, countMax: 5, countDefault: 3, takesMax: 15 });
export const TAKE_TTL_MS = 24 * 60 * 60 * 1000;
const TAKE_FILE = /^take-[0-9a-f-]{36}-\d+\.wav$/;

export function validateDesignInput(body = {}) {
  const description = String(body.description ?? '').trim();
  if (!description) throw new ReferenceError('声音描述不能为空', { code: 'DESIGN_DESCRIPTION_REQUIRED', rule: 'description' });
  if (description.length > DESIGN_LIMITS.descriptionMax) throw new ReferenceError(`声音描述最长 ${DESIGN_LIMITS.descriptionMax} 字`, { code: 'DESIGN_DESCRIPTION_TOO_LONG', rule: 'description' });
  if (!Array.isArray(body.testLines) || !body.testLines.length) throw new ReferenceError('至少需要 1 条测试台词（testLines）', { code: 'DESIGN_TEST_LINES_REQUIRED', rule: 'testLines' });
  if (body.testLines.length > DESIGN_LIMITS.testLinesMax) throw new ReferenceError(`测试台词最多 ${DESIGN_LIMITS.testLinesMax} 条`, { code: 'DESIGN_TEST_LINES_TOO_MANY', rule: 'testLines' });
  const testLines = body.testLines.map((line) => (typeof line === 'string' ? line.trim() : ''));
  if (testLines.some((line) => !line)) throw new ReferenceError('测试台词不能为空，且必须是字符串', { code: 'DESIGN_TEST_LINE_INVALID', rule: 'testLines' });
  if (testLines.some((line) => line.length > DESIGN_LIMITS.testLineMaxChars)) throw new ReferenceError(`每条测试台词最长 ${DESIGN_LIMITS.testLineMaxChars} 字`, { code: 'DESIGN_TEST_LINE_TOO_LONG', rule: 'testLines' });
  const count = body.count === undefined ? DESIGN_LIMITS.countDefault : Number(body.count);
  if (!Number.isInteger(count) || count < DESIGN_LIMITS.countMin || count > DESIGN_LIMITS.countMax) throw new ReferenceError(`count 需为 ${DESIGN_LIMITS.countMin}–${DESIGN_LIMITS.countMax} 的整数`, { code: 'DESIGN_COUNT_INVALID', rule: 'count' });
  if (count * testLines.length > DESIGN_LIMITS.takesMax) throw new ReferenceError(`一次最多生成 ${DESIGN_LIMITS.takesMax} 段试听（count × 测试台词条数）`, { code: 'DESIGN_TOO_MANY_TAKES', rule: 'count' });
  return { description, testLines, count };
}

// 没被锁定的试听超过 24 小时就删掉（锁定时音频已复制成 ref-*.wav，不受影响）。
export async function sweepStaleTakes(now = Date.now(), ttlMs = TAKE_TTL_MS) {
  let removed = 0;
  const names = await readdir(runtimePaths.MEDIA_DIR).catch(() => []);
  for (const name of names) {
    if (!TAKE_FILE.test(name)) continue;
    const file = path.join(runtimePaths.MEDIA_DIR, name);
    const info = await stat(file).catch(() => null);
    if (info && now - info.mtimeMs > ttlMs) { await unlink(file).catch(() => {}); removed += 1; }
  }
  return removed;
}

function appendEvent(taskId, event, patch = {}) {
  const task = getPersistentTask(taskId);
  const result = { ...(task.result || {}), ...(patch.result || {}) };
  result.events = [...(task.result?.events || []), { at: Date.now(), ...event }];
  return updatePersistentTask(taskId, { ...patch, result });
}

// 创建任务（立即返回）。同一角色已有相同参数的任务在排队/进行中时直接返回它（幂等）。
export function createVoiceDesignJob(config, { projectId, roleId, body }) {
  if (config.provider !== 'breeze') throw new ReferenceError('当前语音引擎不是 Breeze：音色设计试听需要 Breeze 引擎', { status: 409, code: 'ENGINE_NOT_BREEZE' });
  requireProjectRole(projectId, roleId);
  const input = validateDesignInput(body);
  const existing = listPersistentTasks(projectId, 100).find((task) => task.kind === 'voice-design' && ['queued', 'running'].includes(task.status));
  if (existing) {
    const full = getPersistentTask(existing.id);
    if (full.payload.roleId === roleId && JSON.stringify([full.payload.description, full.payload.testLines, full.payload.count]) === JSON.stringify([input.description, input.testLines, input.count])) return { task: full, deduplicated: true };
  }
  const task = createPersistentTask({ kind: 'voice-design', projectId, payload: { roleId, ...input } });
  appendEvent(task.id, { type: 'queued', queuePosition: null }, { result: { roleId, takes: [] } });
  sweepStaleTakes().catch(() => {});
  return { task: getPersistentTask(task.id), deduplicated: false };
}

// 由任务泵调用（task-manager runTask）。
export async function runVoiceDesignTask(task, config, { lane = breezeLane } = {}) {
  const { roleId, description, testLines, count } = task.payload;
  updatePersistentTask(task.id, { status: 'running', progress: 2, message: '音色设计排队中', startedAt: Date.now(), error: '' });
  appendEvent(task.id, { type: 'started' });
  const total = count * testLines.length;
  const takes = [];
  let failures = 0;
  const cancelled = () => Boolean(getPersistentTask(task.id)?.cancelRequested);
  const finishCancelled = () => {
    appendEvent(task.id, { type: 'cancelled' }, { status: 'cancelled', message: '音色设计已取消', completedAt: Date.now(), error: '' });
  };
  try {
    if (config.provider !== 'breeze') throw new BreezeError('语音引擎已不是 Breeze，音色设计中止', { status: 409, code: 'ENGINE_NOT_BREEZE' });
    for (let candidateIndex = 0; candidateIndex < count; candidateIndex += 1) {
      // 1..2^31-1：Breeze 的 seed 是普通整数，避开 0 和超大值。
      const seed = randomInt(1, 2 ** 31 - 1);
      for (let lineIndex = 0; lineIndex < testLines.length; lineIndex += 1) {
        if (cancelled()) return finishCancelled();
        const n = takes.length + failures;
        const queued = lane.run({ jobId: task.id, priority: PRIORITY.interactive, fn: () => breezeAudio(config, '/voice_design', { text: testLines[lineIndex], instruction: description, seed }) });
        const queuePosition = lane.positionOf(task.id);
        updatePersistentTask(task.id, { message: `正在生成试听 ${n + 1} / ${total}${queuePosition ? `（前面还有 ${queuePosition} 个生成）` : ''}`, progress: Math.max(3, Math.round((n / total) * 95)) });
        let audio;
        try { audio = await queued; } catch (error) {
          if (error.code === 'TASK_CANCELLED') return finishCancelled();
          failures += 1;
          appendEvent(task.id, { type: 'take_failed', candidateIndex, lineIndex, seed, error: error.message, code: error.code || '' });
          // 服务不在/超时：后面的也必然失败，别空转。
          if (error.code === 'BREEZE_UNREACHABLE' || error.code === 'BREEZE_TIMEOUT') throw error;
          continue;
        }
        const takeId = `${task.id}-${n}`;
        const filename = `take-${takeId}.wav`;
        await writeFile(path.join(runtimePaths.MEDIA_DIR, filename), audio.buffer);
        const take = { takeId, audioUrl: `/media/${filename}`, seed: audio.seed ?? seed, requestedSeed: seed, lineIndex, candidateIndex, text: testLines[lineIndex], mime: audio.mime, createdAt: Date.now() };
        takes.push(take);
        appendEvent(task.id, { type: 'take', ...take, queuePosition: lane.positionOf(task.id) }, { result: { takes } });
      }
    }
    if (!takes.length) throw new Error(`音色设计失败：${failures} 段试听全部失败`);
    appendEvent(task.id, { type: 'completed', takeCount: takes.length, failedCount: failures }, {
      status: 'completed', progress: 100, completedAt: Date.now(),
      message: `音色设计完成：${takes.length} 段试听${failures ? `，${failures} 段失败` : ''}`,
    });
  } catch (error) {
    appendEvent(task.id, { type: 'failed', error: error.message, code: error.code || '' }, { status: 'failed', message: '音色设计失败', error: error.message, completedAt: Date.now() });
  }
}

// 锁定 takeId 时用：找到这段试听，校验它属于这个项目/角色。
export async function findTake(projectId, roleId, takeId) {
  const match = /^([0-9a-f-]{36})-(\d+)$/.exec(String(takeId || ''));
  const task = match && getPersistentTask(match[1]);
  const take = task?.kind === 'voice-design' && task.projectId === projectId && task.payload.roleId === roleId
    ? (task.result?.takes || []).find((item) => item.takeId === takeId) : null;
  if (!take) throw new ReferenceError('试听不存在，或不属于这个角色', { status: 404, code: 'TAKE_NOT_FOUND' });
  const file = path.join(runtimePaths.MEDIA_DIR, path.basename(take.audioUrl));
  try { await access(file); } catch { throw new ReferenceError('试听音频已过期被清理，请重新生成', { status: 410, code: 'TAKE_EXPIRED' }); }
  return { take, file, description: task.payload.description, transcript: task.payload.testLines[take.lineIndex] };
}

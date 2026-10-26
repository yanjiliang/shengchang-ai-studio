// 0043（e2e4 Bug 2）：单句试听的 started（“命中缓存”）事件只在真的开始之后出现。
// Breeze 连不上（预检失败）时事件序列只有 queued → failed。只用 127.0.0.1（DEAD 端口 / 模拟 Breeze）。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startMockBreeze } from './test-support/mock-breeze.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-line-take-events-test-'));
process.env.HOME = scratch;
process.env.SHENGCHANG_RUNTIME_DIR = path.join(scratch, 'runtime');
const { createProject, createPersistentTask, getPersistentTask } = await import('./database.js');
const { ensureRuntime } = await import('./media-store.js');
const { appendEvent } = await import('./voice-design.js');
const { runLineTakeTask } = await import('./line-takes.js');
const { runGenerationRequests } = await import('./task-manager.js');

const DEAD = 'http://127.0.0.1:1';
let projectId;
let counter = 0;
let mock;

function newTask() {
  counter += 1;
  const request = { lineId: `l${counter}`, sceneId: 's1', speakerId: 'nobody', text: `试听事件第${counter}句。`, voiceId: 'preset-x', seed: 42 };
  const task = createPersistentTask({ kind: 'line-take', projectId, sceneId: 's1', payload: { lineId: request.lineId, sceneId: 's1', seed: 42, seedSource: 'request', request } });
  appendEvent(task.id, { type: 'queued', seed: 42, queuePosition: null }, { result: { lineId: request.lineId, seed: 42 } });
  return getPersistentTask(task.id);
}
const types = (taskId) => getPersistentTask(taskId).result.events.map((event) => event.type);
const startedMessages = (taskId) => getPersistentTask(taskId).result.events.filter((event) => event.type === 'started');

before(async () => {
  await ensureRuntime();
  mock = await startMockBreeze();
  projectId = createProject({ name: '试听事件', state: { scenes: [], characters: [] } }).id;
});
after(async () => { await mock.close(); rmSync(scratch, { recursive: true, force: true }); });

describe('单句试听事件序列', () => {
  test('Breeze 连不上（真实预检，DEAD 端口）→ queued → failed，没有 started / 命中缓存', async () => {
    const task = newTask();
    await runLineTakeTask(task, { provider: 'breeze', breezeEndpoint: DEAD }, { runGeneration: runGenerationRequests });
    assert.deepEqual(types(task.id), ['queued', 'failed']);
    const final = getPersistentTask(task.id);
    assert.equal(final.status, 'failed');
    assert.equal(final.result.events.at(-1).code, 'BREEZE_UNREACHABLE');
    assert.notEqual(final.message, '命中缓存');
    assert.equal(final.startedAt ?? null, null, '没开始就没有 startedAt');
  });

  test('进通道前的非连接失败（注入）→ queued → failed', async () => {
    const task = newTask();
    await runLineTakeTask(task, { provider: 'breeze', breezeEndpoint: DEAD }, { runGeneration: async () => ({ status: 'done', results: [], failures: [{ error: '参考音缺失', code: 'X' }] }) });
    assert.deepEqual(types(task.id), ['queued', 'failed']);
  });

  test('Breeze 正常（模拟）→ queued → started → take → completed；同参数再来一次命中缓存 → started 补在 take 前', async () => {
    const config = { provider: 'breeze', breezeEndpoint: mock.endpoint };
    const fresh = newTask();
    await runLineTakeTask(fresh, config, { runGeneration: runGenerationRequests });
    assert.deepEqual(types(fresh.id), ['queued', 'started', 'take', 'completed']);
    assert.equal(startedMessages(fresh.id).length, 1);

    const repeat = createPersistentTask({ kind: 'line-take', projectId, sceneId: 's1', payload: fresh.payload });
    appendEvent(repeat.id, { type: 'queued', seed: 42, queuePosition: null }, { result: { lineId: fresh.payload.lineId, seed: 42 } });
    mock.state.down = true; // 缓存命中不需要 Breeze
    try {
      await runLineTakeTask(getPersistentTask(repeat.id), config, { runGeneration: runGenerationRequests });
    } finally { mock.state.down = false; }
    assert.deepEqual(types(repeat.id), ['queued', 'started', 'take', 'completed']);
  });

  test('预检通过、轮到引擎后才连不上 → queued → started → failed（started 来自 onLaneStart，不是命中缓存）', async () => {
    const task = newTask();
    await runLineTakeTask(task, { provider: 'breeze', breezeEndpoint: DEAD }, {
      runGeneration: (config, requests, options) => runGenerationRequests(config, requests, {
        ...options, retryDelaysMs: [0, 0],
        preflight: async (_config, { lane }) => (lane === null ? { status: 'unreachable', reachable: false } : { status: 'ok', reachable: true, via: 'busy' }),
      }),
    });
    assert.deepEqual(types(task.id), ['queued', 'started', 'failed']);
  });
});

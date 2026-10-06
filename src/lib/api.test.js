import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForTask } from './api.js';

const noSleep = () => Promise.resolve();

test('waitForTask：完成态返回任务并推进 onProgress', async () => {
  const states = [
    { status: 'running', progress: 10 },
    { status: 'running', progress: 50 },
    { status: 'completed', progress: 100, result: { ok: 1 } },
  ];
  let cursor = 0;
  const seen = [];
  const task = await waitForTask('t', (state) => seen.push(state.progress), { getTask: async () => states[Math.min(cursor++, states.length - 1)], sleep: noSleep });
  assert.equal(task.status, 'completed');
  assert.deepEqual(seen, [10, 50, 100]);
});

test('waitForTask：失败态抛出任务错误', async () => {
  await assert.rejects(
    waitForTask('t', null, { getTask: async () => ({ status: 'failed', error: '模型超时' }), sleep: noSleep }),
    /模型超时/,
  );
});

test('waitForTask：取消态与超时各自抛错', async () => {
  await assert.rejects(waitForTask('t', null, { getTask: async () => ({ status: 'cancelled' }), sleep: noSleep }), /已取消/);
  await assert.rejects(waitForTask('t', null, { getTask: async () => ({ status: 'running' }), sleep: noSleep, timeoutMs: -1 }), /超时/);
});

test('waitForTask：退避序列 350ms 起步、2s 封顶', async () => {
  const delays = [];
  let calls = 0;
  await waitForTask('t', null, {
    getTask: async () => { calls += 1; return calls >= 5 ? { status: 'completed' } : { status: 'running' }; },
    sleep: async (ms) => { delays.push(ms); },
  });
  assert.deepEqual(delays, [350, 525, 788, 1182]);
});

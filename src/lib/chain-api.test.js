import test from 'node:test';
import assert from 'node:assert/strict';
import { breezeHealthPayload, capabilities, createChainApi, jobEvents, normalizeCancel, normalizeLineTakes } from './chain-api.js';

const respond = (status, payload) => ({ ok: status < 400, status, json: async () => payload });
const recorder = (payload = {}, status = 200) => {
  const calls = [];
  const api = createChainApi({ sleep: async () => {}, fetchImpl: async (path, options = {}) => { calls.push({ path, method: options.method || 'GET', body: options.body }); return respond(status, typeof payload === 'function' ? payload(path) : payload); } });
  return { api, calls };
};

test('openapi 没有的能力全部关掉（界面据此隐藏按钮）', () => {
  assert.deepEqual(Object.values(capabilities), [false, false, false, false]);
});

test('breezeStatus：health 换成界面载荷；404 不抛错，带上 httpStatus', async () => {
  assert.deepEqual(breezeHealthPayload({ reachable: true, endpoint: 'http://b', latencyMs: 12, queue: { waiting: 2, inFlight: 1 } }), { connected: true, endpoint: 'http://b', latencyMs: 12, error: '', queueLength: 2, busy: true, voiceCount: null, active: false });
  const { api } = recorder({ error: '接口不存在' }, 404);
  const result = await api.breezeStatus();
  assert.equal(result.httpStatus, 404);
});

test('音色设计 / 参考音的路径都在 /api/projects/{id}/roles/{roleId} 下', async () => {
  const { api, calls } = recorder({ jobId: 'j1' });
  await api.startVoiceDesign('悟空', { projectId: 'p 1', description: 'd', testLines: ['a'], count: 3 });
  await api.getReference('r', { projectId: 'p1' });
  await api.lockDesignedReference('r', { projectId: 'p1', takeId: 't1' });
  await api.voiceImpact('r', { projectId: 'p1' });
  await api.voiceReadiness('p1');
  assert.deepEqual(calls.map(({ path, method }) => [path, method]), [
    ['/api/projects/p%201/roles/%E6%82%9F%E7%A9%BA/voice-design/takes', 'POST'],
    ['/api/projects/p1/roles/r/voice-reference', 'GET'],
    ['/api/projects/p1/roles/r/voice-reference', 'POST'],
    ['/api/projects/p1/roles/r/voice-reference/impact', 'GET'],
    ['/api/projects/p1/voice-readiness', 'GET'],
  ]);
  assert.deepEqual(JSON.parse(calls[0].body), { description: 'd', testLines: ['a'], count: 3 });
  assert.deepEqual(JSON.parse(calls[2].body), { takeId: 't1' });
});

test('上传参考音走 multipart：file + transcript（+ description）', async () => {
  const { api, calls } = recorder({ referenceId: 'vr' });
  await api.uploadReference('r', { projectId: 'p1', file: new Blob(['x'], { type: 'audio/wav' }), transcript: '你好', description: '沙哑' });
  assert.ok(calls[0].body instanceof FormData);
  assert.equal(calls[0].body.get('transcript'), '你好');
  assert.equal(calls[0].body.get('description'), '沙哑');
});

test('出错时抛 ApiError，带 status / code / payload（如 409 VOICE_NOT_READY）', async () => {
  const { api } = recorder({ error: '没锁', code: 'VOICE_NOT_READY', missingVoiceRoles: [{ roleId: 'b' }] }, 409);
  await assert.rejects(api.voiceReadiness('p1'), (error) => error.status === 409 && error.code === 'VOICE_NOT_READY' && error.payload.missingVoiceRoles[0].roleId === 'b');
});

test('单句 take：只有 projectId + 可选整数 seed；accept 走 takeId', async () => {
  const { api, calls } = recorder({ jobId: 'j1', takes: [], acceptedTakeId: 't1' });
  await api.startLineTake('l1', { projectId: 'p1' });
  await api.startLineTake('l1', { projectId: 'p1', seed: 42 });
  await api.startLineTake('l1', { projectId: 'p1', seed: '42' });
  const accepted = await api.acceptLineTake('l1', 't1', { projectId: 'p1' });
  await api.lineTakes('l1', { projectId: 'p1' });
  assert.deepEqual(calls.map(({ path, method }) => [path, method]), [['/api/lines/l1/takes', 'POST'], ['/api/lines/l1/takes', 'POST'], ['/api/lines/l1/takes', 'POST'], ['/api/lines/l1/takes/t1/accept', 'POST'], ['/api/lines/l1/takes?projectId=p1', 'GET']]);
  assert.deepEqual(calls.slice(0, 3).map(({ body }) => JSON.parse(body)), [{ projectId: 'p1' }, { projectId: 'p1', seed: 42 }, { projectId: 'p1' }]);
  assert.equal(accepted.activeTakeId, 't1');
});

test('normalizeLineTakes：没采用过时补一条原版，只用来对比', () => {
  const fresh = normalizeLineTakes({ acceptedTakeId: null, currentAudioUrl: '/media/a.mp3', audioSeed: 7, takes: [{ takeId: 't1', audioUrl: '/media/b.mp3', seed: 9 }] });
  assert.deepEqual(fresh.takes.map((take) => [take.takeId, Boolean(take.original)]), [['original', true], ['t1', false]]);
  assert.equal(fresh.activeTakeId, 'original');
  assert.equal(fresh.takes[0].seed, 7);
  const accepted = normalizeLineTakes({ acceptedTakeId: 't1', currentAudioUrl: '/media/b.mp3', takes: [{ takeId: 't1', audioUrl: '/media/b.mp3' }] });
  assert.deepEqual(accepted.takes.map((take) => take.takeId), ['t1']);
});

test('jobEvents：progress 0–100 → 0–1；音色设计事件带 slot（含 slotOffset）', () => {
  const task = { id: 'j1', kind: 'voice-design', status: 'running', progress: 50, queuePosition: 0, result: { events: [{ type: 'take', takeId: 'a', candidateIndex: 0, lineIndex: 0, audioUrl: '/a' }, { type: 'take_failed', candidateIndex: 1, lineIndex: 0, error: '超时' }] } };
  const { events, seen } = jobEvents(task, { slotOffset: 2 });
  assert.equal(seen, 2);
  assert.deepEqual(events.map((event) => [event.slot, event.status]), [[2, 'ready'], [3, 'error'], [undefined, 'running']]);
  assert.equal(events.at(-1).progress, 0.5);
  assert.equal(jobEvents(task, { seen: 2 }).events.length, 1);
  const failed = jobEvents({ id: 'j2', status: 'failed', error: 'Breeze 不可用' }).events.at(-1);
  assert.equal(failed.error, 'Breeze 不可用');
});

test('watchJob：轮询 GET /api/jobs/{id} 直到结束；404 当作已取消', async () => {
  const states = [{ id: 'j1', status: 'queued', queuePosition: 2 }, { id: 'j1', status: 'running', progress: 40 }, { id: 'j1', status: 'completed', progress: 100, result: { take: { takeId: 't' } } }];
  let index = 0;
  const { api } = recorder(() => states[Math.min(index++, 2)]);
  const events = [];
  await new Promise((resolve) => api.watchJob('j1', (event) => { events.push(event); if (event.status === 'completed') resolve(); }, { pollMs: 0 }));
  assert.deepEqual(events.map((event) => event.status), ['queued', 'running', 'completed']);
  assert.equal(events[0].queuePosition, 2);
  assert.equal(events[2].take.takeId, 't');
  const gone = recorder({ error: '任务不存在' }, 404);
  const last = await new Promise((resolve) => gone.api.watchJob('x', resolve, { pollMs: 0 }));
  assert.equal(last.status, 'cancelled');
});

test('取消、时间轴、导出：导出的 id 换成 jobId', async () => {
  const { api, calls } = recorder((path) => path.endsWith('export-episode') ? { id: 'task_1', status: 'queued' } : {});
  await api.cancelJob('j 1');
  await api.timeline('p1');
  const exported = await api.exportEpisode('p1');
  assert.deepEqual(calls.map(({ path, method }) => [path, method]), [['/api/jobs/j%201', 'DELETE'], ['/api/projects/p1/timeline', 'GET'], ['/api/projects/p1/export-episode', 'POST']]);
  assert.equal(exported.jobId, 'task_1');
});

test('排队中的任务进度按 0 算；取消结果的 removed / discardedInFlight 按真值读（计数或布尔都行）', () => {
  assert.equal(jobEvents({ id: 'q', status: 'queued', progress: 35 }).events.at(-1).progress, 0);
  assert.equal(jobEvents({ id: 'r', status: 'running', progress: 35 }).events.at(-1).progress, 0.35);
  assert.deepEqual([normalizeCancel({ removed: 1, discardedInFlight: 0 }).removed, normalizeCancel({ removed: 1, discardedInFlight: 0 }).discardedInFlight], [true, false]);
  assert.equal(normalizeCancel({ removed: false, discardedInFlight: true }).discardedInFlight, true);
  assert.equal(normalizeCancel({}).removed, false);
});

test('0037：单句失败事件的 code / causeCode 传到前端', () => {
  const task = { id: 't1', status: 'failed', error: 'Breeze 服务连不上', result: { events: [{ type: 'failed', error: 'x', code: 'BREEZE_UNREACHABLE', causeCode: 'BREEZE_TIMEOUT', completedLineCount: 0, remainingLineCount: 1 }] } };
  const job = jobEvents(task).events.at(-1);
  assert.equal(job.code, 'BREEZE_UNREACHABLE');
  assert.equal(job.causeCode, 'BREEZE_TIMEOUT');
  assert.equal(job.remainingLineCount, 1);
});

// 生产链路：单句试听（seed）、上限 5、采用、stale、任务取消、音色就绪 / 一键成片拦截。
// 全部打模拟 Breeze，不碰真实 Breeze / 豆包。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { startMockBreeze } from './test-support/mock-breeze.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-production-test-'));
process.env.HOME = scratch;
process.env.SHENGCHANG_RUNTIME_DIR = path.join(scratch, 'runtime');
const { writeConfig, readConfig } = await import('./config-store.js');
const { queuePositionOf } = await import('./breeze-lane.js');
const { createProject, getProject, updateProject, getPersistentTask, createPersistentTask } = await import('./database.js');
const { runtimePaths, ensureRuntime } = await import('./media-store.js');
const { registerProductionRoutes } = await import('./production-routes.js');
const { LINE_TAKES_MAX } = await import('./line-takes.js');
const { annotateStaleness, voiceReadiness, generationVoiceMap } = await import('./voice-references.js');
const { oneClickMissingVoiceRoles, presetVoicesFor, runOneClickPipeline } = await import('./one-click.js');
const express = (await import('express')).default;

let mock;
let server;
let base;
let projectId;

const characters = [
  { id: 'tangseng', name: '唐僧', role: '主角', description: '慈悲而迂腐的高僧', gender: '男', age: '青年' },
  { id: 'sunwukong', name: '孙悟空', role: '主角', description: '由规则拆解推断的说话人', voiceDescription: '少年男声，嗓音清亮急躁' },
  { id: 'bajie', name: '猪八戒', role: '配角', description: '' },
];
const scenes = [{ id: 's1', title: '白虎岭', lines: [
  { id: 'pl1', type: 'dialogue', speakerId: 'tangseng', speaker: '唐僧', text: '徒弟，为师腹中饥饿。', emotion: '疲惫', intensity: 30, pace: 85 },
  { id: 'pl2', type: 'dialogue', speakerId: 'sunwukong', speaker: '孙悟空', text: '师父稍等！', emotion: '急切', intensity: 60, pace: 105 },
  { id: 'pl3', type: 'narration', text: '山路崎岖。' },
  { id: 'pl4', type: 'dialogue', speakerId: 'bajie', speaker: '猪八戒', text: '吃饭吃饭。', emotion: '开心', intensity: 50, pace: 100 },
] }];
const tangRef = { breezeVoiceId: 'ref-tangseng-aaaa', audioHash: 'aaaa', audioUrl: '/media/references/aaaa.wav', transcript: '参考', source: 'upload' };

async function waitForTask(id, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    const task = getPersistentTask(id);
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;
    if (Date.now() - started > timeoutMs) throw new Error(`task ${id} still ${task.status}`);
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
async function waitFor(predicate, timeoutMs = 5_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const api = (pathname, init = {}) => fetch(`${base}${pathname}`, init).then(async (response) => ({ status: response.status, body: await response.json() }));
const postJson = (pathname, body) => api(pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ttsRequests = () => mock.state.requests.filter((item) => item.path === '/tts');
const lineOf = (id) => getProject(projectId).state.scenes[0].lines.find((line) => line.id === id);
const mediaFile = (audioUrl) => path.join(runtimePaths.MEDIA_DIR, path.basename(audioUrl));

async function makeTake(body = {}) {
  const created = await postJson('/api/lines/pl1/takes', { projectId, ...body });
  assert.ok([200, 202].includes(created.status), JSON.stringify(created.body));
  return { created: created.body, task: await waitForTask(created.body.jobId) };
}

before(async () => {
  await ensureRuntime();
  mock = await startMockBreeze();
  mock.state.voices.set(tangRef.breezeVoiceId, { id: tangRef.breezeVoiceId, transcript: '参考' });
  await writeConfig({ provider: 'breeze', breezeEndpoint: mock.endpoint });
  // voiceMap 里残留的演示音色 id 在 Breeze 下必须被忽略。
  projectId = createProject({ name: '生产链路测试', state: { scenes, characters, assets: [], voiceMap: { sunwukong: 'zh_male_demo_preset' }, voiceReferences: { tangseng: tangRef } } }).id;
  const app = express();
  app.use(express.json());
  registerProductionRoutes(app);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await mock.close();
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => { mock.state.failNext = null; mock.state.hold = false; mock.state.delayMs = 0; });

describe('单句试听（seed）', () => {
  test('不传 seed：202 立即给出随机 seed；Breeze 请求体带该 seed；result / 事件带实际 seed', async () => {
    const before = ttsRequests().length;
    const { created, task } = await makeTake();
    assert.equal(created.seedSource, 'random');
    assert.ok(Number.isInteger(created.seed) && created.seed > 0);
    assert.equal(task.status, 'completed', task.error);
    const sent = ttsRequests().slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].body.seed, created.seed);
    assert.equal(sent[0].body.voiceId, tangRef.breezeVoiceId);
    assert.equal(task.result.take.seed, created.seed);
    assert.equal(task.result.take.cached, false);
    const types = task.result.events.map((event) => event.type);
    assert.deepEqual(types, ['queued', 'started', 'take', 'completed']);
    for (const event of task.result.events.filter((item) => item.type !== 'started' || item.seed !== undefined)) {
      if (['queued', 'started', 'take', 'completed'].includes(event.type)) assert.equal(event.seed, created.seed, event.type);
    }
    assert.ok(existsSync(mediaFile(task.result.take.audioUrl)));
  });

  test('seed 进缓存键：换 seed 真生成、同 seed 命中缓存', async () => {
    const first = await makeTake({ seed: 1234 });
    const n = ttsRequests().length;
    const second = await makeTake({ seed: 4321 });
    assert.equal(ttsRequests().length, n + 1, '换 seed 必须真的请求 Breeze');
    assert.notEqual(first.task.result.take.contentHash, second.task.result.take.contentHash);
    const third = await makeTake({ seed: 1234 });
    assert.equal(ttsRequests().length, n + 1, '同 seed 同参数不应再请求');
    assert.equal(third.task.result.take.cached, true);
    assert.equal(third.task.result.take.seed, 1234);
    assert.equal(third.task.result.take.contentHash, first.task.result.take.contentHash);
  });

  test('缓存命中不新增重复试听（不占 5 段名额）：返回原来那段，reused=true', async () => {
    const first = await makeTake({ seed: 7777 });
    const countBefore = (await api(`/api/lines/pl1/takes?projectId=${projectId}`)).body.takes.length;
    const again = await makeTake({ seed: 7777 });
    const take = again.task.result.take;
    assert.equal(take.cached, true);
    assert.equal(take.reused, true);
    assert.equal(take.takeId, first.task.result.take.takeId, 'takeId 指向已有那段');
    assert.notEqual(take.takeId, again.created.jobId);
    assert.equal(take.seed, 7777);
    const listed = (await api(`/api/lines/pl1/takes?projectId=${projectId}`)).body.takes;
    assert.equal(listed.length, countBefore, '列表长度不变');
    assert.equal(listed.filter((item) => item.contentHash === take.contentHash).length, 1);
    assert.equal(first.task.result.take.reused, false);
    const events = again.task.result.events.map((event) => event.type);
    assert.deepEqual(events.slice(-2), ['take', 'completed']);
  });

  test('显式 seed 去重：同句同 seed 进行中的任务被复用', async () => {
    mock.state.hold = true;
    const a = await postJson('/api/lines/pl1/takes', { projectId, seed: 777 });
    const b = await postJson('/api/lines/pl1/takes', { projectId, seed: 777 });
    assert.equal(a.status, 202);
    assert.equal(b.status, 200);
    assert.equal(b.body.deduplicated, true);
    assert.equal(b.body.jobId, a.body.jobId);
    await waitFor(() => mock.state.held.length === 1);
    mock.release(); mock.state.hold = false;
    assert.equal((await waitForTask(a.body.jobId)).status, 'completed');
  });

  test('参数校验：seed 非法 / 台词不存在 / 旁白 / 未锁参考音', async () => {
    assert.equal((await postJson('/api/lines/pl1/takes', { projectId, seed: '12' })).body.code, 'SEED_INVALID');
    assert.equal((await postJson('/api/lines/pl1/takes', { projectId, seed: -1 })).body.code, 'SEED_INVALID');
    assert.equal((await postJson('/api/lines/pl1/takes', { projectId, seed: 2 ** 31 })).status, 400);
    const missing = await postJson('/api/lines/nope/takes', { projectId });
    assert.equal(missing.status, 404); assert.equal(missing.body.code, 'LINE_NOT_FOUND');
    assert.equal((await postJson('/api/lines/pl3/takes', { projectId })).body.code, 'LINE_NOT_DIALOGUE');
    // 孙悟空 voiceMap 里有演示音色，但 Breeze 只认锁定参考音。
    const unbound = await postJson('/api/lines/pl2/takes', { projectId });
    assert.equal(unbound.status, 409); assert.equal(unbound.body.code, 'LINE_VOICE_UNBOUND');
  });

  test(`上限 ${LINE_TAKES_MAX}：删最旧的非采用试听（列表 + 文件），已采用的永远保留`, async () => {
    const listed = await api(`/api/lines/pl1/takes?projectId=${projectId}`);
    assert.equal(listed.status, 200);
    // 先采用最旧那段。
    const oldest = listed.body.takes[0];
    const accepted = await postJson(`/api/lines/pl1/takes/${oldest.takeId}/accept`, { projectId });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.acceptedTakeId, oldest.takeId);
    assert.equal(accepted.body.currentAudioUrl, oldest.audioUrl);
    assert.equal(accepted.body.audioSeed, oldest.requestedSeed);
    assert.equal(accepted.body.line.stale, false, '采用的试听带 seed，复算缓存键要一致');

    const made = [];
    for (let seed = 10; seed < 10 + LINE_TAKES_MAX + 2; seed += 1) made.push((await makeTake({ seed })).task.result.take);
    const after = (await api(`/api/lines/pl1/takes?projectId=${projectId}`)).body;
    assert.equal(after.takes.length, LINE_TAKES_MAX);
    assert.ok(after.takes.some((take) => take.takeId === oldest.takeId), '已采用的试听不能被删');
    assert.ok(existsSync(mediaFile(oldest.audioUrl)));
    assert.deepEqual(after.takes.slice(1).map((take) => take.takeId), made.slice(-(LINE_TAKES_MAX - 1)).map((take) => take.takeId));
    // 被挤掉的新生成试听（seed 10..12）文件已删除。
    for (const dropped of made.slice(0, made.length - (LINE_TAKES_MAX - 1))) assert.equal(existsSync(mediaFile(dropped.audioUrl)), false, `seed ${dropped.seed}`);
    // 被删的缓存行也没了：同 seed 再来一次是真生成。
    const n = ttsRequests().length;
    const again = await makeTake({ seed: 10 });
    assert.equal(again.task.result.take.cached, false);
    assert.equal(ttsRequests().length, n + 1);
  });

  test('采用不存在的试听 → 404 TAKE_NOT_FOUND', async () => {
    const result = await postJson('/api/lines/pl1/takes/nope/accept', { projectId });
    assert.equal(result.status, 404); assert.equal(result.body.code, 'TAKE_NOT_FOUND');
  });

  test('浏览器自动保存不能覆盖 lineTakes，也不会把 stale 写进库', async () => {
    const current = getProject(projectId);
    const annotated = annotateStaleness(await readConfig(), current);
    updateProject(projectId, { state: { ...annotated.state, lineTakes: {} } });
    const saved = getProject(projectId);
    assert.ok(saved.state.lineTakes.pl1.takes.length > 0);
    assert.equal('stale' in saved.state.scenes[0].lines[0], false);
  });
});

describe('stale', () => {
  test('参数（情绪）改了 → stale params；文本改了 → text；改回去恢复', async () => {
    const config = await readConfig();
    const fresh = getProject(projectId);
    const flags = (state) => annotateStaleness(config, { ...fresh, state }).state.scenes[0].lines;
    const lines = fresh.state.scenes[0].lines;
    assert.equal(flags(fresh.state)[0].stale, false);
    assert.equal(flags(fresh.state)[1].stale, false, '没有音频的句子不算 stale');
    assert.equal(flags(fresh.state)[2].stale, false);
    const withLine = (patch) => ({ ...fresh.state, scenes: [{ ...fresh.state.scenes[0], lines: [{ ...lines[0], ...patch }, ...lines.slice(1)] }] });
    assert.deepEqual([flags(withLine({ emotion: '愤怒' }))[0].stale, flags(withLine({ emotion: '愤怒' }))[0].staleReason], [true, 'params']);
    // 文本改了 → text；改回原文 → 不再 stale（即使持久化的 audioStale 还是 true：纯由 hash 推导）。
    const edited = flags(withLine({ text: '改过的台词。', audioStale: true }))[0];
    assert.deepEqual([edited.stale, edited.staleReason, edited.audioStale], [true, 'text', true]);
    const reverted = flags(withLine({ audioStale: true }))[0];
    assert.deepEqual([reverted.stale, reverted.staleReason, reverted.audioStale], [false, null, false]);
    // 文本和参数都改了 → text 优先；只改回文本 → params。
    assert.equal(flags(withLine({ text: '改过的台词。', emotion: '愤怒' }))[0].staleReason, 'text');
    // 换了参考音 → params。
    const swapped = { ...fresh.state, voiceReferences: { tangseng: { ...tangRef, breezeVoiceId: 'ref-tangseng-bbbb', audioHash: 'bbbb' } } };
    assert.equal(flags(swapped)[0].staleReason, 'params');
    // 切到别的引擎不判 stale。
    assert.equal(annotateStaleness({ ...config, provider: 'demo' }, fresh).state.scenes[0].lines[0].stale, false);
  });
});

describe('任务取消 DELETE /api/jobs/:jobId', () => {
  test('排队中的移除；在飞的丢弃结果；都变 cancelled；重复取消 200；完成的 409；不存在 404', async () => {
    mock.state.hold = true;
    const running = await postJson('/api/lines/pl1/takes', { projectId, seed: 9001 });
    await waitFor(() => mock.state.held.length === 1);
    const queued = await postJson('/api/lines/pl1/takes', { projectId, seed: 9002 });
    // 等它真的排进 Breeze 车道（位置 1，前面是在飞的那段）。
    await waitFor(() => queuePositionOf(queued.body.jobId) === 1);
    const position = (await api(`/api/jobs/${running.body.jobId}`)).body.queuePosition;
    assert.equal(position, 0);

    const cancelQueued = await api(`/api/jobs/${queued.body.jobId}`, { method: 'DELETE' });
    assert.equal(cancelQueued.status, 200, JSON.stringify(cancelQueued.body));
    assert.equal(cancelQueued.body.status, 'cancelled');
    assert.strictEqual(cancelQueued.body.removed, true);
    assert.strictEqual(cancelQueued.body.discardedInFlight, false);

    const cancelRunning = await api(`/api/jobs/${running.body.jobId}`, { method: 'DELETE' });
    assert.equal(cancelRunning.body.status, 'cancelled');
    assert.strictEqual(cancelRunning.body.removed, false);
    assert.strictEqual(cancelRunning.body.discardedInFlight, true);
    assert.equal(getPersistentTask(running.body.jobId).result.events.at(-1).type, 'cancelled');

    mock.release(); mock.state.hold = false;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const takes = getProject(projectId).state.lineTakes.pl1.takes;
    assert.equal(takes.some((take) => [running.body.jobId, queued.body.jobId].includes(take.takeId)), false, '取消的结果不入库');
    assert.equal(getPersistentTask(running.body.jobId).status, 'cancelled');

    assert.equal((await api(`/api/jobs/${running.body.jobId}`, { method: 'DELETE' })).status, 200);
    const done = (await makeTake({ seed: 5 })).task;
    const notCancellable = await api(`/api/jobs/${done.id}`, { method: 'DELETE' });
    assert.equal(notCancellable.status, 409); assert.equal(notCancellable.body.code, 'JOB_NOT_CANCELLABLE');
    const unknown = await api('/api/jobs/nope', { method: 'DELETE' });
    assert.equal(unknown.status, 404); assert.equal(unknown.body.code, 'JOB_NOT_FOUND');
  });
});

describe('音色就绪 / 一键成片拦截', () => {
  test('voice-readiness：Breeze 下没锁参考音的角色都列出（含音色描述），演示音色不算', async () => {
    const result = await api(`/api/projects/${projectId}/voice-readiness`);
    assert.equal(result.status, 200);
    assert.equal(result.body.engine, 'breeze');
    assert.equal(result.body.ready, false);
    assert.equal(result.body.requirement, 'locked-reference');
    assert.deepEqual(result.body.missingRoles.map((role) => role.roleId), ['sunwukong', 'bajie']);
    const [wukong, bajie] = result.body.missingRoles;
    assert.deepEqual(wukong, { roleId: 'sunwukong', name: '孙悟空', lineCount: 1, hasVoiceDescription: true, voiceDescription: '少年男声，嗓音清亮急躁' });
    assert.equal(bajie.hasVoiceDescription, false);
    assert.equal((await api('/api/projects/nope/voice-readiness')).status, 404);
  });

  test('非 Breeze：按 voiceMap 判断；一键成片的 missingVoiceRoles 只算预设也分配不到的', () => {
    const state = getProject(projectId).state;
    const demo = voiceReadiness({ provider: 'demo' }, state);
    assert.equal(demo.requirement, 'voice-map');
    assert.deepEqual(demo.missingRoles.map((role) => role.roleId), ['tangseng', 'bajie']);
    assert.deepEqual(oneClickMissingVoiceRoles({ provider: 'demo' }, state), [], '演示引擎有预设音色，可自动选角');
    const breeze = oneClickMissingVoiceRoles({ provider: 'breeze' }, state);
    assert.deepEqual(breeze.map((role) => role.roleId), ['sunwukong', 'bajie']);
    assert.deepEqual(Object.keys(breeze[0]).sort(), ['hasVoiceDescription', 'lineCount', 'name', 'roleId', 'voiceDescription']);
  });

  test('Breeze 没有预设音色；生成音色表只含锁定参考音', () => {
    assert.equal(presetVoicesFor('breeze'), null);
    assert.deepEqual(generationVoiceMap({ provider: 'breeze' }, getProject(projectId).state), { tangseng: tangRef.breezeVoiceId });
    assert.deepEqual(generationVoiceMap({ provider: 'demo' }, getProject(projectId).state), { sunwukong: 'zh_male_demo_preset' });
  });

  test('一键成片管线：Breeze 缺参考音时在 音色 阶段以 VOICE_NOT_READY 停下，且不请求 Breeze', async () => {
    assert.equal(typeof runOneClickPipeline, 'function');
    const n = ttsRequests().length;
    const task = createPersistentTask({ kind: 'one-click', projectId, payload: {} });
    const config = await readConfig();
    await assert.rejects(runOneClickPipeline(task, config, {}), (error) => {
      assert.equal(error.code, 'VOICE_NOT_READY');
      assert.equal(error.status, 409);
      assert.deepEqual(error.details.missingVoiceRoles.map((role) => role.roleId), ['sunwukong', 'bajie']);
      return true;
    });
    assert.equal(ttsRequests().length, n);
  });
});

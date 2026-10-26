// 角色参考音（音色设计试听 → 锁定 / 上传 → 注册 Breeze → 生成解析 → 影响范围）。
// 全部打模拟 Breeze，不碰真实 Breeze / 豆包。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { startMockBreeze, toneWav } from './test-support/mock-breeze.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-ref-test-'));
process.env.HOME = scratch;
process.env.SHENGCHANG_RUNTIME_DIR = path.join(scratch, 'runtime');
const { writeConfig, readConfig } = await import('./config-store.js');
const { createProject, getProject, updateProject, getPersistentTask, audioContentHash } = await import('./database.js');
const { runtimePaths, ensureRuntime } = await import('./media-store.js');
const { registerBreezeRoutes } = await import('./breeze-routes.js');
const { runGenerationRequests, applyResultsToProject, estimateGeneration } = await import('./task-manager.js');
const { forgetRegisteredVoices, breezeVoiceIdFor, referenceFingerprint } = await import('./voice-references.js');
const { sweepStaleTakes } = await import('./voice-design.js');
const { buildGenerationRequests, buildGenerationRequest } = await import('../shared/generation-requests.mjs');
const express = (await import('express')).default;

let mock;
let server;
let base;
let projectId;

const characters = [
  { id: 'tangseng', name: '唐僧', role: '主角', description: '' },
  { id: 'sunwukong', name: '孙悟空', role: '主角', description: '' },
  { id: '白骨精', name: '白骨精', role: '反派', description: '' },
];
const scenes = [{ id: 's1', title: '白虎岭', lines: [
  { id: 'l1', type: 'dialogue', speakerId: 'tangseng', speaker: '唐僧', text: '徒弟，为师腹中饥饿。', emotion: '疲惫', intensity: 30, pace: 85 },
  { id: 'l2', type: 'dialogue', speakerId: 'sunwukong', speaker: '孙悟空', text: '师父稍等！', emotion: '急切', intensity: 60, pace: 105 },
  { id: 'l3', type: 'dialogue', speakerId: 'tangseng', speaker: '唐僧', text: '阿弥陀佛。', emotion: '平静', intensity: 30, pace: 90 },
] }];

async function waitForTask(id, timeoutMs = 10_000) {
  const started = Date.now();
  for (;;) {
    const task = getPersistentTask(id);
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;
    if (Date.now() - started > timeoutMs) throw new Error(`task ${id} still ${task.status}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const api = (pathname, init = {}) => fetch(`${base}${pathname}`, init).then(async (response) => ({ status: response.status, body: await response.json() }));
const postJson = (pathname, body) => api(pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const roleUrl = (roleId, suffix) => `/api/projects/${projectId}/roles/${encodeURIComponent(roleId)}${suffix}`;
function upload(roleId, { wav, transcript, filename = 'ref.wav', type = 'audio/wav' }) {
  const form = new FormData();
  if (wav) form.set('file', new Blob([wav], { type }), filename);
  if (transcript !== undefined) form.set('transcript', transcript);
  return api(roleUrl(roleId, '/voice-reference'), { method: 'POST', body: form });
}

before(async () => {
  await ensureRuntime();
  mock = await startMockBreeze();
  mock.state.voices.set('preset-tangseng', { id: 'preset-tangseng', transcript: 'x' });
  await writeConfig({ provider: 'breeze', breezeEndpoint: mock.endpoint });
  projectId = createProject({ name: '参考音测试', state: { scenes, characters, assets: [], voiceMap: { tangseng: 'preset-tangseng', sunwukong: 'preset-wukong' } } }).id;
  const app = express();
  app.use(express.json());
  registerBreezeRoutes(app);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await mock.close();
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => { mock.state.failNext = null; mock.state.hold = false; mock.state.delayMs = 0; mock.state.clipSeconds = 1.2; });

describe('音色设计试听', () => {
  test('立即返回 jobId；按顺序单飞生成 count × 测试台词段试听，事件带 takeId/audioUrl/seed/lineIndex', async () => {
    const before = mock.state.requests.length;
    mock.state.inFlightPeak = 0;
    const created = await postJson(roleUrl('tangseng', '/voice-design/takes'), { description: '青年男声，温和，带书卷气', testLines: ['阿弥陀佛。', '悟空，休得无礼！'], count: 3 });
    assert.equal(created.status, 202);
    assert.ok(created.body.jobId);
    assert.equal(created.body.jobId, created.body.taskId);
    const task = await waitForTask(created.body.jobId);
    assert.equal(task.status, 'completed', task.error);
    const takes = task.result.takes;
    assert.equal(takes.length, 6);
    for (const take of takes) {
      assert.match(take.takeId, /^[0-9a-f-]{36}-\d+$/);
      assert.match(take.audioUrl, /^\/media\/take-/);
      assert.ok(Number.isSafeInteger(take.seed));
      assert.ok([0, 1].includes(take.lineIndex));
      assert.ok(existsSync(path.join(runtimePaths.MEDIA_DIR, path.basename(take.audioUrl))));
    }
    // 同一候选两条台词同 seed；三个候选 seed 不同。
    const seedsByCandidate = [0, 1, 2].map((candidate) => [...new Set(takes.filter((take) => take.candidateIndex === candidate).map((take) => take.seed))]);
    assert.ok(seedsByCandidate.every((seeds) => seeds.length === 1));
    assert.equal(new Set(seedsByCandidate.flat()).size, 3);
    const sent = mock.state.requests.slice(before).filter((request) => request.path === '/voice_design');
    assert.equal(sent.length, 6);
    assert.equal(sent[0].body.instruction, '青年男声，温和，带书卷气');
    assert.equal(sent[1].body.text, '悟空，休得无礼！');
    assert.equal(mock.state.inFlightPeak, 1, '一次只有一个生成在飞');
    const types = task.result.events.map((event) => event.type);
    assert.deepEqual([types[0], types[1], types.at(-1)], ['queued', 'started', 'completed']);
    const takeEvents = task.result.events.filter((event) => event.type === 'take');
    assert.equal(takeEvents.length, 6);
    assert.ok(takeEvents.every((event) => 'queuePosition' in event && event.takeId && event.audioUrl && Number.isSafeInteger(event.seed) && Number.isInteger(event.lineIndex)));
  });

  test('参数校验：每个错误都给出 code 与 rule', async () => {
    const url = roleUrl('tangseng', '/voice-design/takes');
    const cases = [
      [{ description: '', testLines: ['a'] }, 'DESIGN_DESCRIPTION_REQUIRED'],
      [{ description: 'x'.repeat(501), testLines: ['a'] }, 'DESIGN_DESCRIPTION_TOO_LONG'],
      [{ description: 'x', testLines: [] }, 'DESIGN_TEST_LINES_REQUIRED'],
      [{ description: 'x', testLines: ['a', 42] }, 'DESIGN_TEST_LINE_INVALID'],
      [{ description: 'x', testLines: ['a'], count: 0 }, 'DESIGN_COUNT_INVALID'],
      [{ description: 'x', testLines: ['a'], count: 2.5 }, 'DESIGN_COUNT_INVALID'],
      [{ description: 'x', testLines: ['a', 'b', 'c', 'd'], count: 4 }, 'DESIGN_TOO_MANY_TAKES'],
    ];
    for (const [body, code] of cases) {
      const result = await postJson(url, body);
      assert.equal(result.status, 400, code);
      assert.equal(result.body.code, code);
      assert.ok(result.body.rule);
    }
    assert.equal((await postJson(roleUrl('nobody', '/voice-design/takes'), { description: 'x', testLines: ['a'] })).body.code, 'ROLE_NOT_FOUND');
    assert.equal((await api(`/api/projects/missing/roles/tangseng/voice-reference`)).status, 404);
  });

  test('相同参数的任务进行中时重复提交返回同一个 jobId（幂等）', async () => {
    mock.state.hold = true;
    const body = { description: '老年女声，苍老悲切', testLines: ['我的女儿啊……'], count: 2 };
    const first = await postJson(roleUrl('sunwukong', '/voice-design/takes'), body);
    const second = await postJson(roleUrl('sunwukong', '/voice-design/takes'), body);
    assert.equal(first.status, 202);
    assert.equal(second.status, 200);
    assert.equal(second.body.deduplicated, true);
    assert.equal(second.body.jobId, first.body.jobId);
    mock.state.hold = false;
    mock.release();
    for (let index = 0; index < 4; index += 1) { await new Promise((resolve) => setTimeout(resolve, 30)); mock.release(); }
    assert.equal((await waitForTask(first.body.jobId)).status, 'completed');
  });

  test('非 Breeze 引擎：409 ENGINE_NOT_BREEZE', async () => {
    await writeConfig({ ...(await readConfig()), provider: 'demo' });
    try {
      const result = await postJson(roleUrl('tangseng', '/voice-design/takes'), { description: 'x', testLines: ['a'] });
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'ENGINE_NOT_BREEZE');
    } finally { await writeConfig({ ...(await readConfig()), provider: 'breeze', breezeEndpoint: mock.endpoint }); }
  });

  test('超过 24 小时未锁定的试听文件会被清理', async () => {
    const name = `take-${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}-0.wav`;
    const file = path.join(runtimePaths.MEDIA_DIR, name);
    writeFileSync(file, toneWav(0.1));
    const old = (Date.now() - 25 * 3600 * 1000) / 1000;
    utimesSync(file, old, old);
    assert.ok((await sweepStaleTakes()) >= 1);
    assert.equal(existsSync(file), false);
  });
});

describe('锁定参考音', () => {
  let designTask;
  before(async () => {
    const created = await postJson(roleUrl('tangseng', '/voice-design/takes'), { description: '青年男声，慈悲', testLines: ['阿弥陀佛，善哉善哉。'], count: 2 });
    designTask = await waitForTask(created.body.jobId);
  });

  test('JSON { takeId }：转单声道 wav、注册 Breeze（{roleId}-{hash8}）、写入项目，重复锁定幂等', async () => {
    const take = designTask.result.takes[0];
    const locked = await postJson(roleUrl('tangseng', '/voice-reference'), { takeId: take.takeId });
    assert.equal(locked.status, 201, JSON.stringify(locked.body));
    assert.equal(locked.body.source, 'design');
    assert.match(locked.body.audioHash, /^[a-f0-9]{64}$/);
    assert.equal(locked.body.breezeVoiceId, `tangseng-${locked.body.audioHash.slice(0, 8)}`);
    const registered = mock.state.voices.get(locked.body.breezeVoiceId);
    assert.equal(registered.transcript, '阿弥陀佛，善哉善哉。');
    const stored = getProject(projectId).state.voiceReferences.tangseng;
    assert.equal(stored.version, 1);
    assert.equal(stored.seed, take.seed);
    assert.equal(stored.description, '青年男声，慈悲');
    const file = path.join(runtimePaths.MEDIA_DIR, path.basename(stored.audioUrl));
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=channels,sample_rate,codec_name', '-of', 'json', file]).toString()).streams[0];
    assert.deepEqual([probe.codec_name, probe.channels, Number(probe.sample_rate)], ['pcm_s16le', 1, 24000]);
    const again = await postJson(roleUrl('tangseng', '/voice-reference'), { takeId: take.takeId });
    assert.equal(again.status, 200);
    assert.equal(again.body.unchanged, true);
    assert.equal(again.body.referenceId, locked.body.referenceId);
    assert.equal(getProject(projectId).state.voiceReferences.tangseng.version, 1);
  });

  test('试听不属于该角色 / 不存在 / 伪造 id：404 TAKE_NOT_FOUND', async () => {
    const take = designTask.result.takes[0];
    for (const [role, takeId] of [['sunwukong', take.takeId], ['tangseng', `${designTask.id}-99`], ['tangseng', '../../etc/passwd'], ['tangseng', 'nope']]) {
      const result = await postJson(roleUrl(role, '/voice-reference'), { takeId });
      assert.equal(result.status, 404, takeId);
      assert.equal(result.body.code, 'TAKE_NOT_FOUND');
    }
    assert.equal((await postJson(roleUrl('tangseng', '/voice-reference'), {})).body.code, 'REFERENCE_INPUT_REQUIRED');
  });

  test('上传 multipart { file, transcript }：10–30 秒，转码后锁定，版本递增', async () => {
    const result = await upload('tangseng', { wav: toneWav(12, { sampleRate: 44100 }), transcript: '贫僧唐三藏，从东土大唐而来。' });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.source, 'upload');
    const stored = getProject(projectId).state.voiceReferences.tangseng;
    assert.equal(stored.version, 2);
    assert.equal(stored.transcript, '贫僧唐三藏，从东土大唐而来。');
    assert.ok(Math.abs(stored.durationMs - 12000) < 50);
    assert.ok(mock.state.voices.has(stored.breezeVoiceId));
  });

  test('上传校验：每条规则单独报错', async () => {
    const good = toneWav(12);
    const cases = [
      [{ wav: good, transcript: '   ' }, 400, 'REFERENCE_TRANSCRIPT_REQUIRED', 'transcript'],
      [{ wav: good }, 400, 'REFERENCE_TRANSCRIPT_REQUIRED', 'transcript'],
      [{ transcript: '有字没音频' }, 400, 'REFERENCE_FILE_REQUIRED', 'file'],
      [{ wav: toneWav(5), transcript: '太短' }, 400, 'REFERENCE_TOO_SHORT', 'duration'],
      [{ wav: toneWav(31), transcript: '太长' }, 400, 'REFERENCE_TOO_LONG', 'duration'],
      [{ wav: Buffer.from('definitely not audio'), transcript: '坏文件', filename: 'x.wav' }, 400, 'REFERENCE_UNREADABLE', 'decodable'],
      [{ wav: good, transcript: '类型不对', filename: 'notes.txt', type: 'text/plain' }, 415, 'REFERENCE_UNSUPPORTED_TYPE', 'type'],
      [{ wav: Buffer.alloc(22 * 1024 * 1024), transcript: '太大' }, 413, 'REFERENCE_TOO_LARGE', 'size'],
      [{ wav: good, transcript: '长'.repeat(501) }, 400, 'REFERENCE_TRANSCRIPT_TOO_LONG', 'transcript'],
    ];
    for (const [input, status, code, rule] of cases) {
      const result = await upload('sunwukong', input);
      assert.equal(result.status, status, `${code}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.code, code);
      assert.equal(result.body.rule, rule);
      assert.ok(result.body.error);
    }
    assert.equal(getProject(projectId).state.voiceReferences.sunwukong, undefined, '失败的上传不留下参考');
  });

  test('上传文件名里的路径穿越不起作用：文件按内容哈希命名、落在媒体目录', async () => {
    const result = await upload('sunwukong', { wav: toneWav(11), transcript: '俺老孙来也！', filename: '../../../escape.wav' });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(existsSync(path.join(scratch, 'escape.wav')), false);
    assert.equal(existsSync(path.join(runtimePaths.MEDIA_DIR, '..', 'escape.wav')), false);
    assert.equal(result.body.audioUrl, `/media/ref-${result.body.audioHash}.wav`);
    assert.ok(readdirSync(runtimePaths.MEDIA_DIR).includes(`ref-${result.body.audioHash}.wav`));
  });

  test('Breeze 不可达：503，项目里不留下锁了却用不了的参考', async () => {
    const before = getProject(projectId).state.voiceReferences;
    await writeConfig({ ...(await readConfig()), breezeEndpoint: 'http://127.0.0.1:9' });
    try {
      const result = await upload('白骨精', { wav: toneWav(12), transcript: '长老，可曾见我女儿？' });
      assert.equal(result.status, 503);
      assert.equal(result.body.code, 'BREEZE_UNREACHABLE');
      assert.deepEqual(getProject(projectId).state.voiceReferences, before);
    } finally { await writeConfig({ ...(await readConfig()), breezeEndpoint: mock.endpoint }); }
  });

  test('非 ASCII 角色 id 也得到安全的 Breeze voice id', () => {
    const id = breezeVoiceIdFor('白骨精', 'a'.repeat(64));
    assert.match(id, /^role-[a-f0-9]{8}-aaaaaaaa$/);
    assert.equal(breezeVoiceIdFor('tangseng', 'b'.repeat(64)), 'tangseng-bbbbbbbb');
  });

  test('指纹 = hash(音频 + 文本)：任一变化都变', () => {
    const wav = toneWav(1);
    assert.notEqual(referenceFingerprint(wav, '甲'), referenceFingerprint(wav, '乙'));
    assert.notEqual(referenceFingerprint(wav, '甲'), referenceFingerprint(toneWav(1, { frequency: 300 }), '甲'));
  });

  test('浏览器整份保存项目不能覆盖服务端的参考音', () => {
    const current = getProject(projectId);
    const { voiceReferences: _dropped, ...staleState } = current.state;
    updateProject(projectId, { state: { ...staleState, voiceReferences: { tangseng: { breezeVoiceId: 'forged' } } } });
    assert.deepEqual(getProject(projectId).state.voiceReferences, current.state.voiceReferences);
  });

  test('ASR 转写：501 ASR_NOT_IMPLEMENTED', async () => {
    const result = await postJson(roleUrl('tangseng', '/voice-reference/transcribe'), {});
    assert.equal(result.status, 501);
    assert.equal(result.body.code, 'ASR_NOT_IMPLEMENTED');
  });
});

describe('生成解析与影响范围', () => {
  test('参考音角色：/tts 用注册的 voice、参考指纹进缓存键；无参考角色缓存键不变', async () => {
    const config = await readConfig();
    const state = getProject(projectId).state;
    const reference = state.voiceReferences.tangseng;
    const requests = buildGenerationRequests(state);
    const before = mock.state.requests.length;
    const outcome = await runGenerationRequests(config, requests, { projectId, sceneId: 's1' });
    const tts = mock.state.requests.slice(before).filter((request) => request.path === '/tts');
    assert.deepEqual(tts.map((request) => request.body.voiceId).sort(), [reference.breezeVoiceId, reference.breezeVoiceId, 'sunwukong-' + state.voiceReferences.sunwukong.audioHash.slice(0, 8)].sort());
    assert.equal(outcome.failures.length, 0, JSON.stringify(outcome.failures));
    const l1 = outcome.results.find((result) => result.lineId === 'l1');
    const plain = buildGenerationRequest(scenes[0].lines[0], state.voiceMap);
    assert.notEqual(l1.contentHash, audioContentHash(config, plain));
    assert.equal(l1.contentHash, audioContentHash(config, { ...plain, voiceId: reference.breezeVoiceId, referenceHash: reference.audioHash }));
    assert.equal(audioContentHash(config, plain), audioContentHash(config, { ...plain, referenceHash: '', seed: undefined }), '没有参考/种子时键与旧版一致');
    assert.notEqual(audioContentHash(config, { ...plain, referenceHash: 'a'.repeat(64) }), audioContentHash(config, { ...plain, referenceHash: 'b'.repeat(64) }), '同一 voice id 下换参考文本/音频也必须换键');
    applyResultsToProject(projectId, 's1', outcome.results);
    assert.equal(await estimateGeneration(config, buildGenerationRequests(getProject(projectId).state, { needGeneration: () => true }), { projectId }), 3, '预估走同样的解析，全部命中缓存');
  });

  test('影响范围：只读；换参考音后列出该角色需要重新生成的台词', async () => {
    const impactUrl = roleUrl('tangseng', '/voice-reference/impact');
    const zero = await api(impactUrl);
    assert.deepEqual(zero.body, { affectedLineCount: 0, lineIds: [] });
    const result = await upload('tangseng', { wav: toneWav(15, { frequency: 330 }), transcript: '新的参考文本。' });
    assert.equal(result.status, 201);
    const requestsBefore = mock.state.requests.length;
    const snapshot = JSON.stringify(getProject(projectId).state.scenes);
    const impact = await api(impactUrl);
    assert.deepEqual(impact.body, { affectedLineCount: 2, lineIds: ['l1', 'l3'] });
    assert.equal(mock.state.requests.length, requestsBefore, '影响范围不调用 Breeze');
    assert.equal(JSON.stringify(getProject(projectId).state.scenes), snapshot, '影响范围不改项目');
    assert.deepEqual((await api(roleUrl('sunwukong', '/voice-reference/impact'))).body, { affectedLineCount: 0, lineIds: [] });
  });

  test('Breeze 重启丢了注册表：首次使用时自动补注册', async () => {
    const config = await readConfig();
    mock.state.voices.clear();
    forgetRegisteredVoices();
    const state = getProject(projectId).state;
    const request = { ...buildGenerationRequest({ ...scenes[0].lines[0], text: '补注册之后的新句子。' }, state.voiceMap), sceneId: 's1' };
    const outcome = await runGenerationRequests(config, [request], { projectId, sceneId: 's1' });
    assert.equal(outcome.failures.length, 0, JSON.stringify(outcome.failures));
    assert.ok(mock.state.voices.has(state.voiceReferences.tangseng.breezeVoiceId));
  });
});

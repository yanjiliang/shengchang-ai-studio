// 0020：GET /voices 三种返回形状、健康检查真的验 /voices、Breeze 地址去掉 /tts、
// 合成前 / Breeze 重启后的自动补注册。全部打模拟 Breeze。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { startMockBreeze, toneWav } from './test-support/mock-breeze.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-selfheal-test-'));
process.env.HOME = scratch;
process.env.SHENGCHANG_RUNTIME_DIR = path.join(scratch, 'runtime');
const { parseBreezeVoices, listBreezeVoices, breezeHealth, normalizeBreezeEndpoint, breezeCustomConfig } = await import('./breeze.js');
const { writeConfig, readConfig } = await import('./config-store.js');
const { createProject, getProject } = await import('./database.js');
const { ensureRuntime, runtimePaths } = await import('./media-store.js');
const { forgetRegisteredVoices } = await import('./voice-references.js');
const { runGenerationRequests, applyResultsToProject } = await import('./task-manager.js');

let mock;
let projectId;
const audioHash = 'b'.repeat(64);
const reference = { breezeVoiceId: 'ref-tang-bbbbbbbb', audioHash, audioUrl: `/media/ref-${audioHash}.wav`, transcript: '贫僧唐三藏', source: 'upload' };
const referencePath = () => path.join(runtimePaths.MEDIA_DIR, `ref-${audioHash}.wav`);
const config = () => ({ provider: 'breeze', breezeEndpoint: mock.endpoint });
const calls = (from) => mock.state.requests.slice(from).map((item) => `${item.method} ${item.path}`);
let counter = 0;
const request = () => ({ lineId: `l${++counter}`, sceneId: 's1', speakerId: 'tang', text: `第${counter}句台词。`, voiceId: '' });

before(async () => {
  await ensureRuntime();
  mock = await startMockBreeze();
  mkdirSync(runtimePaths.MEDIA_DIR, { recursive: true });
  writeFileSync(referencePath(), toneWav(6));
  projectId = createProject({ name: '自愈', state: { scenes: [], characters: [{ id: 'tang', name: '唐僧' }], voiceReferences: { tang: reference } } }).id;
});
after(async () => { await mock.close(); rmSync(scratch, { recursive: true, force: true }); });
beforeEach(() => { mock.state.voicesShape = 'object'; mock.state.failNext = null; });

describe('GET /voices 形状', () => {
  test('parseBreezeVoices：{id: transcript} / 数组 / {voices: []} 都认，别的返回 null', () => {
    assert.deepEqual(parseBreezeVoices({ a: '甲', b: '乙' }), [{ id: 'a', transcript: '甲' }, { id: 'b', transcript: '乙' }]);
    assert.deepEqual(parseBreezeVoices([{ id: 'a', transcript: '甲' }, 'b']), [{ id: 'a', transcript: '甲' }, { id: 'b', transcript: '' }]);
    assert.deepEqual(parseBreezeVoices({ voices: [{ id: 'a', transcript: '甲' }] }), [{ id: 'a', transcript: '甲' }]);
    assert.deepEqual(parseBreezeVoices({}), []);
    assert.equal(parseBreezeVoices('nope'), null);
    assert.equal(parseBreezeVoices(null), null);
    assert.equal(parseBreezeVoices({ a: 1 }), null);
  });
  for (const shape of ['object', 'array', 'wrapped']) {
    test(`listBreezeVoices 对模拟服务的 ${shape} 形状`, async () => {
      mock.state.voicesShape = shape;
      mock.state.voices.set('v-shape', { id: 'v-shape', transcript: '形状' });
      const voices = await listBreezeVoices(config());
      assert.deepEqual(voices.find((voice) => voice.id === 'v-shape'), { id: 'v-shape', transcript: '形状' });
      mock.state.voices.delete('v-shape');
    });
  }
});

describe('健康检查', () => {
  test('真 Breeze 形状 → status ok', async () => {
    const health = await breezeHealth(config());
    assert.equal(health.status, 'ok');
    assert.equal(health.reachable, true);
    assert.equal(health.error, '');
  });
  test('/voices 格式不认 → invalid，reachable=false', async () => {
    mock.state.voicesShape = 'garbage';
    const health = await breezeHealth(config());
    assert.equal(health.status, 'invalid');
    assert.equal(health.reachable, false);
    assert.match(health.error, /格式无法识别/);
  });
  test('/voices 报 500 → invalid', async () => {
    mock.state.failNext = { path: '/voices', method: 'GET', status: 500, text: 'boom' };
    const health = await breezeHealth(config());
    assert.equal(health.status, 'invalid');
    assert.equal(health.reachable, false);
  });
  test('连不上 → unreachable；地址无效 → misconfigured', async () => {
    assert.equal((await breezeHealth({ breezeEndpoint: 'http://127.0.0.1:1' })).status, 'unreachable');
    assert.equal((await breezeHealth({ breezeEndpoint: 'ftp://x' })).status, 'misconfigured');
  });
  test('填了 …/tts 的地址：健康检查打 /voices 而不是 /tts/voices', async () => {
    const before = mock.state.requests.length;
    const health = await breezeHealth({ breezeEndpoint: `${mock.endpoint}/tts/` });
    assert.equal(health.status, 'ok');
    assert.deepEqual(calls(before), ['GET /voices']);
  });
});

describe('Breeze 地址规范化', () => {
  test('去掉末尾 / 和 /tts', () => {
    assert.equal(normalizeBreezeEndpoint('http://127.0.0.1:4180/tts'), 'http://127.0.0.1:4180');
    assert.equal(normalizeBreezeEndpoint('http://127.0.0.1:4180/tts/'), 'http://127.0.0.1:4180');
    assert.equal(normalizeBreezeEndpoint('http://127.0.0.1:4180//'), 'http://127.0.0.1:4180');
    assert.equal(normalizeBreezeEndpoint('http://host/breeze/TTS'), 'http://host/breeze');
    assert.equal(normalizeBreezeEndpoint('http://host/ttsx'), 'http://host/ttsx');
    assert.equal(breezeCustomConfig({ breezeEndpoint: 'http://127.0.0.1:4180/tts' }).endpoint, 'http://127.0.0.1:4180/tts');
  });
  test('保存时就规范化，生成请求打 /tts 不打 /tts/tts', async () => {
    await writeConfig({ provider: 'breeze', breezeEndpoint: `${mock.endpoint}/tts` });
    assert.equal((await readConfig()).breezeEndpoint, mock.endpoint);
    const before = mock.state.requests.length;
    const outcome = await runGenerationRequests({ provider: 'breeze', breezeEndpoint: `${mock.endpoint}/tts` }, [{ ...request(), speakerId: 'nobody', voiceId: 'preset-x' }], { projectId, sceneId: 's1' });
    assert.equal(outcome.failures.length, 0, JSON.stringify(outcome.failures));
    // 本文件第一次生成、Breeze 通道空闲：先预检一次 GET /voices（0036），再 POST /tts。
    assert.deepEqual(calls(before), ['GET /voices', 'POST /tts']);
  });
});

describe('自动补注册', () => {
  test('声场重启后、Breeze 里没有这个 voice：合成前补注册再生成', async () => {
    mock.restart(); forgetRegisteredVoices();
    const before = mock.state.requests.length;
    const outcome = await runGenerationRequests(config(), [request()], { projectId, sceneId: 's1' });
    assert.equal(outcome.failures.length, 0, JSON.stringify(outcome.failures));
    assert.deepEqual(calls(before), ['GET /voices', 'POST /voices', 'POST /tts']);
    const registered = mock.state.requests.find((item, index) => index >= before && item.method === 'POST' && item.path === '/voices');
    assert.equal(registered.body.id, reference.breezeVoiceId);
    assert.equal(registered.body.transcript, reference.transcript);
    assert.ok(registered.body.wav_base64);
  });
  test('Breeze 重启（声场进程内以为已注册）：/tts 被拒 → 核对 /voices → 补注册 → 重试一次成功', async () => {
    await runGenerationRequests(config(), [request()], { projectId, sceneId: 's1' });
    mock.restart();
    const before = mock.state.requests.length;
    const outcome = await runGenerationRequests(config(), [request()], { projectId, sceneId: 's1' });
    assert.equal(outcome.failures.length, 0, JSON.stringify(outcome.failures));
    assert.deepEqual(calls(before), ['POST /tts', 'GET /voices', 'POST /voices', 'POST /tts']);
  });
  test('voice 在但 /tts 报 400：不补注册、不重试，原样报错', async () => {
    const before = mock.state.requests.length;
    mock.state.failNext = { path: '/tts', status: 400, text: 'text too long' };
    const outcome = await runGenerationRequests(config(), [request()], { projectId, sceneId: 's1' });
    assert.equal(outcome.failures.length, 1);
    assert.match(outcome.failures[0].error, /text too long/);
    assert.deepEqual(calls(before), ['POST /tts', 'GET /voices']);
  });
  test('补注册失败：清楚的错误（BREEZE_VOICE_REGISTER_FAILED），不发 /tts', async () => {
    mock.restart(); forgetRegisteredVoices();
    mock.state.failNext = { path: '/voices', method: 'POST', status: 500, text: 'disk full' };
    const before = mock.state.requests.length;
    const outcome = await runGenerationRequests(config(), [request()], { projectId, sceneId: 's1' });
    assert.equal(outcome.failures.length, 1);
    assert.equal(outcome.failures[0].code, 'BREEZE_VOICE_REGISTER_FAILED');
    assert.match(outcome.failures[0].error, /自动重新注册失败.*disk full/);
    assert.deepEqual(calls(before), ['GET /voices', 'POST /voices']);
  });
  test('本地参考音文件丢了：REFERENCE_FILE_MISSING，不发 /tts', async () => {
    mock.restart(); forgetRegisteredVoices();
    unlinkSync(referencePath());
    try {
      const outcome = await runGenerationRequests(config(), [request()], { projectId, sceneId: 's1' });
      assert.equal(outcome.failures[0].code, 'REFERENCE_FILE_MISSING');
      assert.ok(!mock.state.requests.slice(-2).some((item) => item.path === '/tts'));
    } finally { writeFileSync(referencePath(), toneWav(6)); }
  });
});

describe('实际 seed', () => {
  test('普通生成（不带 seed）记下 Breeze 返回的 X-Seed 为 renderSeed，audioSeed 仍为 null', async () => {
    const line = request();
    const withLine = createProject({ name: 'seed', state: { scenes: [{ id: 's1', title: '场', lines: [{ id: line.lineId, type: 'dialogue', speakerId: 'tang', speaker: '唐僧', text: line.text }] }], characters: [{ id: 'tang', name: '唐僧' }], voiceReferences: { tang: reference } } }).id;
    const outcome = await runGenerationRequests(config(), [line], { projectId: withLine, sceneId: 's1' });
    assert.equal(outcome.failures.length, 0, JSON.stringify(outcome.failures));
    const tts = mock.state.requests.filter((item) => item.path === '/tts').at(-1);
    assert.equal(tts.body.seed, undefined, '普通生成不应发 seed');
    assert.equal(outcome.results[0].seed, 42, '模拟 Breeze 默认 X-Seed: 42');
    applyResultsToProject(withLine, 's1', outcome.results);
    const saved = getProject(withLine).state.scenes[0].lines[0];
    assert.equal(saved.renderSeed, 42);
    assert.equal(saved.audioSeed, null);
  });
});

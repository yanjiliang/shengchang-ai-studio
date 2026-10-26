// 0036：Tavi 在真 Breeze 上发现的问题。全部打 127.0.0.1 的模拟 Breeze / 关掉的端口，
// 不碰任何真实服务。
// B 生成期间健康检查误报（GET /voices 被生成阻塞）→ 忙时不探测，via 'busy'。
// C Breeze 挂了：预检一次性失败 BREEZE_UNREACHABLE；运行中连接错误退避重试 2 次；仍不行就停掉剩下的句子。
// A ensureReferenceRegistered 并发时重复注册 → 同一 voice 合并成一次。
// 另：情绪强度 0、任务初始进度 0。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startMockBreeze, toneWav } from './test-support/mock-breeze.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-resilience-test-'));
process.env.HOME = scratch;
process.env.SHENGCHANG_RUNTIME_DIR = path.join(scratch, 'runtime');
const { breezeHealth, BreezeError, HEALTH_TIMEOUT_MS, HEALTH_BUSY_WINDOW_MS } = await import('./breeze.js');
const { createLane, laneFor } = await import('./breeze-lane.js');
const { writeConfig } = await import('./config-store.js');
const { createProject, createPersistentTask } = await import('./database.js');
const { ensureRuntime, runtimePaths } = await import('./media-store.js');
const { ensureReferenceRegistered, forgetRegisteredVoices } = await import('./voice-references.js');
const { runGenerationRequests, enqueueGeneration, getTask, waitForTaskToSettle } = await import('./task-manager.js');
const { breezeInstruction, voiceInstructions } = await import('./model-adapters.js');
const { buildGenerationRequest } = await import('../shared/generation-requests.mjs');

const DEAD = 'http://127.0.0.1:1';
let mock;
let projectId;
const audioHash = 'c'.repeat(64);
const reference = { breezeVoiceId: 'ref-sunwukong-cccccccc', audioHash, audioUrl: `/media/ref-${audioHash}.wav`, transcript: '俺老孙来也', source: 'upload' };
let counter = 0;
const line = (extra = {}) => ({ lineId: `r${++counter}`, sceneId: 's1', speakerId: 'nobody', text: `韧性测试第${counter}句。`, voiceId: 'preset-x', ...extra });
const wavAudio = () => ({ buffer: toneWav(0.2), mime: 'audio/wav' });
const unreachable = () => new BreezeError('无法连接 Breeze（模拟 ECONNREFUSED）', { status: 503, code: 'BREEZE_UNREACHABLE' });
const reachable = async () => ({ status: 'ok', reachable: true, via: 'probe' });
const calls = (from) => mock.state.requests.slice(from).map((item) => `${item.method} ${item.path}`);

before(async () => {
  await ensureRuntime();
  mock = await startMockBreeze();
  mkdirSync(runtimePaths.MEDIA_DIR, { recursive: true });
  writeFileSync(path.join(runtimePaths.MEDIA_DIR, `ref-${audioHash}.wav`), toneWav(6));
  projectId = createProject({ name: '韧性', state: { scenes: [], characters: [{ id: 'sunwukong', name: '孙悟空' }], voiceReferences: { sunwukong: reference } } }).id;
});
after(async () => { await mock.close(); rmSync(scratch, { recursive: true, force: true }); });

// 这两个用例必须在本文件任何一次成功生成之前跑：通道空闲 → 真的预检。
describe('C 预检：Breeze 不在时整个任务一次失败', () => {
  test('连不上 → status unreachable / BREEZE_UNREACHABLE，一句都不发', async () => {
    let synthCalls = 0;
    const requests = [line(), line(), line()];
    const outcome = await runGenerationRequests({ provider: 'breeze', breezeEndpoint: DEAD }, requests, {
      projectId, sceneId: 's1', retryDelaysMs: [0, 0], synthesize: async () => { synthCalls += 1; return wavAudio(); },
    });
    assert.equal(outcome.status, 'unreachable');
    assert.equal(outcome.code, 'BREEZE_UNREACHABLE');
    assert.equal(outcome.causeCode, 'BREEZE_UNREACHABLE');
    assert.equal(outcome.skippedCount, 3);
    assert.deepEqual(outcome.skippedLineIds, requests.map((item) => item.lineId));
    assert.deepEqual(outcome.failures, [], '不逐句记 ECONNREFUSED');
    assert.equal(synthCalls, 0);
  });

  test('任务层：整场生成任务 failed 一次，result.code = BREEZE_UNREACHABLE，初始进度 0', async () => {
    await writeConfig({ provider: 'breeze', breezeEndpoint: DEAD });
    const task = enqueueGeneration({ kind: 'scene', projectId, sceneId: 's1', requests: [line(), line()] });
    assert.equal(task.progress, 0, '刚提交的任务进度从 0 开始');
    const settled = await waitForTaskToSettle(task.id, 15_000);
    assert.equal(settled.status, 'failed');
    assert.equal(settled.result.code, 'BREEZE_UNREACHABLE');
    assert.equal(settled.result.skippedCount, 2);
    assert.deepEqual(settled.result.failures, []);
    assert.match(settled.error, /Breeze 服务连不上/);
  });
});

describe('C 运行中连接错误：退避重试，仍不行就停', () => {
  test('前两次连不上、第三次成功 → 正常完成', async () => {
    let attempts = 0;
    const outcome = await runGenerationRequests({ provider: 'breeze', breezeEndpoint: DEAD }, [line()], {
      projectId, sceneId: 's1', retryDelaysMs: [0, 0], preflight: reachable,
      synthesize: async () => { attempts += 1; if (attempts <= 2) throw unreachable(); return wavAudio(); },
    });
    assert.equal(outcome.status, 'done');
    assert.equal(outcome.results.length, 1);
    assert.equal(attempts, 3);
  });

  test('重试 2 次后仍连不上 → 停掉剩下的句子（不再逐句失败）', async () => {
    let attempts = 0;
    const requests = [line(), line(), line(), line()];
    const outcome = await runGenerationRequests({ provider: 'breeze', breezeEndpoint: DEAD }, requests, {
      projectId, sceneId: 's1', retryDelaysMs: [0, 0], preflight: reachable,
      synthesize: async () => { attempts += 1; if (attempts === 1) return wavAudio(); throw unreachable(); },
    });
    assert.equal(outcome.status, 'unreachable');
    assert.equal(outcome.results.length, 1, '第一句成功的保留');
    assert.equal(outcome.skippedCount, 3);
    assert.deepEqual(outcome.skippedLineIds, requests.slice(1).map((item) => item.lineId));
    assert.equal(attempts, 1 + 3, '第二句 1 次 + 重试 2 次，后面的句子不再尝试');
    assert.deepEqual(outcome.failures, []);
  });

  test('超时也算连接类失败：重试后成功', async () => {
    let attempts = 0;
    const outcome = await runGenerationRequests({ provider: 'breeze', breezeEndpoint: DEAD }, [line()], {
      projectId, sceneId: 's1', retryDelaysMs: [0, 0], preflight: reachable,
      synthesize: async () => { attempts += 1; if (attempts === 1) throw new BreezeError('超时', { status: 504, code: 'BREEZE_TIMEOUT' }); return wavAudio(); },
    });
    assert.equal(outcome.status, 'done');
    assert.equal(attempts, 2);
  });

  test('非连接类错误（Breeze 500）不重试，仍逐句失败、任务继续', async () => {
    let attempts = 0;
    const outcome = await runGenerationRequests({ provider: 'breeze', breezeEndpoint: DEAD }, [line(), line()], {
      projectId, sceneId: 's1', retryDelaysMs: [0, 0], preflight: reachable,
      synthesize: async () => { attempts += 1; if (attempts === 1) throw new BreezeError('CUDA OOM', { code: 'BREEZE_UPSTREAM' }); return wavAudio(); },
    });
    assert.equal(outcome.status, 'done');
    assert.equal(outcome.failures.length, 1);
    assert.equal(outcome.failures[0].code, 'BREEZE_UPSTREAM');
    assert.equal(outcome.results.length, 1);
    assert.equal(attempts, 2);
  });

  test('退避等待期间取消立即生效 → cancelled', async () => {
    let cancelled = false;
    setTimeout(() => { cancelled = true; }, 50);
    const started = Date.now();
    const outcome = await runGenerationRequests({ provider: 'breeze', breezeEndpoint: DEAD }, [line(), line()], {
      projectId, sceneId: 's1', retryDelaysMs: [10_000, 10_000], preflight: reachable, shouldCancel: () => cancelled,
      synthesize: async () => { throw unreachable(); },
    });
    assert.equal(outcome.status, 'cancelled');
    assert.ok(Date.now() - started < 2_000, '不等完 10 秒退避');
  });

  test('真实连接被重置（模拟 Breeze 断开 socket）→ 映射为连接错误并重试成功', async () => {
    mock.state.resetNext = 1;
    const before = mock.state.requests.length;
    const outcome = await runGenerationRequests({ provider: 'breeze', breezeEndpoint: mock.endpoint }, [line()], { projectId, sceneId: 's1', retryDelaysMs: [0, 0], preflight: reachable });
    assert.equal(outcome.status, 'done', JSON.stringify(outcome.failures));
    assert.equal(outcome.results.length, 1);
    assert.deepEqual(calls(before), ['POST /tts', 'POST /tts']);
  });
});

describe('B 健康检查：生成期间不误报', () => {
  test('探测超时放宽到 10 秒，忙窗口 30 秒', () => {
    assert.equal(HEALTH_TIMEOUT_MS, 10_000);
    assert.equal(HEALTH_BUSY_WINDOW_MS, 30_000);
  });

  test('通道 activity：在飞数与最近成功时间', async () => {
    const lane = createLane({ concurrency: 1 });
    assert.deepEqual(lane.activity(), { inFlight: 0, lastSuccessAt: null });
    let finish;
    const running = lane.run({ jobId: 'j', fn: () => new Promise((resolve) => { finish = resolve; }) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lane.activity().inFlight, 1);
    finish('ok');
    await running;
    await new Promise((resolve) => setImmediate(resolve)); // 在飞项在 resolve 之后的 finally 里移出
    const { inFlight, lastSuccessAt } = lane.activity();
    assert.equal(inFlight, 0);
    assert.ok(Number.isFinite(lastSuccessAt));
    await assert.rejects(lane.run({ jobId: 'j', fn: async () => { throw new Error('x'); } }));
    assert.equal(lane.activity().lastSuccessAt, lastSuccessAt, '失败不刷新 lastSuccessAt');
  });

  test('有在飞请求 → via busy，不探测（地址连不上也报可达）', async () => {
    const health = await breezeHealth({ breezeEndpoint: DEAD }, { lane: { activity: () => ({ inFlight: 1, lastSuccessAt: null }) } });
    assert.equal(health.status, 'ok');
    assert.equal(health.reachable, true);
    assert.equal(health.via, 'busy');
    assert.equal(health.latencyMs, null);
    assert.equal(health.voiceCount, null);
    assert.equal(health.inFlightCount, 1);
  });

  test('30 秒内刚成功过 → busy；超过 30 秒 → 真的探测', async () => {
    const now = 1_000_000;
    const recent = await breezeHealth({ breezeEndpoint: DEAD }, { now, lane: { activity: () => ({ inFlight: 0, lastSuccessAt: now - 29_000 }) } });
    assert.equal(recent.via, 'busy');
    const stale = await breezeHealth({ breezeEndpoint: DEAD }, { now, lane: { activity: () => ({ inFlight: 0, lastSuccessAt: now - 31_000 }) } });
    assert.equal(stale.via, 'probe');
    assert.equal(stale.status, 'unreachable');
    assert.equal(stale.reachable, false);
  });

  test('空闲 → via probe，带音色数和延迟；地址无效 → via config', async () => {
    const health = await breezeHealth({ breezeEndpoint: mock.endpoint }, { lane: createLane() });
    assert.equal(health.via, 'probe');
    assert.equal(health.status, 'ok');
    assert.ok(Number.isFinite(health.latencyMs));
    assert.ok(Number.isFinite(health.voiceCount));
    const bad = await breezeHealth({ breezeEndpoint: 'ftp://x' });
    assert.equal(bad.status, 'misconfigured');
    assert.equal(bad.via, 'config');
  });

  test('复现：Breeze 生成中 GET /voices 被阻塞——旧做法探测超时误报，新做法 busy 且不打 /voices', async () => {
    mock.state.voicesBlockWhileGenerating = true;
    mock.state.hold = true;
    const config = { provider: 'breeze', breezeEndpoint: mock.endpoint };
    try {
      const generating = runGenerationRequests(config, [line()], { projectId, sceneId: 's1', preflight: reachable });
      for (let waited = 0; mock.state.inFlight === 0 && waited < 3_000; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(mock.state.inFlight, 1);
      const probed = await breezeHealth(config, { lane: createLane(), timeoutMs: 200 });
      assert.equal(probed.status, 'timeout', '忙时探测必然超时（这就是 Tavi 看到的误报）');
      const before = mock.state.requests.length;
      const health = await breezeHealth(config, { lane: laneFor('breeze', config) });
      assert.equal(health.via, 'busy');
      assert.equal(health.reachable, true);
      assert.deepEqual(calls(before), [], 'busy 时不发 GET /voices');
      mock.release();
      assert.equal((await generating).status, 'done');
    } finally {
      mock.state.hold = false; mock.release(); mock.state.voicesBlockWhileGenerating = false;
    }
  });
});

describe('A 参考音注册并发合并', () => {
  const config = () => ({ provider: 'breeze', breezeEndpoint: mock.endpoint });
  test('同一 voice 并发两次 → 只 GET /voices 一次、POST /voices 一次', async () => {
    mock.restart(); forgetRegisteredVoices();
    const before = mock.state.requests.length;
    const [first, second] = await Promise.all([ensureReferenceRegistered(config(), reference), ensureReferenceRegistered(config(), reference)]);
    assert.deepEqual(first, { registered: true });
    assert.deepEqual(second, { registered: true });
    assert.deepEqual(calls(before), ['GET /voices', 'POST /voices']);
  });

  test('两个任务同时用同一参考（Tavi 的 sunwukong 1 ms 两次 POST）→ 只注册一次', async () => {
    mock.restart(); forgetRegisteredVoices();
    const before = mock.state.requests.length;
    const speaking = () => runGenerationRequests(config(), [line({ speakerId: 'sunwukong', voiceId: '' })], { projectId, sceneId: 's1', preflight: reachable });
    const outcomes = await Promise.all([speaking(), speaking()]);
    for (const outcome of outcomes) assert.equal(outcome.failures.length, 0, JSON.stringify(outcome.failures));
    assert.equal(calls(before).filter((call) => call === 'POST /voices').length, 1);
  });

  test('失败不缓存：注册失败时并发的调用一起失败，下一次重新注册', async () => {
    mock.restart(); forgetRegisteredVoices();
    mock.state.failNext = { path: '/voices', method: 'POST', status: 500, text: 'disk full' };
    const before = mock.state.requests.length;
    const settled = await Promise.allSettled([ensureReferenceRegistered(config(), reference), ensureReferenceRegistered(config(), reference)]);
    assert.ok(settled.every((item) => item.status === 'rejected' && item.reason.code === 'BREEZE_VOICE_REGISTER_FAILED'));
    assert.equal(calls(before).filter((call) => call === 'POST /voices').length, 1);
    assert.deepEqual(await ensureReferenceRegistered(config(), reference), { registered: true });
    assert.equal(calls(before).filter((call) => call === 'POST /voices').length, 2);
  });

  test('注册时连不上：原样抛 BREEZE_UNREACHABLE（供退避重试 / 判定挂了）', async () => {
    forgetRegisteredVoices();
    await assert.rejects(ensureReferenceRegistered({ provider: 'breeze', breezeEndpoint: DEAD }, reference), (error) => error.code === 'BREEZE_UNREACHABLE');
  });
});

describe('情绪强度 0 与任务初始进度', () => {
  test('buildGenerationRequest：强度 0 → 0.1（不再变成 0.4），缺省 → 0.4；语速 0 / 缺省 → 0.9', () => {
    assert.equal(buildGenerationRequest({ id: 'a', intensity: 0 }, {}).emotionScale, 0.1);
    assert.equal(buildGenerationRequest({ id: 'a' }, {}).emotionScale, 0.4);
    assert.equal(buildGenerationRequest({ id: 'a', intensity: null }, {}).emotionScale, 0.4);
    assert.equal(buildGenerationRequest({ id: 'a', intensity: 100 }, {}).emotionScale, 1);
    assert.equal(buildGenerationRequest({ id: 'a', intensity: 60 }, {}).emotionScale, 0.6);
    assert.equal(buildGenerationRequest({ id: 'a' }, {}).speed, 0.9);
    assert.equal(buildGenerationRequest({ id: 'a', pace: 0 }, {}).speed, 0.9);
    assert.equal(buildGenerationRequest({ id: 'a', pace: 110 }, {}).speed, 1.1);
  });

  test('指令构建：emotionScale 0 夹到 0.1（略带一点），缺省仍按 0.4（比较）', () => {
    assert.match(breezeInstruction({ emotion: '愤怒', emotionScale: 0 }), /^用略带一点愤怒的语气说/);
    assert.match(breezeInstruction({ emotion: '愤怒' }), /^用比较愤怒的语气说/);
    assert.match(voiceInstructions({ emotion: '愤怒', emotionScale: 0 })[0], /^用略带一点愤怒的语气说/);
    assert.match(voiceInstructions({ emotion: '愤怒' })[0], /^用比较愤怒的语气说/);
  });

  test('新建任务 progress = 0', () => {
    assert.equal(createPersistentTask({ kind: 'scene', projectId, payload: {} }).progress, 0);
    assert.equal(getTask(createPersistentTask({ kind: 'line', projectId, payload: {} }).id).progress, 0);
  });
});

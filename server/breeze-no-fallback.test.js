// 0037：Breeze 停机时的产品规则与续跑契约。全部打 127.0.0.1（模拟 Breeze / 模拟“豆包”与自定义端点 /
// 关掉的端口），并且包了一层 fetch：任何发往非 127.0.0.1 的请求都会被拦下并让用例失败。
// 1 绝不自动从 Breeze 回落到豆包 / 自定义（付费）引擎：Breeze 挂了，这两个端点收到 0 个请求，任务以 BREEZE_UNREACHABLE 结束。
// 2 BREEZE_UNREACHABLE 结果带 completedLineCount / remainingLineCount（保留 skippedCount）。
// 3 续跑 = 重新提交：Breeze 在第 N 句后挂掉、再恢复，重跑只渲染剩下的 M 句，已完成的句子不再请求 /tts。
// 6 运行中 BREEZE_TIMEOUT：重试前先 10 秒探一次，探不通直接停。
// 另（0038）：情绪强度 0 = 不要情绪，只对 Breeze——情绪那句和潜台词都不写、只留语速，什么都不剩发 instruction ""。
// 豆包的指令 / context_texts / 缓存键与 0036（a936049）逐字相同（硬编码金标准见“豆包不变”）。
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startMockBreeze, toneWav } from './test-support/mock-breeze.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-no-fallback-test-'));
process.env.HOME = scratch;
process.env.SHENGCHANG_RUNTIME_DIR = path.join(scratch, 'runtime');

// 外部请求守卫：只放行 127.0.0.1。
const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
  outbound.push(url.href);
  if (url.hostname !== '127.0.0.1') throw new Error(`测试禁止访问外部主机：${url.href}`);
  return realFetch(input, init);
};

const { BreezeError } = await import('./breeze.js');
const { readConfig, writeConfig } = await import('./config-store.js');
const { createProject, createPersistentTask, getProject, getPersistentTask } = await import('./database.js');
const { ensureRuntime, runtimePaths } = await import('./media-store.js');
const { forgetRegisteredVoices } = await import('./voice-references.js');
const { runGenerationRequests, enqueueGeneration, enqueueLineTake, enqueueOneClick, enqueueVoiceDesign, retryTask, waitForTaskToSettle } = await import('./task-manager.js');
const { runOneClickPipeline } = await import('./one-click.js');
const { breezeInstruction, voiceInstructions } = await import('./model-adapters.js');
const { audioContentHash } = await import('./database.js');
const { buildGenerationRequest } = await import('../shared/generation-requests.mjs');
const { TTS_UI_PRESETS, VOLCENGINE_DEFAULT_ENDPOINT } = await import('../shared/tts-presets.mjs');
const ttsProviders = await import('./tts-providers.js');

const DEAD = 'http://127.0.0.1:1';
const audioHash = 'd'.repeat(64);
const reference = (id) => ({ breezeVoiceId: `ref-${id}-dddddddd`, audioHash, audioUrl: `/media/ref-${audioHash}.wav`, transcript: '参考音', source: 'upload', lockedAt: 1 });
const characters = [{ id: 'tangseng', name: '唐僧' }, { id: 'wukong', name: '孙悟空' }];
const dialogue = (id, speakerId, text, extra = {}) => ({ id, type: 'dialogue', speakerId, speaker: speakerId, text, emotion: '平静', intensity: 40, pace: 100, ...extra });

// 计数用的“豆包”/“自定义”端点：收到任何请求都记下来并回 500。
async function startCounter() {
  const hits = [];
  const server = http.createServer((request, response) => { hits.push(`${request.method} ${request.url}`); request.resume(); response.writeHead(500); response.end('should never be called'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { endpoint: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }) };
}

let doubao;
let custom;
before(async () => {
  await ensureRuntime();
  mkdirSync(runtimePaths.MEDIA_DIR, { recursive: true });
  writeFileSync(path.join(runtimePaths.MEDIA_DIR, `ref-${audioHash}.wav`), toneWav(6));
  doubao = await startCounter();
  custom = await startCounter();
});
after(async () => {
  globalThis.fetch = realFetch;
  await doubao.close(); await custom.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('1 Breeze 挂了绝不回落到豆包 / 自定义引擎', () => {
  let projectId;
  before(async () => {
    // 其他引擎的槽都配好了地址和 Key（真要回落的话条件齐全），项目里也有豆包预设音色映射。
    await writeConfig({
      provider: 'breeze', breezeEndpoint: DEAD,
      ttsProviders: {
        'volcengine-api-key': { endpoint: doubao.endpoint, accessKey: 'doubao-test-key', resourceId: 'seed-tts-2.0' },
        custom: { endpoint: custom.endpoint, accessKey: 'custom-test-key' },
      },
    });
    projectId = createProject({ name: '不回落', state: {
      characters,
      voiceMap: { tangseng: 'zh_male_m191_uranus_bigtts', wukong: 'zh_male_taocheng_uranus_bigtts' },
      voiceReferences: { tangseng: reference('tangseng'), wukong: reference('wukong') },
      scenes: [{ id: 's1', title: '一', lines: [dialogue('f1', 'tangseng', '悟空，回来。'), dialogue('f2', 'wukong', '师父，俺在。'), dialogue('f3', 'tangseng', '莫要胡闹。')] }],
    } }).id;
  });

  test('一键成片 / 整场生成 / 单句试听 / 方向实验 / 音色设计：全部 BREEZE_UNREACHABLE，豆包与自定义端点 0 请求', async () => {
    const config = await readConfig();
    assert.equal(config.provider, 'breeze');
    assert.equal(config.ttsProviders['volcengine-api-key'].endpoint, doubao.endpoint, '豆包槽确实指向计数端点');

    const oneClick = await waitForTaskToSettle(enqueueOneClick({ projectId }).id, 15_000);
    assert.equal(oneClick.status, 'failed');
    assert.equal(oneClick.result.code, 'BREEZE_UNREACHABLE');
    assert.equal(oneClick.result.completedLineCount, 0);
    assert.equal(oneClick.result.remainingLineCount, 3);
    assert.equal(oneClick.result.skippedCount, 3);

    const requests = getProject(projectId).state.scenes[0].lines.map((line) => ({ ...buildGenerationRequest(line, {}), voiceId: `ref-${line.speakerId}-dddddddd`, sceneId: 's1' }));
    const scene = await waitForTaskToSettle(enqueueGeneration({ kind: 'scene', projectId, sceneId: 's1', requests }).id, 15_000);
    assert.equal(scene.status, 'failed');
    assert.equal(scene.result.code, 'BREEZE_UNREACHABLE');
    assert.equal(scene.result.completedLineCount, 0, '预检失败：0 / 总数');
    assert.equal(scene.result.remainingLineCount, 3);
    assert.equal(scene.result.skippedCount, 3);

    const lab = await waitForTaskToSettle(enqueueGeneration({ kind: 'direction-lab', projectId, sceneId: 's1', requests: requests.slice(0, 1) }).id, 15_000);
    assert.equal(lab.status, 'failed');
    assert.equal(lab.result.code, 'BREEZE_UNREACHABLE');

    const take = await waitForTaskToSettle(enqueueLineTake(config, { lineId: 'f1', projectId, seed: 7 }).task.id, 15_000);
    assert.equal(take.status, 'failed');
    const failed = take.result.events.find((event) => event.type === 'failed');
    assert.equal(failed.code, 'BREEZE_UNREACHABLE');
    assert.equal(failed.completedLineCount, 0);
    assert.equal(failed.remainingLineCount, 1);

    const design = await waitForTaskToSettle(enqueueVoiceDesign(config, { projectId, roleId: 'tangseng', body: { description: '中年男声，温和', testLines: ['阿弥陀佛。'], count: 1 } }).task.id, 15_000);
    assert.equal(design.status, 'failed');

    // 重试同样不换引擎。
    const retried = await waitForTaskToSettle(retryTask(scene.id).id, 15_000);
    assert.equal(retried.result.code, 'BREEZE_UNREACHABLE');

    assert.deepEqual(doubao.hits, [], '豆包端点 0 请求');
    assert.deepEqual(custom.hits, [], '自定义端点 0 请求');
    assert.deepEqual(outbound.filter((url) => !url.startsWith(DEAD)), [], '除了探 / 打关掉的 Breeze 端口，没有任何 HTTP 请求');
    assert.ok(outbound.length > 0, '确实试过 Breeze');
    const after = await readConfig();
    assert.equal(after.provider, 'breeze', '配置里的引擎没被改');
    assert.equal(after.breezeEndpoint, DEAD);
  });
});

describe('6 运行中 BREEZE_TIMEOUT：重试前先 10 秒探一次', () => {
  const line = (id) => ({ lineId: id, sceneId: 's1', speakerId: 'x', text: `超时${id}。`, voiceId: 'preset-x' });
  const timeoutError = () => new BreezeError('Breeze 请求超时（模拟）', { status: 504, code: 'BREEZE_TIMEOUT' });
  const wav = () => ({ buffer: toneWav(0.2), mime: 'audio/wav' });
  let projectId;
  before(() => { projectId = createProject({ name: '超时', state: { scenes: [], characters: [] } }).id; });

  test('探不通 → 不再等重试，立即停：BREEZE_UNREACHABLE / causeCode BREEZE_TIMEOUT；探测用 lane: null（强制探）', async () => {
    const probes = [];
    let synthCalls = 0;
    const started = Date.now();
    const outcome = await runGenerationRequests({ provider: 'breeze', breezeEndpoint: DEAD }, [line('t1'), line('t2')], {
      projectId, sceneId: 's1', retryDelaysMs: [5_000, 5_000],
      preflight: async (config, options) => { probes.push(options.lane === null ? 'forced' : 'lazy'); return probes.length === 1 ? { status: 'ok', reachable: true } : { status: 'timeout', reachable: false }; },
      synthesize: async () => { synthCalls += 1; throw timeoutError(); },
    });
    assert.ok(Date.now() - started < 2_000, '没有等 5 秒重试间隔');
    assert.deepEqual(probes, ['lazy', 'forced']);
    assert.equal(synthCalls, 1, '探不通就不重试');
    assert.equal(outcome.status, 'unreachable');
    assert.equal(outcome.code, 'BREEZE_UNREACHABLE');
    assert.equal(outcome.causeCode, 'BREEZE_TIMEOUT');
    assert.equal(outcome.completedLineCount, 0);
    assert.equal(outcome.remainingLineCount, 2);
    assert.equal(outcome.skippedCount, 2);
  });

  test('探得通 → 照常退避重试，成功就继续', async () => {
    const probes = [];
    let attempts = 0;
    const outcome = await runGenerationRequests({ provider: 'breeze', breezeEndpoint: DEAD }, [line('t3')], {
      projectId, sceneId: 's1', retryDelaysMs: [0, 0],
      preflight: async (config, options) => { probes.push(options.lane === null ? 'forced' : 'lazy'); return { status: 'ok', reachable: true }; },
      synthesize: async () => { attempts += 1; if (attempts === 1) throw timeoutError(); return wav(); },
    });
    assert.equal(outcome.status, 'done');
    assert.equal(attempts, 2);
    assert.deepEqual(probes, ['lazy', 'forced']);
  });

  test('连不上 / 被重置（BREEZE_UNREACHABLE）不额外探测，照旧重试', async () => {
    const probes = [];
    let attempts = 0;
    const outcome = await runGenerationRequests({ provider: 'breeze', breezeEndpoint: DEAD }, [line('t4')], {
      projectId, sceneId: 's1', retryDelaysMs: [0, 0],
      preflight: async (config, options) => { probes.push(options.lane === null ? 'forced' : 'lazy'); return { status: 'ok', reachable: true }; },
      synthesize: async () => { attempts += 1; if (attempts < 3) throw new BreezeError('ECONNRESET（模拟）', { status: 503, code: 'BREEZE_UNREACHABLE' }); return wav(); },
    });
    assert.equal(outcome.status, 'done');
    assert.equal(attempts, 3);
    assert.deepEqual(probes, ['lazy']);
  });
});

describe('3 续跑 = 重新提交：Breeze 第 N 句后挂掉再恢复，重跑只渲染剩下的', () => {
  let mock;
  let projectId;
  const N = 2;
  const TOTAL = 5;
  before(async () => {
    mock = await startMockBreeze();
    await writeConfig({ provider: 'breeze', breezeEndpoint: mock.endpoint });
    forgetRegisteredVoices();
    const lines = Array.from({ length: TOTAL }, (_, index) => dialogue(`c${index + 1}`, index % 2 ? 'wukong' : 'tangseng', `续跑第${index + 1}句。`));
    projectId = createProject({ name: '续跑', state: {
      characters, voiceMap: {}, voiceReferences: { tangseng: reference('tangseng'), wukong: reference('wukong') },
      scenes: [{ id: 's1', title: '一', lines: lines.slice(0, 3) }, { id: 's2', title: '二', lines: lines.slice(3) }],
    } }).id;
  });
  after(async () => { await mock.close(); });

  const run = async () => {
    const task = createPersistentTask({ kind: 'one-click', projectId, payload: { completedStages: ['拆解', '音色'] } });
    const deps = {
      runGeneration: (config, requests, options) => runGenerationRequests(config, requests, { ...options, retryDelaysMs: [5, 5] }),
      exportTimeline: async () => ({ url: '/media/fake.wav', name: 'fake', sceneCount: 2, durationMs: 1 }),
    };
    try { await runOneClickPipeline(task, await readConfig(), deps); return { task: getPersistentTask(task.id) }; } catch (error) { return { error }; }
  };
  const ttsLineTexts = (from) => mock.state.requests.slice(from).filter((item) => item.path === '/tts').map((item) => item.body.text);

  test(`第一次：成功 ${N} 句后挂掉 → BREEZE_UNREACHABLE，completed ${N} / remaining ${TOTAL - N}，已完成的写进项目`, async () => {
    mock.state.dieAfter = N;
    const { error } = await run();
    assert.ok(error, '一键成片应当失败');
    assert.equal(error.code, 'BREEZE_UNREACHABLE');
    assert.equal(error.details.completedLineCount, N);
    assert.equal(error.details.remainingLineCount, TOTAL - N);
    assert.equal(error.details.skippedCount, TOTAL - N);
    assert.equal(mock.state.generated, N);
    const lines = getProject(projectId).state.scenes.flatMap((scene) => scene.lines);
    assert.deepEqual(lines.filter((line) => line.audioUrl).map((line) => line.id), ['c1', 'c2']);
  });

  test(`Breeze 恢复（进程重启、注册表清空）→ 重新提交只请求剩下的 ${TOTAL - N} 句 /tts`, async () => {
    mock.state.down = false;
    mock.restart();
    const from = mock.state.requests.length;
    const { task, error } = await run();
    assert.equal(error, undefined, error?.message);
    assert.equal(task.status, 'completed');
    const texts = ttsLineTexts(from);
    // 重启后注册表是空的：每个角色第一次 /tts 回 400 unknown voiceId → 自愈重注册 → 同一句再发一次。
    // 所以按“哪几句被请求过”断言，而不是 /tts 次数。
    assert.deepEqual([...new Set(texts)], ['续跑第3句。', '续跑第4句。', '续跑第5句。']);
    assert.equal(mock.state.generated - N, TOTAL - N, '真正生成出音频的正好是剩下的句数');
    assert.ok(!texts.includes('续跑第1句。') && !texts.includes('续跑第2句。'), '已完成的句子不再请求 /tts');
    assert.equal(task.result.freshCount, TOTAL - N);
    assert.ok(getProject(projectId).state.scenes.flatMap((scene) => scene.lines).every((line) => line.audioUrl));
  });
});

describe('情绪强度 0 = 不要情绪（只对 Breeze）', () => {
  const request = (extra) => buildGenerationRequest({ id: 'z', text: '嗯。', emotion: '愤怒', intensity: 0, pace: 100, ...extra }, {});

  test('Breeze 金标准：强度 0 只留语速那句；语速正常 → ""；潜台词（情绪来由）也不写', () => {
    assert.equal(breezeInstruction(request({ pace: 90 })), '语速稍慢、从容。');
    assert.equal(breezeInstruction(request({ pace: 110 })), '语速加快，说得紧凑一些。');
    assert.equal(breezeInstruction(request({})), '');
    assert.equal(breezeInstruction(request({ subtext: '被冤枉' })), '');
    assert.equal(breezeInstruction(request({ pace: 90, subtext: '被冤枉' })), '语速稍慢、从容。');
    assert.equal(breezeInstruction(request({ intensity: '0' })), '', '字符串 "0" 也是 0');
    // 1–100 不变：1 → 夹到 0.1（略带一点），潜台词照写。
    assert.equal(breezeInstruction(request({ intensity: 1 })), '用略带一点愤怒的语气说。');
    assert.equal(breezeInstruction(request({ intensity: 1, subtext: '被冤枉' })), '用略带一点愤怒的语气说，这句话的情绪来由是：被冤枉。');
    assert.equal(breezeInstruction(request({ intensity: 40 })), '用比较愤怒的语气说。');
    assert.equal(breezeInstruction(request({ intensity: 100, pace: 90 })), '用特别特别愤怒的语气说，语速稍慢、从容。');
    assert.equal(breezeInstruction(request({ intensity: undefined })), '用比较愤怒的语气说。', '缺省仍按 40');
    assert.equal(breezeInstruction(request({ intensity: '' })), '用比较愤怒的语气说。', '空仍按 40');
    // 只有台词构建出的 emotionOff 标记才算“不要情绪”；直接传 emotionScale 0（方向实验等）照旧夹到 0.1。
    assert.equal(breezeInstruction({ emotion: '愤怒', emotionScale: 0 }), '用略带一点愤怒的语气说。');
  });

  test('请求：强度 0 → emotionScale 仍是 0.1（与 0036 相同）+ emotionOff 标记；1–100 / 缺省不带标记', () => {
    assert.equal(request({}).emotionScale, 0.1);
    assert.equal(request({}).emotionOff, true);
    assert.equal(request({ intensity: '0' }).emotionOff, true);
    for (const intensity of [1, 40, 100, '', undefined, null, 'abc']) assert.equal('emotionOff' in request({ intensity }), false, `intensity ${intensity}`);
  });

  test('Breeze 缓存键：强度 0 与强度 1 不同键（旧缓存里的强度 0 Breeze 句会失效重渲）', () => {
    const config = { provider: 'breeze', breezeEndpoint: 'http://127.0.0.1:8000', audioFormat: 'wav', sampleRate: 24000 };
    const zero = { ...request({ intensity: 0 }), voiceId: 'ref-a' };
    const one = { ...request({ intensity: 1 }), voiceId: 'ref-a' };
    assert.equal(zero.emotionScale, one.emotionScale);
    assert.notEqual(audioContentHash(config, zero), audioContentHash(config, one));
  });

  test('对模拟 Breeze：强度 0、正常语速、有潜台词 → 发 instruction: ""（纯克隆）', async () => {
    const mock = await startMockBreeze();
    try {
      mock.state.voices.set('ref-x', { id: 'ref-x', transcript: 'x' });
      await writeConfig({ provider: 'breeze', breezeEndpoint: mock.endpoint });
      const pid = createProject({ name: '零', state: { scenes: [], characters: [] } }).id;
      const req = { ...buildGenerationRequest({ id: 'z0', text: '纯克隆。', emotion: '愤怒', subtext: '被冤枉', intensity: 0, pace: 100 }, {}), voiceId: 'ref-x', sceneId: 's1' };
      const outcome = await runGenerationRequests(await readConfig(), [req], { projectId: pid, sceneId: 's1' });
      assert.equal(outcome.status, 'done');
      const sent = mock.state.requests.filter((item) => item.path === '/tts').at(-1).body;
      assert.equal(sent.instruction, '');
      assert.equal(sent.emotionScale, 0.1);
    } finally { await mock.close(); }
  });
});

// 0038：豆包这一轮一个字都不能变。下面的期望值是在 a936049（0036）上实跑得到后硬编码的：
// 指令（context_texts）、发出去的请求体、audioContentHash。
describe('豆包不变：与 a936049 逐字相同（硬编码）', () => {
  const voiceMap = { a: 'zh_male_m191_uranus_bigtts' };
  const line = (intensity) => ({ id: 'g1', speakerId: 'a', text: '徒弟，为师腹中饥饿。', subtext: '旅途劳顿', emotion: '疲惫', pace: 85, distance: '近讲', intensity });
  const tail = '的语气说，语速放慢，句间多停顿一下，这句话的情绪来由是：旅途劳顿，保持当前基础音色稳定。';
  const golden = {
    0: { emotionScale: 0.1, instruction: `用略带一点疲惫${tail}`, hash: '7fdb20d086619984f444b7a36529e0dde3eba582fc6b2ec38375a57a7216a521' },
    1: { emotionScale: 0.1, instruction: `用略带一点疲惫${tail}`, hash: '7fdb20d086619984f444b7a36529e0dde3eba582fc6b2ec38375a57a7216a521' },
    40: { emotionScale: 0.4, instruction: `用比较疲惫${tail}`, hash: '441d9d26897908b3ba3c1c2741d32a8a49f74ae1439a598232a39b8d7e8a3e2a' },
    100: { emotionScale: 1, instruction: `用特别特别疲惫${tail}`, hash: '35804bf501aa5ad153082a92e2cdf79b490688e513240d5ba7d2b0a8adca4dc9' },
    '': { emotionScale: 0.4, instruction: `用比较疲惫${tail}`, hash: '441d9d26897908b3ba3c1c2741d32a8a49f74ae1439a598232a39b8d7e8a3e2a' },
  };
  const hashConfig = { provider: 'volcengine-api-key', endpoint: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', model: '', resourceId: 'seed-tts-2.0', audioFormat: 'mp3', sampleRate: 24000, ttsStableSpeaker: true };

  test('指令与 audioContentHash：强度 0 / 1 / 40 / 100 / 空', () => {
    for (const [intensity, expected] of Object.entries(golden)) {
      const value = intensity === '' ? '' : Number(intensity);
      const req = buildGenerationRequest(line(value), voiceMap);
      assert.equal(req.emotionScale, expected.emotionScale, `intensity ${JSON.stringify(value)}`);
      assert.deepEqual(voiceInstructions(req, { stableSpeaker: true }), [expected.instruction], `intensity ${JSON.stringify(value)}`);
      assert.equal(audioContentHash(hashConfig, req), expected.hash, `intensity ${JSON.stringify(value)}`);
    }
    // 没填 / null 与空相同。
    assert.equal(audioContentHash(hashConfig, buildGenerationRequest(line(undefined), voiceMap)), golden[''].hash);
    assert.equal(audioContentHash(hashConfig, buildGenerationRequest(line(null), voiceMap)), golden[''].hash);
  });

  test('发到（模拟）豆包的请求体：强度 0 / 1 / 40 / 100 / 空', async () => {
    const bodies = [];
    const server = http.createServer((req, res) => { let body = ''; req.on('data', (chunk) => { body += chunk; }); req.on('end', () => { bodies.push(body); res.writeHead(500); res.end('x'); }); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { synthesize } = await import('./model-adapters.js');
      const config = { ...hashConfig, endpoint: `http://127.0.0.1:${server.address().port}/tts`, accessKey: 'k' };
      for (const [intensity, expected] of Object.entries(golden)) {
        const value = intensity === '' ? '' : Number(intensity);
        await assert.rejects(synthesize(config, buildGenerationRequest(line(value), voiceMap)));
        const additions = JSON.stringify({ disable_markdown_filter: true, context_texts: [expected.instruction] });
        const body = `{"req_params":{"text":"徒弟，为师腹中饥饿。","speaker":"zh_male_m191_uranus_bigtts","audio_params":{"format":"mp3","sample_rate":24000,"speech_rate":-15},"additions":${JSON.stringify(additions)}}}`;
        assert.equal(bodies.at(-1), body, `intensity ${JSON.stringify(value)}`);
      }
    } finally { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
  });
});

describe('4 TTS_UI_PRESETS 搬到 shared/tts-presets.mjs', () => {
  test('服务端再导出的就是同一个对象，内容不变', () => {
    assert.equal(ttsProviders.TTS_UI_PRESETS, TTS_UI_PRESETS);
    assert.equal(ttsProviders.VOLCENGINE_DEFAULT_ENDPOINT, VOLCENGINE_DEFAULT_ENDPOINT);
    assert.deepEqual(Object.keys(TTS_UI_PRESETS), ['demo', 'volcengine-api-key', 'custom', 'breeze']);
    assert.equal(TTS_UI_PRESETS['volcengine-api-key'].endpoint, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
  });
});


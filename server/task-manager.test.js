import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

// Same pattern as database.test.js: point the runtime at a scratch directory
// before importing anything that resolves media-store paths.
const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-task-test-'));
process.env.SHENGCHANG_RUNTIME_DIR = scratch;
const { createProject, getProject } = await import('./database.js');
const { applyResultsToProject, recoverCachedAudioFromDisk, runGenerationRequests } = await import('./task-manager.js');

after(() => rmSync(scratch, { recursive: true, force: true }));

const stateWith = (lines) => ({ scenes: [{ id: 'scene-1', title: '测试场景', lines }], assets: [], characters: [] });
const staleLine = (id, text) => ({ id, type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text, audioUrl: '/media/old.wav', audioMime: 'audio/wav', audioStale: true });
const plainLine = (id, text) => ({ id, type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text });
const resultFor = (lineId, text, url = '/media/new.wav') => ({ lineId, sceneId: 'scene-1', url, mime: 'audio/wav', text, synthesizedText: text, contentHash: 'hash-1', createdAt: 123 });

describe('生成结果写回项目', () => {
  test('重新生成后清除过期标记并记录合成文本', () => {
    const project = createProject({ name: '写回测试', state: stateWith([staleLine('l1', '当前台词')]) });

    applyResultsToProject(project.id, 'scene-1', [resultFor('l1', '当前台词')]);

    const line = getProject(project.id).state.scenes[0].lines[0];
    assert.equal(line.audioUrl, '/media/new.wav');
    assert.equal(line.audioStale, false, '音频与台词一致时不应保留过期标记');
    assert.equal(line.synthesizedText, '当前台词');
  });

  test('生成期间被改过的台词保持过期标记', () => {
    const project = createProject({ name: '竞争测试', state: stateWith([staleLine('l1', '生成期间又改了的台词')]) });

    applyResultsToProject(project.id, 'scene-1', [resultFor('l1', '任务提交时的台词')]);

    const line = getProject(project.id).state.scenes[0].lines[0];
    assert.equal(line.audioUrl, '/media/new.wav', '新音频仍应写入');
    assert.equal(line.audioStale, true, '音频对应的是旧文本，必须保持过期');
  });

  test('未被任务覆盖的台词保持原样', () => {
    const project = createProject({ name: '保留测试', state: stateWith([staleLine('l1', '第一句'), staleLine('l2', '第二句')]) });

    applyResultsToProject(project.id, 'scene-1', [resultFor('l1', '第一句')]);

    const lines = getProject(project.id).state.scenes[0].lines;
    assert.equal(lines[1].audioUrl, '/media/old.wav');
    assert.equal(lines[1].audioStale, true);
  });

  test('全部对白有音频后场景才标为 ready', () => {
    const project = createProject({ name: '状态测试', state: stateWith([plainLine('l1', '第一句'), plainLine('l2', '第二句')]) });

    applyResultsToProject(project.id, 'scene-1', [resultFor('l1', '第一句')]);
    assert.notEqual(getProject(project.id).state.scenes[0].status, 'ready', '仍有对白缺音频时不应标为 ready');

    applyResultsToProject(project.id, 'scene-1', [resultFor('l2', '第二句')]);
    assert.equal(getProject(project.id).state.scenes[0].status, 'ready');
  });
});

describe('runGenerationRequests 逐句容错', () => {
  const okAudio = { mime: 'audio/wav', buffer: Buffer.from('RIFF-payload') };
  const requestFor = (lineId, text) => ({ lineId, sceneId: 'scene-1', voiceId: 'v', text });

  test('单句失败不中断整批，失败句记录原因', async () => {
    const project = createProject({ name: '容错测试', state: stateWith([]) });
    const failingSynth = async (_config, request) => {
      if (request.text.includes('坏句')) throw new Error('合成失败');
      return okAudio;
    };
    const outcome = await runGenerationRequests({ provider: 'demo' }, [
      requestFor('a', '第一句'), requestFor('b', '包含坏句的台词'), requestFor('c', '第三句'),
    ], { projectId: project.id, synthesize: failingSynth });
    assert.equal(outcome.status, 'done');
    assert.deepEqual(outcome.results.map((item) => item.lineId), ['a', 'c'], '失败句之后的句子必须继续生成');
    assert.equal(outcome.failures.length, 1);
    assert.equal(outcome.failures[0].lineId, 'b');
    assert.match(outcome.failures[0].error, /合成失败/);
  });

  test('AbortError 报告为超时而不是原始名称', async () => {
    const project = createProject({ name: '超时测试', state: stateWith([]) });
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const outcome = await runGenerationRequests({ provider: 'demo' }, [requestFor('a', '会超时的一句')], {
      projectId: project.id,
      synthesize: async () => { throw abortError; },
    });
    assert.equal(outcome.failures[0].error, '模型请求超时');
  });

  test('取消后立即停止并保留已完成的结果', async () => {
    const project = createProject({ name: '取消测试', state: stateWith([]) });
    const outcome = await runGenerationRequests({ provider: 'demo' }, [requestFor('a', '第一句'), requestFor('b', '第二句')], {
      projectId: project.id,
      shouldCancel: () => true,
      synthesize: async () => okAudio,
    });
    assert.equal(outcome.status, 'cancelled');
    assert.equal(outcome.results.length, 0, '取消后不应继续合成');
  });

  test('发音词典在合成前生效', async () => {
    const project = createProject({ name: '词典测试', state: { scenes: [], assets: [], characters: [], pronunciationDictionary: [{ id: 'd1', term: '重庆', replacement: '重 庆' }] } });
    const seen = [];
    await runGenerationRequests({ provider: 'demo' }, [requestFor('a', '去了重庆。')], {
      projectId: project.id,
      synthesize: async (_config, request) => { seen.push(request.text); return okAudio; },
    });
    assert.deepEqual(seen, ['去了重 庆。']);
  });
});

describe('音频缓存磁盘恢复', () => {
  test('缓存行被清理后仍能从磁盘找回文件', async () => {
    mkdirSync(path.join(scratch, 'media'), { recursive: true });
    writeFileSync(path.join(scratch, 'media', 'deadbeef.wav'), Buffer.from('RIFF'));

    const recovered = await recoverCachedAudioFromDisk('deadbeef');
    assert.deepEqual(recovered, { url: '/media/deadbeef.wav', mime: 'audio/wav' });
  });

  test('磁盘上不存在时返回 null', async () => {
    assert.equal(await recoverCachedAudioFromDisk('not-on-disk'), null);
  });
});

// 0005 复现：Tavi 的 xiyouji v3 一共 19 句、390 字，记录到的计费字数只有 198，
// 原始响应日志也只有 11 条。19 句里按角色整组切分、恰好 11 句 198 字的组合只有一种：
// 唐僧/孙悟空/青衣少女/老翁。Tavi 的逐句诊断（v3diag）已确认：19 句都用了正确的 voiceId，
// 11 句新请求 = 198 字；8 句是有效缓存命中——旁白×4、八戒×3 来自 v2（音色未变），
// 老妪 l09（popo）来自更早一个示例项目的同一句音频（v2 里老妪其实是 m191、popo 给了老翁）。
// 下面的“先前渲染”把这些来源合并成一次，只为得到同一组缓存条目。
// 命中不发请求、不计费——所以 198 是真实计费，390 只是全量字数。
describe('计费汇总：缓存命中不计费，缺 usage 单独计数', () => {
  test('西游记示例：先前渲染留下 旁白/八戒/老妪 的缓存，v3 只请求 11 句、计费 198', async () => {
    const { buildSampleState } = await import('./sample-project.js');
    const { buildGenerationRequests } = await import('../shared/generation-requests.mjs');
    const { summarizeBilling } = await import('./task-manager.js');
    const config = { provider: 'volcengine-api-key', resourceId: 'seed-tts-2.0', audioFormat: 'mp3', sampleRate: 24000 };
    const v2Voices = { // 先前渲染的合并视图（不是 v2 的真实 voiceMap）
      narrator: 'zh_female_cancan_uranus_bigtts', tangseng: 'zh_female_vv_uranus_bigtts', sunwukong: 'zh_male_ruyayichen_uranus_bigtts', zhubajie: 'zh_male_qingcang_uranus_bigtts', shaonv: 'zh_female_gufengshaoyu_uranus_bigtts', laoyu: 'zh_female_popo_uranus_bigtts', laoweng: 'zh_male_m191_uranus_bigtts' };
    const v3Voices = { ...v2Voices, tangseng: 'zh_male_yangguangqingnian_uranus_bigtts', sunwukong: 'zh_male_ruyaqingnian_uranus_bigtts', shaonv: 'zh_female_vv_uranus_bigtts', laoweng: 'zh_male_ruyayichen_uranus_bigtts' };
    const sample = buildSampleState();
    const project = createProject({ name: '计费复现', state: { ...sample, voiceMap: v2Voices } });
    let calls = 0;
    const synth = async (_config, request) => { calls += 1; return { mime: 'audio/mpeg', buffer: Buffer.from(`${request.voiceId}:${request.text}`), usage: { text_words: [...request.text].length, billedCharacters: [...request.text].length } }; };
    const v2 = await runGenerationRequests(config, buildGenerationRequests({ ...sample, voiceMap: v2Voices }), { projectId: project.id, synthesize: synth });
    assert.deepEqual([calls, summarizeBilling(v2.results).billedCharacters], [19, 390]);
    calls = 0;
    const v3 = await runGenerationRequests(config, buildGenerationRequests({ ...sample, voiceMap: v3Voices }), { projectId: project.id, synthesize: synth });
    const summary = summarizeBilling(v3.results);
    assert.equal(calls, 11);
    assert.deepEqual(summary, { billedCharacters: 198, freshCount: 11, cacheHits: 8, missingUsageCount: 0 });
    const requested = new Set(v3.results.filter((item) => !item.cached).map((item) => item.lineId));
    assert.deepEqual([...requested].sort(), ['sd-l02', 'sd-l03', 'sd-l04', 'sd-l06', 'sd-l07', 'sd-l11', 'sd-l12', 'sd-l13', 'sd-l15', 'sd-l17', 'sd-l19']);
  });

  test('新生成但没返回 usage 的句子计入 missingUsageCount，不当成 0', async () => {
    const { summarizeBilling } = await import('./task-manager.js');
    const summary = summarizeBilling([
      { cached: false, usageExpected: true, usage: { billedCharacters: 10 } },
      { cached: false, usageExpected: true, usage: null },
      { cached: true },
      { cached: false, usageExpected: false, usage: null },
    ]);
    assert.deepEqual(summary, { billedCharacters: 10, freshCount: 3, cacheHits: 1, missingUsageCount: 1 });
  });
});

describe('音频缓存键与命中记录（0005）', () => {
  test('seed-tts-2.0：指令逻辑版本 / 稳定说话人开关进入缓存键；demo 键不变', async () => {
    const { audioContentHash } = await import('./database.js');
    const request = { voiceId: 'zh_female_vv_uranus_bigtts', text: '你好。', emotion: '悲伤', emotionScale: 0.5, speed: 1 };
    const tts2 = { provider: 'volcengine-api-key', resourceId: 'seed-tts-2.0', audioFormat: 'mp3', sampleRate: 24000 };
    assert.notEqual(audioContentHash(tts2, request), audioContentHash({ ...tts2, ttsStableSpeaker: false }, request));
    assert.equal(audioContentHash(tts2, request), audioContentHash({ ...tts2, ttsStableSpeaker: true }, request), '默认开启');
    assert.notEqual(audioContentHash(tts2, request), audioContentHash(tts2, { ...request, voiceId: 'zh_male_ruyaqingnian_uranus_bigtts' }));
    const demo = { provider: 'demo' };
    assert.equal(audioContentHash(demo, request), audioContentHash({ ...demo, ttsStableSpeaker: false }, request));
  });

  test('命中缓存不改 created_at，只更新 last_used_at；命中句不计费', async () => {
    const { findCachedAudio } = await import('./database.js');
    const project = createProject({ name: '命中记录', state: stateWith([]) });
    const config = { provider: 'volcengine-api-key', resourceId: 'seed-tts-2.0', audioFormat: 'mp3', sampleRate: 24000 };
    const request = { lineId: 'a', sceneId: 'scene-1', voiceId: 'zh_female_vv_uranus_bigtts', text: '命中记录测试句。' };
    let calls = 0;
    const synth = async () => { calls += 1; return { mime: 'audio/mpeg', buffer: Buffer.from('mp3'), usage: { billedCharacters: 8 } }; };
    const first = await runGenerationRequests(config, [request], { projectId: project.id, synthesize: synth });
    const hash = first.results[0].contentHash;
    const before = findCachedAudio(hash);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await runGenerationRequests(config, [request], { projectId: project.id, synthesize: synth });
    const after = findCachedAudio(hash);
    assert.equal(calls, 1);
    assert.equal(second.results[0].cached, true);
    assert.equal(after.created_at, before.created_at);
    assert.ok(after.last_used_at >= before.created_at);
  });
});

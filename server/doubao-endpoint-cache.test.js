// 0044：0041 把旧 byte-v3 配置的豆包地址从 '' 改成官方地址，endpoint 进缓存键——会不会让
// 0041 之前用 '' 渲染的句子全部判过期、重渲染（白花豆包额度）？不会：'' 从来渲染不出音频。
// - synthesize() 先调 validateProviderConfig()，`if (!config.endpoint) throw '请填写接口地址'`
//   （8cb0a4d server/model-adapters.js:432 / :440；677f831 起每个版本都有），
//   synthesizeVolcengineApiKey 里 `config.endpoint || 官方地址`（:261）的兜底走不到。
// - 所以 '' 键下没有任何缓存 / 媒体文件，不需要也不应该把 '' 和官方地址归一成同一个键。
// 本文件把这一点钉住：'' 的豆包配置一次网络请求都不发、不写缓存；各引擎缓存键（8cb0a4d 上算的）不变。
// 只访问 127.0.0.1：fetch 守卫拒绝一切外部主机并记录。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-doubao-endpoint-cache-test-'));
process.env.HOME = scratch;
process.env.SHENGCHANG_RUNTIME_DIR = path.join(scratch, 'runtime');

const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = async (input, init) => {
  const href = typeof input === 'string' ? input : input.url ?? String(input);
  outbound.push(href);
  if (new URL(href).hostname !== '127.0.0.1') throw new Error(`测试禁止访问外部主机：${href}`);
  return realFetch(input, init);
};

const { sanitizeConfig } = await import('./config-store.js');
const { audioContentHash, createProject, listAudioCache } = await import('./database.js');
const { ensureRuntime } = await import('./media-store.js');
const { synthesize } = await import('./model-adapters.js');
const { runGenerationRequests } = await import('./task-manager.js');
const { buildGenerationRequest, buildGenerationRequests } = await import('../shared/generation-requests.mjs');

after(() => {
  globalThis.fetch = realFetch;
  rmSync(scratch, { recursive: true, force: true });
});

const VOLC_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
// 0035 之前真实形状的 byte-v3 平铺配置，没有 endpoint（假 Key）。
const OLD_BYTE_V3_NO_ENDPOINT = { provider: 'byte-v3', accessKey: 'FAKE-byte-v3-key-0000000000-abc', resourceId: 'seed-tts-2.0', model: '', audioFormat: 'mp3', sampleRate: 24000, responseMode: 'auto', customHeaders: '{}', cacheLimitGb: 50, breezeEndpoint: 'http://127.0.0.1:4181', ttsStableSpeaker: true, llmEndpoint: 'http://127.0.0.1:9/v1', llmApiKey: 'FAKE-llm-key-1111111111-def', llmModel: '', sfxProvider: 'demo' };
// 0041 之前（d6e0ad8..8cb0a4d）这份配置迁移后的样子：豆包槽 endpoint = ''。
const pre0041 = () => {
  const migrated = sanitizeConfig(OLD_BYTE_V3_NO_ENDPOINT);
  return { ...migrated, endpoint: '', ttsProviders: { ...migrated.ttsProviders, 'volcengine-api-key': { ...migrated.ttsProviders['volcengine-api-key'], endpoint: '' } } };
};
const STATE = {
  characters: [{ id: 'tangseng', name: '唐僧', role: '角色', description: '' }],
  voiceMap: { tangseng: 'zh_male_m191_uranus_bigtts' },
  pronunciationDictionary: [], assets: [],
  scenes: [{ id: 's1', title: '化斋', status: 'pending', lines: [
    { id: 'l1', type: 'dialogue', speaker: '唐僧', speakerId: 'tangseng', text: '徒弟，为师腹中饥饿。', emotion: '疲惫', pace: 85, intensity: 40 },
    { id: 'l2', type: 'dialogue', speaker: '唐僧', speakerId: 'tangseng', text: '速去速回。', pace: 100 },
  ] }],
};

describe('豆包 endpoint \'\'：渲染不出音频，所以不存在 \'\' 键的旧缓存', () => {
  test('synthesize：\'\' / 缺省地址在发请求之前就被拒（请填写接口地址），一次 fetch 都没有', async () => {
    const config = pre0041();
    assert.equal(config.provider, 'volcengine-api-key');
    const before = outbound.length;
    for (const endpoint of ['', undefined]) {
      await assert.rejects(synthesize({ ...config, endpoint }, { text: '你好。', voiceId: 'zh_male_m191_uranus_bigtts' }), /请填写接口地址/);
    }
    assert.equal(outbound.length - before, 0);
  });

  test('整场生成（0041 之前的配置）：每句失败、0 次请求、缓存表 / 台词都没有写入', async () => {
    await ensureRuntime();
    const project = createProject({ name: '0041 之前', state: STATE });
    const before = outbound.length;
    const outcome = await runGenerationRequests(pre0041(), buildGenerationRequests(STATE), { projectId: project.id, sceneId: 's1' });
    assert.equal(outcome.status, 'done');
    assert.equal(outcome.results.length, 0);
    assert.deepEqual(outcome.failures.map((item) => item.error), ['请填写接口地址', '请填写接口地址']);
    assert.equal(outbound.length - before, 0, '没有发出任何请求');
    assert.equal(listAudioCache().length, 0, '没有缓存行');
  });

  test('0041 迁移后同一份配置得到官方地址（才第一次能渲染）', () => {
    const config = sanitizeConfig(OLD_BYTE_V3_NO_ENDPOINT);
    assert.equal(config.endpoint, VOLC_URL);
    assert.equal(config.ttsProviders['volcengine-api-key'].endpoint, VOLC_URL);
  });
});

// 缓存键没有改：数值都是在 8cb0a4d（0041 之前）的代码上算出来的。
describe('缓存键与 0041 之前逐字节相同', () => {
  const base = { model: '', resourceId: 'seed-tts-2.0', audioFormat: 'mp3', sampleRate: 24000, ttsStableSpeaker: true };
  const line = { id: 'g1', speakerId: 'a', text: '徒弟，为师腹中饥饿。', subtext: '旅途劳顿', emotion: '疲惫', pace: 85, distance: '近讲', intensity: 40 };
  const request = buildGenerationRequest(line, { a: 'zh_male_m191_uranus_bigtts' });
  const cases = [
    ['豆包 官方地址（d6e0ad8 golden）', { ...base, provider: 'volcengine-api-key', endpoint: VOLC_URL }, '441d9d26897908b3ba3c1c2741d32a8a49f74ae1439a598232a39b8d7e8a3e2a'],
    ['豆包 自建代理', { ...base, provider: 'volcengine-api-key', endpoint: 'http://127.0.0.1:4190/api/v3/tts/unidirectional' }, '4bed5cd3a582225c6030c547df73b884f47929cf0d52c4e6451de227dbe44b1c'],
    ['自定义 127.0.0.1', { provider: 'custom', endpoint: 'http://127.0.0.1:9/tts', model: 'm', resourceId: '', audioFormat: 'wav', sampleRate: 24000 }, '76ad414dd8686b4662df8a1f348b03a2def8558eba8431887c80875b41a5a369'],
    ['Breeze', { provider: 'breeze', endpoint: '', breezeEndpoint: 'http://127.0.0.1:4181', audioFormat: 'wav', sampleRate: 24000 }, '0ebffa84b1ac7afe7d67a68f740765203f86534516b58b05bf352c137dc126b9'],
  ];
  for (const [name, config, expected] of cases) test(name, () => assert.equal(audioContentHash(config, request), expected));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { breezeEstimateText, breezeGenerationSeconds, breezePreset, engineOf, formatSecondsRange, lineCostText, needsCredential, normalizeBreezeStatus, normalizeBreezeBase, breezeBaseHint, showsBilling, showsDirectable, llmKeyRequired, breezeBaseOf } from './engine.js';

test('engineOf：豆包 / 演示 / 自定义 / Breeze（原生预设或 custom 接本地服务）', () => {
  assert.equal(engineOf({ provider: 'volcengine-api-key' }), 'doubao');
  assert.equal(engineOf({ provider: 'demo' }), 'demo');
  assert.equal(engineOf({ provider: 'custom', endpoint: 'https://x.example/tts' }), 'custom');
  assert.equal(engineOf({ provider: 'breeze' }), 'breeze');
  assert.equal(engineOf({ provider: 'custom', model: 'breeze-tts-2', endpoint: 'http://10.0.0.2:9000/x' }), 'breeze');
  assert.equal(engineOf({ provider: 'custom', endpoint: 'http://127.0.0.1:4180/voice_clone' }), 'breeze');
  assert.equal(engineOf(null), 'none');
  assert.equal(engineOf({ provider: 'unavailable' }), 'none');
});

test('Breeze 下隐藏计费、不挂可导演、不要 API Key', () => {
  const breeze = { provider: 'breeze' };
  assert.equal(showsBilling(breeze), false);
  assert.equal(showsDirectable(breeze), false);
  assert.equal(needsCredential(breeze), false);
  assert.equal(showsBilling({ provider: 'volcengine-api-key' }), true);
  assert.equal(showsDirectable({ provider: 'volcengine-api-key' }), true);
  assert.equal(showsDirectable({ provider: 'demo' }), false);
  assert.equal(needsCredential({ provider: 'volcengine-api-key' }), true);
});

test('breezePreset：原生 provider breeze + breezeEndpoint；旧的 custom 配置也认成 Breeze', () => {
  const preset = breezePreset('http://127.0.0.1:4180/');
  assert.deepEqual(preset, { provider: 'breeze', breezeEndpoint: 'http://127.0.0.1:4180' });
  assert.equal(engineOf(preset), 'breeze');
  assert.equal(breezeBaseOf(preset), 'http://127.0.0.1:4180');
  assert.equal(engineOf({ provider: 'custom', endpoint: 'http://127.0.0.1:4180/voice_clone' }), 'breeze');
  assert.equal(breezeBaseOf({ provider: 'custom', endpoint: 'http://10.0.0.2:4180/voice_clone' }), 'http://10.0.0.2:4180');
});

test('llmKeyRequired：只有火山方舟必须填 Key，其他 OpenAI 兼容接口可留空', () => {
  assert.equal(llmKeyRequired('https://ark.cn-beijing.volces.com/api/v3/chat/completions'), true);
  assert.equal(llmKeyRequired('http://127.0.0.1:11434/v1/chat/completions'), false);
  assert.equal(llmKeyRequired('not a url'), false);
});

test('normalizeBreezeStatus：health 的 reachable', () => {
  assert.equal(normalizeBreezeStatus({ reachable: true, latencyMs: 12 }).state, 'connected');
  assert.equal(normalizeBreezeStatus({ reachable: false, error: '连不上' }).detail, '连不上');
});

test('用时估算：音频 = 字数 × 0.19 秒，生成 = 1.6–1.85 倍', () => {
  const range = breezeGenerationSeconds(100);
  assert.ok(Math.abs(range.audioSeconds - 19) < 1e-9);
  assert.ok(Math.abs(range.low - 30.4) < 1e-9);
  assert.ok(Math.abs(range.high - 35.15) < 1e-9);
  assert.ok(Math.abs(breezeGenerationSeconds({ audioSeconds: 10 }).mid - 17.5) < 1e-9);
  assert.ok(Math.abs(breezeGenerationSeconds({ text: '悟空……' }).audioSeconds - 4 * 0.19) < 1e-9);
});

test('formatSecondsRange：秒和分钟', () => {
  assert.equal(formatSecondsRange(30.4, 35.15), '约 30–35 秒');
  assert.equal(formatSecondsRange(7, 7.2), '约 7 秒');
  assert.equal(formatSecondsRange(400, 480), '约 7–8 分钟');
});

test('breezeEstimateText：不提扣费，按需要新生成的字数估用时', () => {
  const text = breezeEstimateText({ requestCount: 19, characters: 400, estimatedBillableCharacters: 300, unknownCharacters: 0 });
  assert.match(text.main, /^本地 Breeze · 预计用时约 \d+(–\d+)? 分钟$/);
  assert.doesNotMatch(text.main + text.note, /扣费|字符/);
  assert.match(text.note, /按 300 字估算/);
  assert.equal(breezeEstimateText({ requestCount: 0 }).main, '全部已有音频，无需生成');
  assert.equal(breezeEstimateText({ requestCount: 3, characters: 40, estimatedBillableCharacters: 0, unknownCharacters: 0 }).main, '全部可复用缓存，无需生成');
});

test('lineCostText：豆包「约 N 字」，Breeze 显示用时', () => {
  const line = { text: '又是那妖怪变的，看棒！' };
  assert.equal(lineCostText(line, { provider: 'volcengine-api-key' }).main, '约 11 字');
  assert.match(lineCostText(line, { provider: 'breeze' }).main, /预计用时约 \d+(–\d+)? 秒/);
});

test('normalizeBreezeStatus：已连接 / 断开 / 接口未接入', () => {
  assert.equal(normalizeBreezeStatus({ ok: true, model: 'breeze-tts-2', latencyMs: 12 }).state, 'connected');
  assert.equal(normalizeBreezeStatus({ ok: true, model: 'breeze-tts-2', latencyMs: 12 }).detail, 'breeze-tts-2 · 12 ms');
  const down = normalizeBreezeStatus({ ok: false, error: 'connect ECONNREFUSED' });
  assert.equal(down.state, 'disconnected'); assert.equal(down.detail, 'connect ECONNREFUSED');
  assert.equal(normalizeBreezeStatus(null, { httpStatus: 404 }).state, 'unknown');
  assert.equal(normalizeBreezeStatus({ ok: true, busy: true }).label, '生成中');
});

test('Breeze 服务地址：去掉末尾 /tts 等路径并提示；健康检查带回的音色数会显示', () => {
  assert.equal(normalizeBreezeBase(' http://127.0.0.1:4180/tts/ '), 'http://127.0.0.1:4180');
  assert.equal(normalizeBreezeBase('http://mac.local:4180/voices'), 'http://mac.local:4180');
  assert.equal(breezePreset('http://127.0.0.1:4180/tts').breezeEndpoint, 'http://127.0.0.1:4180');
  assert.equal(breezeBaseHint('http://127.0.0.1:4180/tts'), '已去掉末尾的 /tts，只需填服务地址');
  assert.equal(breezeBaseHint('http://127.0.0.1:4180/tts/'), '已去掉末尾的 /tts，只需填服务地址');
  assert.equal(breezeBaseHint('http://127.0.0.1:4180'), '');
  assert.match(breezeBaseHint('127.0.0.1:4180'), /http:\/\/主机:端口/);
  assert.match(normalizeBreezeStatus({ reachable: true, voices: [{}, {}] }).detail, /已读到 2 个音色/);
});

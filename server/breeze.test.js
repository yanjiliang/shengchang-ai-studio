// Breeze 预设（custom 适配器）+ 健康检查，全部打模拟服务，不碰真实 Breeze / 豆包。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startMockBreeze } from './test-support/mock-breeze.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-breeze-test-'));
process.env.HOME = scratch;
process.env.SHENGCHANG_RUNTIME_DIR = path.join(scratch, 'runtime');
const { breezeHealth, explainBreezeFailure, normalizeBreezeEndpoint, normalizeBreezeTimeout, BREEZE_DEFAULT_ENDPOINT } = await import('./breeze.js');
const { synthesize, validateProviderConfig, TTS_INSTRUCTION_VERSION } = await import('./model-adapters.js');
const { sanitizeConfig, readConfig } = await import('./config-store.js');
const { audioContentHash } = await import('./database.js');
const { registerBreezeRoutes } = await import('./breeze-routes.js');
const express = (await import('express')).default;

let mock;
before(async () => { mock = await startMockBreeze(); mock.state.voices.set('tangseng', { id: 'tangseng', transcript: 'x' }); });
after(async () => { await mock.close(); rmSync(scratch, { recursive: true, force: true }); });

const breezeConfig = () => ({ ...sanitizeConfig({ provider: 'breeze', breezeEndpoint: mock.endpoint }), accessKey: 'DOUBAO-KEY-MUST-NOT-LEAK' });
const line = { text: '徒弟，为师腹中饥饿。', voiceId: 'tangseng', emotion: '疲惫', emotionScale: 0.3, speed: 1, subtext: '旅途劳顿' };

describe('Breeze 预设走 custom 适配器', () => {
  test('POST /tts：契约字段齐全、不带鉴权头，返回 wav 与 X-Seed', async () => {
    const audio = await synthesize(breezeConfig(), line);
    const sent = mock.state.requests.at(-1);
    assert.equal(sent.path, '/tts');
    assert.deepEqual(Object.keys(sent.body).sort(), ['emotion', 'emotionScale', 'instruction', 'speed', 'subtext', 'text', 'voiceId']);
    assert.equal(sent.body.voiceId, 'tangseng');
    assert.equal(sent.body.speed, 1);
    assert.match(sent.body.instruction, /疲惫/);
    assert.doesNotMatch(sent.body.instruction, /保持当前基础音色稳定/, '豆包专用的稳定音色从句不发给 Breeze');
    assert.equal(audio.mime, 'audio/wav');
    assert.equal(audio.buffer.subarray(0, 4).toString(), 'RIFF');
    assert.equal(audio.seed, 42, '没指定种子时服务用默认 42，并通过 X-Seed 告知');
  });

  test('只有显式种子才进请求体', async () => {
    const audio = await synthesize(breezeConfig(), { ...line, seed: 7 });
    assert.equal(mock.state.requests.at(-1).body.seed, 7);
    assert.equal(audio.seed, 7);
  });

  test('Breeze 400 → 422，带上服务的纯文本原因', async () => {
    await assert.rejects(synthesize(breezeConfig(), { ...line, voiceId: 'nobody' }), (error) => error.status === 422 && error.upstreamStatus === 400 && /unknown voiceId: nobody/.test(error.message));
  });

  test('Breeze 500 → 502', async () => {
    mock.state.failNext = { path: '/tts', status: 500, text: 'CUDA OOM' };
    await assert.rejects(synthesize(breezeConfig(), line), (error) => error.status === 502 && /CUDA OOM/.test(error.message));
  });

  test('服务没起：503 + 说清楚哪个地址连不上', async () => {
    const config = sanitizeConfig({ provider: 'breeze', breezeEndpoint: 'http://127.0.0.1:1' });
    await assert.rejects(synthesize(config, line), (error) => error.status === 503 && error.code === 'BREEZE_UNREACHABLE' && error.message.includes('127.0.0.1:1'));
  });

  test('超时翻译成 504', () => {
    const error = explainBreezeFailure(Object.assign(new Error('aborted'), { name: 'AbortError' }), { endpoint: 'x', timeoutMs: 120_000 });
    assert.equal(error.status, 504);
    assert.match(error.message, /120 秒/);
  });

  test('Breeze 不需要凭证；地址非法时报错', () => {
    assert.doesNotThrow(() => validateProviderConfig({ provider: 'breeze', breezeEndpoint: 'http://127.0.0.1:4180' }));
    assert.throws(() => validateProviderConfig({ provider: 'breeze', breezeEndpoint: 'ftp://x' }), /Breeze 服务地址无效/);
    assert.doesNotThrow(() => validateProviderConfig({ provider: 'custom', endpoint: 'http://x' }), 'custom 不再强制凭证');
  });
});

describe('Breeze 配置', () => {
  test('默认地址 127.0.0.1:4180；去掉末尾斜杠；拒绝带账号/查询串的地址', () => {
    assert.equal(sanitizeConfig({}).breezeEndpoint, BREEZE_DEFAULT_ENDPOINT);
    assert.equal(normalizeBreezeEndpoint('http://mac.local:4180/'), 'http://mac.local:4180');
    assert.equal(normalizeBreezeEndpoint('http://u:p@host:1'), null);
    assert.equal(normalizeBreezeEndpoint('http://host:1/?a=1'), null);
    assert.equal(normalizeBreezeEndpoint('javascript:alert(1)'), null);
  });
  test('超时夹在 5s–900s，非法值回落默认 180s', () => {
    assert.equal(normalizeBreezeTimeout(10), 5000);
    assert.equal(normalizeBreezeTimeout(10_000_000), 900_000);
    assert.equal(normalizeBreezeTimeout('abc'), 180_000);
    assert.equal(sanitizeConfig({ breezeTimeoutMs: 60000 }).breezeTimeoutMs, 60000);
  });
  test('切到 Breeze 不动豆包的 endpoint / accessKey', () => {
    const config = sanitizeConfig({ provider: 'breeze', endpoint: 'https://openspeech.example/v3', accessKey: 'k' });
    assert.equal(config.endpoint, 'https://openspeech.example/v3');
    assert.equal(config.accessKey, 'k');
  });
  test('缓存键：Breeze 带指令版本和 Breeze 地址；换地址即换键', () => {
    const a = audioContentHash(sanitizeConfig({ provider: 'breeze', breezeEndpoint: 'http://127.0.0.1:4180' }), line);
    const b = audioContentHash(sanitizeConfig({ provider: 'breeze', breezeEndpoint: 'http://127.0.0.1:4181' }), line);
    assert.notEqual(a, b);
    assert.ok(TTS_INSTRUCTION_VERSION >= 2);
  });
});

describe('GET /api/engines/breeze/health', () => {
  let server; let base;
  before(async () => {
    const app = express();
    registerBreezeRoutes(app);
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());
  const writeConfigFile = (config) => { mkdirSync(path.join(scratch, '.shengchang'), { recursive: true }); writeFileSync(path.join(scratch, '.shengchang', 'config.json'), JSON.stringify(config)); };

  test('服务在：reachable + 音色数 + 延迟', async () => {
    writeConfigFile({ provider: 'breeze', breezeEndpoint: mock.endpoint });
    assert.equal((await readConfig()).breezeEndpoint, mock.endpoint);
    const body = await (await fetch(`${base}/api/engines/breeze/health`)).json();
    assert.equal(body.reachable, true);
    assert.equal(body.active, true);
    assert.equal(body.voiceCount, 1);
    assert.ok(Number.isFinite(body.latencyMs));
  });
  test('服务不在：仍是 200，reachable=false 并给出原因', async () => {
    writeConfigFile({ provider: 'demo', breezeEndpoint: 'http://127.0.0.1:1' });
    const response = await fetch(`${base}/api/engines/breeze/health`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.reachable, false);
    assert.equal(body.active, false);
    assert.match(body.error, /无法连接 Breeze/);
  });
  test('健康检查不占生成槽（只打 GET /voices）', async () => {
    const before = mock.state.requests.length;
    await breezeHealth({ breezeEndpoint: mock.endpoint });
    assert.deepEqual(mock.state.requests.slice(before).map((item) => `${item.method} ${item.path}`), ['GET /voices']);
  });
});

test('publicConfig.voiceReady：Breeze 无凭证即就绪，豆包缺 Key 不就绪', async () => {
  const { publicConfig } = await import('./config-store.js');
  assert.equal(publicConfig(sanitizeConfig({ provider: 'breeze' })).voiceReady, true);
  assert.equal(publicConfig(sanitizeConfig({ provider: 'volcengine-api-key', endpoint: 'https://x', accessKey: '' })).voiceReady, false);
  assert.equal(publicConfig(sanitizeConfig({ provider: 'demo' })).voiceReady, true);
});

test('custom 适配器可以不填凭证（本机 / 内网不鉴权服务）；有凭证才带 Authorization', async () => {
  const custom = sanitizeConfig({ provider: 'custom', endpoint: `${mock.endpoint}/tts`, accessKey: '', customBodyTemplate: '{"text":"{{text}}","voiceId":"{{voiceId}}"}' });
  assert.doesNotThrow(() => validateProviderConfig(custom));
  const audio = await synthesize(custom, line);
  assert.equal(audio.buffer.subarray(0, 4).toString(), 'RIFF');
  assert.equal(mock.state.requests.at(-1).headers?.authorization, undefined);
  const { publicConfig } = await import('./config-store.js');
  assert.equal(publicConfig(custom).voiceReady, true);
  assert.throws(() => validateProviderConfig(sanitizeConfig({ provider: 'custom', endpoint: '' })), /接口地址/);
  assert.throws(() => validateProviderConfig(sanitizeConfig({ provider: 'volcengine-api-key', endpoint: 'https://x', accessKey: '' })), /访问凭证/);
});

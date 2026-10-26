// 语音引擎按槽保存（0035）：切引擎不清别的引擎的地址 / Key；旧平铺配置迁移幂等不丢数据；摘要不含密钥。
// HTTP 部分起真实本地服务（HOME 指向临时目录），不访问任何外部服务。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { publicConfig, sanitizeConfig } from './config-store.js';
import { activeTtsSettings, applyTtsUpdate, TTS_PROVIDER_IDS, TTS_SLOT_FIELDS, TTS_UI_PRESETS, VOLCENGINE_DEFAULT_ENDPOINT } from './tts-providers.js';

const DOUBAO_KEY = 'doubao-api-key-0123456789-xyz';
const VOLC_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
// 0034 之前真实的平铺配置：豆包 + 复刻模型。
const OLD_DOUBAO = { provider: 'volcengine-api-key', endpoint: VOLC_URL, accessKey: DOUBAO_KEY, resourceId: 'seed-icl-2.0', model: 'seed-tts-2.0-standard', audioFormat: 'mp3', sampleRate: 24000, responseMode: 'auto', customHeaders: '{}', llmEndpoint: 'http://127.0.0.1:9/v1', llmApiKey: 'llm-key-unchanged-123', sfxProvider: 'demo' };

describe('迁移：旧平铺配置 → ttsProviders', () => {
  test('当前是豆包：整份进豆包槽；顶层平铺字段 = 豆包槽；其他槽为默认空', () => {
    const config = sanitizeConfig(OLD_DOUBAO);
    assert.deepEqual(Object.keys(config.ttsProviders).sort(), [...TTS_PROVIDER_IDS].sort());
    assert.equal(config.ttsProviders['volcengine-api-key'].accessKey, DOUBAO_KEY);
    assert.equal(config.ttsProviders['volcengine-api-key'].resourceId, 'seed-icl-2.0');
    assert.equal(config.accessKey, DOUBAO_KEY);
    assert.equal(config.model, 'seed-tts-2.0-standard');
    for (const id of ['demo', 'breeze', 'custom']) assert.equal(config.ttsProviders[id].accessKey, '');
  });

  test('幂等：迁移后的配置再 sanitize 一次完全相同（含写盘再读）', () => {
    for (const input of [OLD_DOUBAO, { provider: 'demo', endpoint: '本地内置，无外部请求', accessKey: DOUBAO_KEY, resourceId: 'demo' }, { provider: 'custom', endpoint: 'http://127.0.0.1:9/tts', accessKey: 'c-key-12345678', customHeaders: '{"Authorization":"Bearer h"}' }, {}]) {
      const once = sanitizeConfig(input);
      assert.deepEqual(sanitizeConfig(once), once);
      assert.deepEqual(sanitizeConfig(JSON.parse(JSON.stringify(once))), once);
    }
  });

  test('0034 之前停在 Demo / Breeze 时留下的豆包 Key 归豆包槽，不丢；Demo / Breeze 槽不带 Key', () => {
    for (const provider of ['demo', 'breeze']) {
      const config = sanitizeConfig({ provider, endpoint: provider === 'demo' ? '本地内置，无外部请求' : VOLC_URL, accessKey: DOUBAO_KEY, resourceId: provider === 'demo' ? 'demo' : 'seed-tts-2.0' });
      assert.equal(config.ttsProviders['volcengine-api-key'].accessKey, DOUBAO_KEY, provider);
      assert.equal(config.accessKey, '', provider);
      assert.equal(config.ttsProviders[provider].accessKey, '');
    }
    // 不像豆包的 http 地址（resourceId 空）→ 归自定义槽。
    const custom = sanitizeConfig({ provider: 'breeze', endpoint: 'http://127.0.0.1:9/tts', accessKey: 'c-key-12345678', resourceId: '' });
    assert.equal(custom.ttsProviders.custom.accessKey, 'c-key-12345678');
    assert.equal(custom.ttsProviders['volcengine-api-key'].accessKey, '');
  });

  test('Demo / Breeze 槽保留旧的非密钥字段（缓存键不变）', () => {
    const old = { provider: 'breeze', resourceId: 'seed-tts-2.0', model: '', audioFormat: 'wav', sampleRate: 48000 };
    const config = sanitizeConfig(old);
    assert.equal(config.audioFormat, 'wav');
    assert.equal(config.sampleRate, 48000);
    assert.equal(config.resourceId, 'seed-tts-2.0');
  });

  test('旧的 byte-v1 / byte-api-key → 豆包槽，地址置空（行为不变），Key 保留', () => {
    for (const provider of ['byte-v1', 'byte-api-key']) {
      const config = sanitizeConfig({ provider, endpoint: 'https://openspeech.bytedance.com/api/v1/tts', accessKey: DOUBAO_KEY });
      assert.equal(config.provider, 'volcengine-api-key');
      assert.equal(config.endpoint, '');
      assert.equal(config.accessKey, DOUBAO_KEY);
    }
  });

  test('text-model / sfx 字段不受影响', () => {
    const config = sanitizeConfig(OLD_DOUBAO);
    assert.equal(config.llmApiKey, 'llm-key-unchanged-123');
    assert.equal(config.llmEndpoint, 'http://127.0.0.1:9/v1');
    assert.equal(config.sfxProvider, 'demo');
    assert.equal(config.ttsProviders.llmApiKey, undefined);
  });

  test('activeTtsSettings 就是当前引擎那一槽', () => {
    const config = sanitizeConfig(OLD_DOUBAO);
    assert.equal(activeTtsSettings(config), config.ttsProviders['volcengine-api-key']);
    assert.equal(activeTtsSettings({ ...config, provider: 'custom' }), config.ttsProviders.custom);
  });
});

// 0041：旧 byte-v3 配置迁移后地址不再被清空（Tavi e2e4 报告 Bug 4）。
const BYTE_V3_KEY = 'FAKE-byte-v3-key-0000000000-abc';
const BYTE_V3_LLM_KEY = 'FAKE-llm-key-1111111111-def';
const PROXY_URL = 'http://127.0.0.1:4190/api/v3/tts/unidirectional';
// 0035 之前真实形状的 byte-v3 平铺配置（字段与当年的 DEFAULT_CONFIG 一致，假 Key）。
const OLD_BYTE_V3 = { provider: 'byte-v3', endpoint: PROXY_URL, accessKey: BYTE_V3_KEY, resourceId: 'seed-tts-2.0', model: '', audioFormat: 'mp3', sampleRate: 24000, responseMode: 'auto', customHeaders: '{}', customBodyTemplate: '{"text":"{{text}}","voice_id":"{{voiceId}}","emotion":"{{emotion}}","speed":{{speed}}}', cacheLimitGb: 50, breezeEndpoint: 'http://127.0.0.1:4181', ttsStableSpeaker: true, llmEndpoint: 'http://127.0.0.1:9/v1', llmApiKey: BYTE_V3_LLM_KEY, llmModel: '', sfxProvider: 'demo' };
const { endpoint: _dropped, ...OLD_BYTE_V3_NO_ENDPOINT } = OLD_BYTE_V3;
const flatMirror = (config) => Object.fromEntries(TTS_SLOT_FIELDS.map((field) => [field, config[field]]));

describe('迁移：旧 byte-v3 配置保留地址', () => {
  const cases = [
    ['显式地址（自建代理）', OLD_BYTE_V3, PROXY_URL],
    ['没有地址', OLD_BYTE_V3_NO_ENDPOINT, VOLCENGINE_DEFAULT_ENDPOINT],
    ['地址为空串', { ...OLD_BYTE_V3, endpoint: '' }, VOLCENGINE_DEFAULT_ENDPOINT],
    ['地址是 wss://（HTTP 适配器用不了）', { ...OLD_BYTE_V3, endpoint: 'wss://openspeech.bytedance.com/api/v3/tts/bidirection' }, VOLCENGINE_DEFAULT_ENDPOINT],
    ['地址前后有空格', { ...OLD_BYTE_V3, endpoint: `  ${PROXY_URL} ` }, PROXY_URL],
  ];
  for (const [name, old, expected] of cases) {
    test(`${name} → 豆包槽 endpoint = ${expected}；Key / resourceId 在豆包槽；顶层 = 豆包槽；幂等`, () => {
      const config = sanitizeConfig(old);
      assert.equal(config.provider, 'volcengine-api-key');
      const slot = config.ttsProviders['volcengine-api-key'];
      assert.equal(slot.endpoint, expected);
      assert.equal(slot.accessKey, BYTE_V3_KEY);
      assert.equal(slot.resourceId, 'seed-tts-2.0');
      assert.equal(slot.model, '');
      assert.deepEqual(flatMirror(config), slot, '顶层平铺字段 = 当前（豆包）槽');
      for (const id of ['demo', 'breeze', 'custom']) {
        assert.equal(config.ttsProviders[id].endpoint, '', `${id} 槽没有拿到旧地址`);
        assert.equal(config.ttsProviders[id].accessKey, '', `${id} 槽没有拿到 Key`);
      }
      assert.equal(config.llmApiKey, BYTE_V3_LLM_KEY);
      assert.equal(config.breezeEndpoint, 'http://127.0.0.1:4181');
      // 幂等：再 sanitize 一次、以及写盘格式（JSON）往返后再 sanitize，都完全相同。
      assert.deepEqual(sanitizeConfig(config), config);
      assert.deepEqual(sanitizeConfig(JSON.parse(JSON.stringify(config))), config);
      // 对外：Key 不出现在 publicConfig 里。
      const pub = JSON.stringify(publicConfig(config));
      assert.ok(!pub.includes(BYTE_V3_KEY) && !pub.includes(BYTE_V3_LLM_KEY));
    });
  }

  test('byte-v3 + 复刻模型：resourceId / model 进豆包槽', () => {
    const config = sanitizeConfig({ ...OLD_BYTE_V3, resourceId: 'seed-icl-2.0' });
    assert.equal(config.resourceId, 'seed-icl-2.0');
    assert.equal(config.model, 'seed-tts-2.0-standard');
    assert.equal(config.endpoint, PROXY_URL);
  });

  test('已迁移过的配置（有 ttsProviders）不再走 byte-v3 规则', () => {
    const migrated = sanitizeConfig(OLD_BYTE_V3_NO_ENDPOINT);
    const handEdited = { ...migrated, provider: 'byte-v3', ttsProviders: { ...migrated.ttsProviders, 'volcengine-api-key': { ...migrated.ttsProviders['volcengine-api-key'], endpoint: PROXY_URL } } };
    assert.equal(sanitizeConfig(handEdited).endpoint, PROXY_URL);
  });
});

describe('publicConfig：每槽摘要不含密钥', () => {
  test('ttsProviders 摘要有 hasKey / secretHint / 打码请求头，没有 accessKey 字段，也不含任何密钥值', () => {
    const config = sanitizeConfig({ ...OLD_DOUBAO, ttsProviders: { ...sanitizeConfig(OLD_DOUBAO).ttsProviders, custom: { endpoint: 'http://127.0.0.1:9/tts', accessKey: 'custom-key-abcdef-789', customHeaders: '{"Authorization":"Bearer HEADER-SECRET","X-Trace":"t"}' } } });
    const pub = publicConfig(config);
    const text = JSON.stringify(pub);
    for (const secret of [DOUBAO_KEY, 'custom-key-abcdef-789', 'HEADER-SECRET', 'llm-key-unchanged-123']) assert.ok(!text.includes(secret), secret);
    assert.deepEqual({ hasKey: pub.ttsProviders['volcengine-api-key'].hasKey, secretHint: pub.ttsProviders['volcengine-api-key'].secretHint }, { hasKey: true, secretHint: '···xyz' });
    assert.deepEqual({ hasKey: pub.ttsProviders.custom.hasKey, secretHint: pub.ttsProviders.custom.secretHint }, { hasKey: true, secretHint: '···789' });
    assert.equal(pub.ttsProviders.demo.hasKey, false);
    assert.equal(pub.ttsProviders.demo.secretHint, '');
    for (const slot of Object.values(pub.ttsProviders)) assert.equal('accessKey' in slot, false);
    assert.equal(JSON.parse(pub.ttsProviders.custom.customHeaders).Authorization, '__SAVED_SECRET__');
    assert.equal(JSON.parse(pub.ttsProviders.custom.customHeaders)['X-Trace'], 't');
    // 顶层平铺字段仍是当前引擎（豆包）。
    assert.equal(pub.secretHint, '···xyz');
    assert.equal(pub.hasAccessKey, true);
  });
});

describe('applyTtsUpdate：本槽内的密钥规则', () => {
  const current = sanitizeConfig(OLD_DOUBAO);
  const currentPublic = publicConfig(current);
  test('同引擎改地址且没给新 Key → 清空本槽 Key；别的槽不动', () => {
    const { ttsProviders } = applyTtsUpdate(current, { endpoint: 'https://other.example/tts', accessKey: '' }, { currentPublic });
    assert.equal(ttsProviders['volcengine-api-key'].accessKey, '');
    assert.equal(ttsProviders['volcengine-api-key'].endpoint, 'https://other.example/tts');
  });
  test('豆包：空地址与官方默认地址视为同一个', () => {
    const blank = sanitizeConfig({ ...OLD_DOUBAO, endpoint: '' });
    const { ttsProviders } = applyTtsUpdate(blank, { endpoint: VOLC_URL, accessKey: '' }, { currentPublic: publicConfig(blank) });
    assert.equal(ttsProviders['volcengine-api-key'].accessKey, DOUBAO_KEY);
  });
  test('切引擎时等于预设 / 原样带过来的字段不覆盖目标槽；新 Key 写进新引擎', () => {
    const toCustom = applyTtsUpdate(current, { ...currentPublic, provider: 'custom', ...TTS_UI_PRESETS.custom, accessKey: 'custom-new-key-000' }, { currentPublic });
    assert.equal(toCustom.provider, 'custom');
    assert.equal(toCustom.ttsProviders.custom.accessKey, 'custom-new-key-000');
    assert.equal(toCustom.ttsProviders['volcengine-api-key'].accessKey, DOUBAO_KEY);
  });
  test('自定义槽：换地址后旧的请求头密钥清掉，明文新值和普通头保留', () => {
    const base = sanitizeConfig({ provider: 'custom', endpoint: 'http://127.0.0.1:9/tts', customHeaders: '{"Authorization":"Bearer OLD","X-Api-Key":"OLD2","X-Trace":"t"}' });
    const pub = publicConfig(base);
    const headers = JSON.stringify({ ...JSON.parse(pub.customHeaders), 'X-Api-Key': 'NEW' });
    const moved = applyTtsUpdate(base, { endpoint: 'http://127.0.0.1:10/tts', customHeaders: headers }, { currentPublic: pub });
    assert.deepEqual(JSON.parse(moved.ttsProviders.custom.customHeaders), { Authorization: '', 'X-Api-Key': 'NEW', 'X-Trace': 't' });
    const unchanged = applyTtsUpdate(base, { endpoint: 'http://127.0.0.1:10/tts' }, { currentPublic: pub });
    assert.equal(JSON.parse(unchanged.ttsProviders.custom.customHeaders).Authorization, '');
    const same = applyTtsUpdate(base, { endpoint: 'http://127.0.0.1:9/tts/', customHeaders: pub.customHeaders }, { currentPublic: pub });
    assert.equal(JSON.parse(same.ttsProviders.custom.customHeaders).Authorization, 'Bearer OLD');
  });
});

describe('HTTP：旧配置里的豆包 Key 切到 Breeze 再切回来还在', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-ttsslots-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const configFile = path.join(scratch, '.shengchang', 'config.json');
  let server;

  before(async () => {
    mkdirSync(path.dirname(configFile), { recursive: true });
    writeFileSync(configFile, JSON.stringify({ ...OLD_DOUBAO, breezeEndpoint: 'http://127.0.0.1:1' }));
    server = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js')], {
      env: { ...process.env, HOME: scratch, SHENGCHANG_RUNTIME_DIR: path.join(scratch, 'runtime'), SHENGCHANG_API_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    server.stdout.on('data', (chunk) => { log += chunk; });
    server.stderr.on('data', (chunk) => { log += chunk; });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { if ((await fetch(`${base}/api/config`)).ok) return; } catch { /* not up yet */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`服务没起来：${log}`);
  });
  after(() => { server?.kill(); rmSync(scratch, { recursive: true, force: true }); });

  const get = () => fetch(`${base}/api/config`).then((r) => r.json());
  const put = (body) => fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  // 模拟现在的设置页：整份草稿回传，切引擎时套预设（SettingsView 的 changeProvider）。
  const uiSwitch = (draft, provider) => ({ ...draft, provider, ...(TTS_UI_PRESETS[provider] || {}) });

  test('GET 旧配置：顶层字段 = 豆包，摘要带 ···xyz，不回 Key', async () => {
    const config = await get();
    assert.equal(config.provider, 'volcengine-api-key');
    assert.equal(config.hasAccessKey, true);
    assert.equal(config.secretHint, '···xyz');
    assert.equal(config.accessKey, '');
    assert.equal(config.ttsProviders['volcengine-api-key'].secretHint, '···xyz');
    assert.ok(!JSON.stringify(config).includes(DOUBAO_KEY));
  });

  test('切 Breeze → 切回豆包（UI 式整份草稿）：Key、复刻模型都在，提示 ···xyz', async () => {
    const onBreeze = await put(uiSwitch(await get(), 'breeze'));
    assert.equal(onBreeze.provider, 'breeze');
    assert.equal(onBreeze.hasAccessKey, false);
    assert.equal(onBreeze.ttsProviders['volcengine-api-key'].hasKey, true);
    assert.equal(onBreeze.ttsProviders['volcengine-api-key'].secretHint, '···xyz');
    const back = await put(uiSwitch(onBreeze, 'volcengine-api-key'));
    assert.equal(back.provider, 'volcengine-api-key');
    assert.equal(back.hasAccessKey, true);
    assert.equal(back.secretHint, '···xyz');
    assert.equal(back.resourceId, 'seed-icl-2.0');
    assert.equal(back.model, 'seed-tts-2.0-standard');
    assert.equal(back.voiceReady, true);
    const file = JSON.parse(readFileSync(configFile, 'utf8'));
    assert.equal(file.ttsProviders['volcengine-api-key'].accessKey, DOUBAO_KEY);
    assert.equal(file.accessKey, DOUBAO_KEY);
    assert.equal(file.llmApiKey, 'llm-key-unchanged-123');
  });

  test('切 Demo、切自定义（预设地址为空）再切回：豆包 Key 仍在；自定义自己的地址 / Key 也各自保留', async () => {
    await put(uiSwitch(await get(), 'demo'));
    const custom = await put({ ...uiSwitch(await get(), 'custom'), endpoint: 'http://127.0.0.1:9/tts', accessKey: 'custom-key-abcdef-789' });
    assert.equal(custom.secretHint, '···789');
    assert.equal(custom.endpoint, 'http://127.0.0.1:9/tts');
    const back = await put(uiSwitch(custom, 'volcengine-api-key'));
    assert.equal(back.secretHint, '···xyz');
    const again = await put(uiSwitch(back, 'custom'));
    assert.equal(again.endpoint, 'http://127.0.0.1:9/tts');
    assert.equal(again.secretHint, '···789');
    assert.equal(again.ttsProviders['volcengine-api-key'].secretHint, '···xyz');
  });

  test('请求体里伪造的 ttsProviders 被忽略，不能抹掉已保存的 Key', async () => {
    const config = await get();
    const forged = await put({ ...config, ttsProviders: { 'volcengine-api-key': { accessKey: '' }, custom: { accessKey: 'x' } } });
    assert.equal(forged.ttsProviders['volcengine-api-key'].secretHint, '···xyz');
    assert.equal(forged.ttsProviders.custom.secretHint, '···789');
  });

  test('同一引擎内换地址且没给新 Key：只清这一槽', async () => {
    await put(uiSwitch(await get(), 'volcengine-api-key'));
    const moved = await put({ endpoint: 'http://127.0.0.1:11/tts', accessKey: '' });
    assert.equal(moved.hasAccessKey, false);
    assert.equal(moved.ttsProviders.custom.secretHint, '···789');
  });
});

// 0041：byte-v3 旧配置经过真实的配置接口（GET → 原样 PUT → 重启再 GET）地址仍在，Key 不丢不回传。
for (const [name, old, expected] of [['显式地址', OLD_BYTE_V3, PROXY_URL], ['没有地址', OLD_BYTE_V3_NO_ENDPOINT, VOLCENGINE_DEFAULT_ENDPOINT]]) {
  describe(`HTTP：旧 byte-v3 配置（${name}）读 → 存 → 重启再读，地址保留`, () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-bytev3-'));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const base = `http://127.0.0.1:${port}`;
    const configFile = path.join(scratch, '.shengchang', 'config.json');
    let server;
    const start = async () => {
      server = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js')], {
        env: { ...process.env, HOME: scratch, SHENGCHANG_RUNTIME_DIR: path.join(scratch, 'runtime'), SHENGCHANG_API_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let log = '';
      server.stdout.on('data', (chunk) => { log += chunk; });
      server.stderr.on('data', (chunk) => { log += chunk; });
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try { if ((await fetch(`${base}/api/config`)).ok) return; } catch { /* not up yet */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`服务没起来：${log}`);
    };
    const stop = () => new Promise((resolve) => { if (!server || server.exitCode !== null) return resolve(); server.once('exit', resolve); server.kill(); });
    before(async () => {
      mkdirSync(path.dirname(configFile), { recursive: true });
      writeFileSync(configFile, JSON.stringify(old));
      await start();
    });
    after(async () => { await stop(); rmSync(scratch, { recursive: true, force: true }); });
    const get = () => fetch(`${base}/api/config`).then((r) => r.json());
    const put = (body) => fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());

    test('GET：豆包、地址正确、有 Key 但不回传', async () => {
      const config = await get();
      assert.equal(config.provider, 'volcengine-api-key');
      assert.equal(config.endpoint, expected);
      assert.equal(config.ttsProviders['volcengine-api-key'].endpoint, expected);
      assert.equal(config.hasAccessKey, true);
      assert.equal(config.secretHint, '···abc');
      assert.ok(!JSON.stringify(config).includes(BYTE_V3_KEY) && !JSON.stringify(config).includes(BYTE_V3_LLM_KEY));
    });

    test('设置页原样保存（整份草稿，Key 留空）→ 写盘后地址与 Key 都在、byte-v3 不再出现', async () => {
      const saved = await put(await get());
      assert.equal(saved.endpoint, expected);
      assert.equal(saved.hasAccessKey, true);
      const disk = JSON.parse(readFileSync(configFile, 'utf8'));
      assert.equal(disk.provider, 'volcengine-api-key');
      assert.equal(disk.endpoint, expected);
      assert.equal(disk.ttsProviders['volcengine-api-key'].endpoint, expected);
      assert.equal(disk.ttsProviders['volcengine-api-key'].accessKey, BYTE_V3_KEY);
      assert.equal(disk.accessKey, BYTE_V3_KEY);
      assert.equal(disk.llmApiKey, BYTE_V3_LLM_KEY);
      for (const id of ['demo', 'breeze', 'custom']) assert.equal(disk.ttsProviders[id].accessKey, '', `${id} 槽没有 Key`);
    });

    test('重启后再读：地址仍在，文件不再变化（幂等）', async () => {
      const before = readFileSync(configFile, 'utf8');
      await stop();
      await start();
      const config = await get();
      assert.equal(config.endpoint, expected);
      assert.equal(config.hasAccessKey, true);
      await put(config);
      assert.equal(readFileSync(configFile, 'utf8'), before);
    });
  });
}

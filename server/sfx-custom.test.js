import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { synthesizeSound } from './model-adapters.js';
import { sanitizeConfig } from './config-store.js';

const config = (endpoint, extra = {}) => ({
  sfxProvider: 'custom', sfxEndpoint: endpoint, sfxAccessKey: '',
  sfxModel: 'custom-sfx-v1', sfxCustomHeaders: '{}',
  sfxCustomBodyTemplate: '{"prompt":"{{prompt}}","seconds":{{durationSec}},"model":"{{model}}"}',
  sfxTimeoutMs: 600_000, ...extra,
});

test('自定义音效接口：中文描述、时长、模型传入，无需凭证，接收 WAV', async () => {
  let received;
  const wav = Buffer.alloc(512, 0);
  wav.write('RIFF', 0);
  wav.write('WAVE', 8);
  const upstream = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received = { ...JSON.parse(body), authorization: request.headers.authorization };
    response.writeHead(200, { 'Content-Type': 'audio/wav' });
    response.end(wav);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const result = await synthesizeSound(config(`http://127.0.0.1:${upstream.address().port}/generate`), {
      prompt: '屋檐下的雨声', durationMs: 10_000, type: 'ambient',
    });
    assert.deepEqual(received, { prompt: '屋檐下的雨声', seconds: 10,
      model: 'custom-sfx-v1', authorization: undefined });
    assert.equal(result.mime, 'audio/wav');
    assert.deepEqual(result.buffer, wav);
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('自定义音效请求遵守配置的超时', async () => {
  const upstream = http.createServer((request) => request.resume());
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(synthesizeSound(config(`http://127.0.0.1:${upstream.address().port}/generate`, {
      sfxTimeoutMs: 50,
    }), { prompt: '雨声', durationMs: 1000 }), (error) => error.name === 'AbortError');
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('音效超时配置保留合法值，非法值回落默认', () => {
  assert.equal(sanitizeConfig({ sfxTimeoutMs: 600_000 }).sfxTimeoutMs, 600_000);
  assert.equal(sanitizeConfig({ sfxTimeoutMs: -1 }).sfxTimeoutMs, 120_000);
  assert.equal(sanitizeConfig({ sfxTimeoutMs: 1_800_001 }).sfxTimeoutMs, 120_000);
});

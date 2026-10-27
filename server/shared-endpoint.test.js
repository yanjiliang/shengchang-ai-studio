// shared/endpoint.mjs：前后端共用的地址规范化（前端判断“地址变没变”、服务端决定是否沿用已保存的 Key）。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { llmChatUrl, normalizeEndpoint, normalizeLlmBaseUrl, sameEndpoint, sameLlmEndpoint } from '../shared/endpoint.mjs';
import { llmChatUrl as serverLlmChatUrl, resolveLlmApiKey, validateLlmConfig } from './story-analyzer.js';

test('normalizeLlmBaseUrl：去空白、末尾 / 和 /chat/completions', () => {
  for (const input of ['https://api.example.com/v1', ' https://api.example.com/v1/ ', 'https://api.example.com/v1/chat/completions', 'https://api.example.com/v1/chat/completions/', 'https://api.example.com/v1/Chat/Completions', 'https://api.example.com/v1//']) {
    assert.equal(normalizeLlmBaseUrl(input), 'https://api.example.com/v1', input);
  }
  assert.equal(normalizeLlmBaseUrl(''), '');
  assert.equal(normalizeLlmBaseUrl(undefined), '');
});

test('llmChatUrl：服务端用的就是共享实现', () => {
  assert.equal(serverLlmChatUrl, llmChatUrl);
  assert.equal(llmChatUrl('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434/v1/chat/completions');
  assert.equal(llmChatUrl('https://ark.cn-beijing.volces.com/api/v3/chat/completions'), 'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
  assert.equal(llmChatUrl(''), '');
});

test('sameLlmEndpoint / sameEndpoint', () => {
  assert.equal(sameLlmEndpoint('https://x.test/v1', 'https://x.test/v1/chat/completions'), true);
  assert.equal(sameLlmEndpoint('https://x.test/v1', 'https://y.test/v1'), false);
  assert.equal(normalizeEndpoint(' http://127.0.0.1:9/tts/ '), 'http://127.0.0.1:9/tts');
  assert.equal(sameEndpoint('http://127.0.0.1:9/tts', 'http://127.0.0.1:9/tts/'), true);
  assert.equal(sameEndpoint('http://127.0.0.1:9/tts', 'http://127.0.0.1:9/tts/chat/completions'), false, 'TTS 地址不做 chat/completions 规则');
});

test('resolveLlmApiKey 用共享规范化：base URL 与完整地址视为同一个', () => {
  const saved = { llmEndpoint: 'https://x.test/v1', llmApiKey: 'sk-saved' };
  assert.equal(resolveLlmApiKey({ llmEndpoint: 'https://x.test/v1/chat/completions' }, saved), 'sk-saved');
  assert.equal(resolveLlmApiKey({ llmEndpoint: 'https://y.test/v1/chat/completions' }, saved), '');
});

test('validateLlmConfig：错误带 code + field；非 http(s) 协议算地址无效', () => {
  const base = { llmEndpoint: 'http://127.0.0.1:1/v1', llmApiKey: '', llmModel: 'm' };
  const fieldOf = (config) => { try { validateLlmConfig(config); return null; } catch (error) { assert.equal(error.code, 'LLM_CONFIG_INVALID'); assert.equal(error.status, 400); return [error.field, error.message]; } };
  assert.equal(fieldOf(base), null);
  assert.deepEqual(fieldOf({ ...base, llmEndpoint: '' }), ['llmEndpoint', '请填写服务地址（Base URL）']);
  for (const bad of ['ftp://127.0.0.1/v1', 'file:///etc/passwd', 'javascript:alert(1)', '127.0.0.1:1/v1', 'not a url']) {
    assert.deepEqual(fieldOf({ ...base, llmEndpoint: bad }), ['llmEndpoint', '地址格式不对，应以 http:// 或 https:// 开头'], bad);
  }
  assert.deepEqual(fieldOf({ ...base, llmModel: '' }), ['llmModel', '请填写模型名']);
  assert.deepEqual(fieldOf({ ...base, llmEndpoint: 'https://ark.cn-beijing.volces.com/api/v3' })[0], 'llmApiKey');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { LLM_SERVER_FACTORY_ENDPOINT, llmConfigForView, llmUnconfiguredDefault, llmBaseHint, llmErrorText, llmTestOutcome, llmUrlChanged, llmFieldErrors, llmFingerprint, llmKeyPlaceholder, llmReady, llmSuccessText, normalizeLlmBase, readLlmVerified, writeLlmVerified } from './llm.js';

const memory = () => { const map = new Map(); return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) }; };

test('Base URL：去掉末尾的 / 和 /chat/completions，并给提示', () => {
  assert.deepEqual(normalizeLlmBase('https://api.example.com/v1/'), { base: 'https://api.example.com/v1', stripped: false });
  assert.deepEqual(normalizeLlmBase(' https://api.example.com/v1/chat/completions/ '), { base: 'https://api.example.com/v1', stripped: true });
  assert.equal(normalizeLlmBase('http://127.0.0.1:11434/v1//chat/completions').base, 'http://127.0.0.1:11434/v1');
  assert.equal(llmBaseHint('https://x/v1/chat/completions'), '已自动去掉末尾的 /chat/completions');
  assert.equal(llmBaseHint('https://x/v1/'), '');
});

test('Key 占位文字跟 llmApiKeyRequired 走', () => {
  assert.equal(llmKeyPlaceholder(true), '必填');
  assert.equal(llmKeyPlaceholder(false), '本地服务可以不填');
});

test('模型名必填；需要 Key 时没填也没存过才报', () => {
  assert.deepEqual(llmFieldErrors({ llmEndpoint: 'https://x/v1', llmModel: 'qwen-plus' }), {});
  assert.equal(llmFieldErrors({ llmEndpoint: 'https://x/v1', llmModel: ' ' }).llmModel, '填一下模型名');
  assert.ok(llmFieldErrors({ llmEndpoint: 'https://x/v1', llmModel: 'm' }, { keyRequired: true }).llmApiKey);
  assert.equal(llmFieldErrors({ llmEndpoint: 'https://x/v1', llmModel: 'm', hasLlmApiKey: true }, { keyRequired: true }).llmApiKey, undefined);
});

test('测试结果：看 ok 和 code，不看 HTTP 状态', () => {
  assert.deepEqual(llmTestOutcome({ ok: true, latencyMs: 1234, code: null, message: '连接正常' }), { ok: true, text: '连接正常，用时 1.2 秒', field: null, latencyMs: 1234 });
  assert.equal(llmSuccessText({ latencyMs: 15400 }), '连接正常，用时 15 秒');
  assert.equal(llmTestOutcome({ ok: false, code: 'LLM_AUTH', status: 401, message: 'invalid key' }).text, 'Key 不对或已过期');
  assert.equal(llmTestOutcome({ ok: false, code: 'LLM_NOT_FOUND', status: 404, message: 'x' }).text, '地址或模型名不对，请检查是否以 /v1 结尾');
  assert.equal(llmTestOutcome({ ok: false, code: 'LLM_UNREACHABLE', message: '连接超时（20 秒内没有响应）' }).text, '连不上这个地址');
  assert.equal(llmTestOutcome({ ok: false, code: 'LLM_UPSTREAM', status: 500, message: 'The model is overloaded' }).text, 'The model is overloaded');
  const invalid = Object.assign(new Error('请在设置中填写文本理解模型名称'), { status: 400, payload: { ok: false, latencyMs: null, code: 'LLM_CONFIG_INVALID', message: '请在设置中填写文本理解模型名称', field: 'llmModel' } });
  assert.deepEqual(llmTestOutcome(invalid), { ok: false, text: '请在设置中填写文本理解模型名称', field: 'llmModel' });
  assert.equal(llmTestOutcome({ ok: false, code: 'LLM_CONFIG_INVALID', message: 'm', field: 'nope' }).field, null);
  // 0033 之前的服务端：400 + 「文本模型返回 401: …」
  assert.equal(llmTestOutcome(Object.assign(new Error('文本模型返回 403: forbidden'), { status: 400, payload: { error: '文本模型返回 403: forbidden' } })).text, 'Key 不对或已过期');
  assert.equal(llmErrorText({ message: 'fetch failed' }), '连不上这个地址');
});

test('地址改没改按规范化后的比', () => {
  assert.equal(llmUrlChanged('https://x/v1/chat/completions', 'https://x/v1/'), false);
  assert.equal(llmUrlChanged('https://y/v1', 'https://x/v1'), true);
});

test('连通状态绑在设置上：地址 / 模型 / Key 变了要重新测', () => {
  const store = memory();
  const saved = { llmEndpoint: 'https://x/v1', llmModel: 'qwen-plus', hasLlmApiKey: true, llmSecretHint: '••ab' };
  assert.equal(llmReady(saved, readLlmVerified(store)), false);
  writeLlmVerified(saved, { latencyMs: 800 }, store);
  assert.equal(llmReady(saved, readLlmVerified(store)), true);
  assert.equal(llmReady({ ...saved, llmModel: 'qwen-max' }, readLlmVerified(store)), false);
  assert.equal(llmReady({ ...saved, llmEndpoint: 'https://x/v1/chat/completions' }, readLlmVerified(store)), true);
  assert.equal(llmReady({ ...saved, llmVerified: false }, readLlmVerified(store)), false);
  assert.notEqual(llmFingerprint({ ...saved, llmApiKey: 'sk-new' }), llmFingerprint(saved));
});

test('llmConfigForView：服务端出厂默认的方舟地址（没配过）在设置页显示成空白', () => {
  const factory = { llmEndpoint: LLM_SERVER_FACTORY_ENDPOINT, llmModel: '', hasLlmApiKey: false, llmApiKeyRequired: true, provider: 'breeze' };
  assert.equal(llmUnconfiguredDefault(factory), true);
  assert.deepEqual(llmConfigForView(factory), { ...factory, llmEndpoint: '', llmApiKeyRequired: false });
  assert.equal(llmUnconfiguredDefault({ ...factory, llmEndpoint: 'https://ark.cn-beijing.volces.com/api/v3' }), true);
});

test('llmConfigForView：用户自己配过（有模型名或存了 Key、或别的地址）原样显示', () => {
  const factory = { llmEndpoint: LLM_SERVER_FACTORY_ENDPOINT, llmModel: '', hasLlmApiKey: false };
  for (const config of [{ ...factory, llmModel: 'doubao-seed-1.6' }, { ...factory, hasLlmApiKey: true }, { ...factory, llmEndpoint: 'http://127.0.0.1:4198/v1' }, { ...factory, llmEndpoint: '' }]) {
    assert.equal(llmConfigForView(config), config);
  }
  assert.equal(llmConfigForView(null), null);
});

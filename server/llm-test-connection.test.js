// 设置页「测试连接」：POST /api/config/test-llm 的错误分类、Key 不外泄、换地址不沿用已保存的 Key。
// 单元部分用注入的假 fetch；HTTP 部分起真实本地服务 + 本机模拟上游，不访问任何外部模型。
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, test } from 'node:test';
import { redactLlmSecret, resolveLlmApiKey, testLlm } from './story-analyzer.js';

const KEY = 'sk-test-SECRET-0123456789abcdef';
const cfg = (extra = {}) => ({ llmEndpoint: 'https://llm.example.test/v1', llmApiKey: KEY, llmModel: 'm', ...extra });
const reply = (status, body, headers = { 'Content-Type': 'application/json' }) => async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
const assertShape = (result) => {
  assert.equal(typeof result.ok, 'boolean');
  assert.ok(result.latencyMs === null || typeof result.latencyMs === 'number');
  assert.ok(result.code === null || typeof result.code === 'string');
  assert.equal(typeof result.message, 'string');
};

describe('testLlm 错误分类（假 fetch）', () => {
  test('成功：ok true、code null、有 latencyMs；请求很短、带 Bearer', async () => {
    let sent;
    const result = await testLlm(cfg(), { fetchImpl: async (url, init) => { sent = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: '好' } }] }), { status: 200 }); } });
    assertShape(result);
    assert.equal(result.ok, true);
    assert.equal(result.code, null);
    assert.equal(sent.url, 'https://llm.example.test/v1/chat/completions');
    assert.equal(sent.init.headers.Authorization, `Bearer ${KEY}`);
    const body = JSON.parse(sent.init.body);
    assert.equal(body.model, 'm');
    assert.ok(body.max_tokens <= 32);
    assert.equal(body.response_format, undefined);
  });

  for (const status of [401, 403]) {
    test(`${status} → LLM_AUTH，带 status 和上游原话`, async () => {
      const result = await testLlm(cfg(), { fetchImpl: reply(status, { error: { message: 'The API key is invalid' } }) });
      assertShape(result);
      assert.deepEqual({ ok: result.ok, code: result.code, status: result.status }, { ok: false, code: 'LLM_AUTH', status });
      assert.match(result.message, /API key is invalid/);
    });
  }

  test('404 → LLM_NOT_FOUND', async () => {
    const result = await testLlm(cfg(), { fetchImpl: reply(404, 'Not Found', {}) });
    assert.deepEqual({ ok: result.ok, code: result.code, status: result.status }, { ok: false, code: 'LLM_NOT_FOUND', status: 404 });
  });

  test('连不上（ECONNREFUSED / DNS）→ LLM_UNREACHABLE，带原因码', async () => {
    for (const cause of ['ECONNREFUSED', 'ENOTFOUND']) {
      const result = await testLlm(cfg(), { fetchImpl: async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: cause }) }); } });
      assertShape(result);
      assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code: 'LLM_UNREACHABLE' });
      assert.match(result.message, new RegExp(cause));
      assert.equal(result.status, undefined);
    }
  });

  test('超时 → LLM_UNREACHABLE（测试用短超时，真的中断请求）', async () => {
    const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const result = await testLlm(cfg(), { fetchImpl, timeoutMs: 30 });
    assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code: 'LLM_UNREACHABLE' });
    assert.match(result.message, /超时/);
  });

  test('其他非 2xx → LLM_UPSTREAM，上游原话截断到 ~300 字', async () => {
    const result = await testLlm(cfg(), { fetchImpl: reply(500, { error: { message: 'x'.repeat(2000) } }) });
    assert.deepEqual({ ok: result.ok, code: result.code, status: result.status }, { ok: false, code: 'LLM_UPSTREAM', status: 500 });
    assert.ok(result.message.length <= 301, `message 长度 ${result.message.length}`);
  });

  test('2xx 但不是 JSON / 没有 choices → LLM_UPSTREAM', async () => {
    const html = await testLlm(cfg(), { fetchImpl: reply(200, '<html>login</html>', {}) });
    assert.equal(html.code, 'LLM_UPSTREAM');
    assert.match(html.message, /不是 JSON/);
    const other = await testLlm(cfg(), { fetchImpl: reply(200, { hello: 'world' }) });
    assert.equal(other.code, 'LLM_UPSTREAM');
  });

  test('上游回显 Key / Authorization 头时，message 里被抹掉', async () => {
    const echo = { error: { message: `bad request, headers: {"Authorization": "Bearer ${KEY}"}, key=${KEY}` } };
    for (const status of [400, 401, 500]) {
      const result = await testLlm(cfg(), { fetchImpl: reply(status, echo) });
      assert.ok(!result.message.includes(KEY), result.message);
      assert.ok(!/SECRET/.test(result.message), result.message);
    }
    assert.equal(redactLlmSecret('Authorization: Bearer abcdef123456', ''), 'Authorization: Bearer ***');
  });
});

describe('resolveLlmApiKey：只有地址不变才沿用已保存的 Key', () => {
  const saved = { llmEndpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', llmApiKey: KEY };
  test('请求自带 Key → 用请求的', () => assert.equal(resolveLlmApiKey({ llmApiKey: 'sk-new', llmEndpoint: 'https://other.test/v1' }, saved), 'sk-new'));
  test('没带 Key、地址相同（写法不同但规范化后一致）→ 沿用', () => {
    assert.equal(resolveLlmApiKey({ llmEndpoint: 'https://ark.cn-beijing.volces.com/api/v3/' }, saved), KEY);
    assert.equal(resolveLlmApiKey({}, saved), KEY, '请求不带地址 = 地址没变');
  });
  test('没带 Key、地址换了 → 不发 Key', () => assert.equal(resolveLlmApiKey({ llmApiKey: '', llmEndpoint: 'https://evil.example.test/v1' }, saved), ''));
});

describe('HTTP：/api/config 与 /api/config/test-llm', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-testllm-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  let server;
  let upstream;
  let upstreamBase;
  const seen = [];

  before(async () => {
    // 本机模拟的两个“服务商”：/a 和 /b，只记录收到的 Authorization。
    upstream = http.createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        seen.push({ path: request.url, authorization: request.headers.authorization });
        if (!request.headers.authorization && request.url.startsWith('/b/')) { response.writeHead(401, { 'Content-Type': 'application/json' }); return response.end('{"error":{"message":"missing key"}}'); }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"choices":[{"message":{"content":"好"}}]}');
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
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
  after(async () => {
    server?.kill();
    upstream.closeAllConnections?.();
    await new Promise((resolve) => upstream.close(resolve));
    rmSync(scratch, { recursive: true, force: true });
  });
  beforeEach(() => { seen.length = 0; });

  const put = (body) => fetch(`${base}/api/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const probe = async (body) => { const response = await fetch(`${base}/api/config/test-llm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };

  test('保存后 GET/PUT 都不回传 Key，只给 hasLlmApiKey 和掩码', async () => {
    const saved = await put({ llmEndpoint: `${upstreamBase}/a/v1`, llmApiKey: KEY, llmModel: 'm' });
    const read = await fetch(`${base}/api/config`).then((r) => r.json());
    for (const config of [saved, read]) {
      assert.equal(config.llmApiKey, '');
      assert.equal(config.hasLlmApiKey, true);
      assert.ok(!JSON.stringify(config).includes(KEY));
      assert.equal(config.llmSecretHint, `···${KEY.slice(-3)}`, '只露末 3 位');
      assert.ok(!config.llmSecretHint.includes(KEY.slice(0, 3)));
    }
  });

  test('测试连接：同一地址不带 Key → 沿用已保存的；换地址 → 不带 Key', async () => {
    const same = await probe({ llmEndpoint: `${upstreamBase}/a/v1/chat/completions`, llmApiKey: '', llmModel: 'm' });
    assert.equal(same.status, 200);
    assert.deepEqual({ ok: same.body.ok, code: same.body.code }, { ok: true, code: null });
    assert.equal(seen.at(-1).authorization, `Bearer ${KEY}`);
    const other = await probe({ llmEndpoint: `${upstreamBase}/b/v1`, llmApiKey: '', llmModel: 'm' });
    assert.equal(other.status, 200);
    assert.deepEqual({ ok: other.body.ok, code: other.body.code, status: other.body.status }, { ok: false, code: 'LLM_AUTH', status: 401 });
    assert.equal(seen.at(-1).path, '/b/v1/chat/completions');
    assert.equal(seen.at(-1).authorization, undefined, '已保存的 Key 不能发给另一个地址');
    assert.ok(!JSON.stringify(other.body).includes(KEY));
  });

  // 方舟缺 Key 的校验在 llm-openai-compat.test.js 里做单元测试：这里不放方舟地址，免得回归时真的打到外网。
  test('测试连接：本地校验失败 → 400 LLM_CONFIG_INVALID（同样是完整形状）', async () => {
    const cases = [
      [{ llmEndpoint: '', llmModel: 'm' }, 'llmEndpoint', /Base URL/],
      [{ llmEndpoint: 'not a url', llmModel: 'm' }, 'llmEndpoint', /^地址格式不对，应以 http:\/\/ 或 https:\/\/ 开头$/],
      [{ llmEndpoint: 'ftp://127.0.0.1/v1', llmModel: 'm' }, 'llmEndpoint', /应以 http:\/\/ 或 https:\/\/ 开头/],
      [{ llmEndpoint: `${upstreamBase}/a/v1`, llmModel: '' }, 'llmModel', /^请填写模型名$/],
      [{ llmEndpoint: `${upstreamBase}/a/v1`, llmModel: '   ' }, 'llmModel', /^请填写模型名$/],
    ];
    for (const [body, field, message] of cases) {
      const result = await probe(body);
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.deepEqual({ ok: result.body.ok, latencyMs: result.body.latencyMs, code: result.body.code, field: result.body.field }, { ok: false, latencyMs: null, code: 'LLM_CONFIG_INVALID', field });
      assert.match(result.body.message, message);
      assert.equal(typeof result.body.message, 'string');
    }
    assert.equal(seen.length, 0, '校验没过不发请求');
  });

  test('测试连接：连不上 → 200 + LLM_UNREACHABLE', async () => {
    const result = await probe({ llmEndpoint: 'http://127.0.0.1:1/v1', llmApiKey: 'x', llmModel: 'm' });
    assert.equal(result.status, 200);
    assert.equal(result.body.code, 'LLM_UNREACHABLE');
  });

  test('保存：没填 Key 且地址没变 → 保留；换了地址 → 清空已保存的 Key', async () => {
    await put({ llmEndpoint: `${upstreamBase}/a/v1`, llmApiKey: KEY, llmModel: 'm' });
    const kept = await put({ llmEndpoint: `${upstreamBase}/a/v1/`, llmApiKey: '', llmModel: 'm2' });
    assert.equal(kept.hasLlmApiKey, true);
    const moved = await put({ llmEndpoint: `${upstreamBase}/b/v1`, llmApiKey: '', llmModel: 'm2' });
    assert.equal(moved.hasLlmApiKey, false, '换地址后旧 Key 不再保留');
    await probe({ llmEndpoint: `${upstreamBase}/b/v1`, llmApiKey: '', llmModel: 'm2' });
    assert.equal(seen.at(-1).authorization, undefined);
  });
  test('保存：TTS accessKey 同规则——地址没变保留，换地址且没填新 Key 清空', async () => {
    const tts = 'tts-SECRET-key-987654';
    const first = await put({ provider: 'custom', endpoint: 'http://127.0.0.1:9/tts', accessKey: tts });
    assert.equal(first.hasAccessKey, true);
    assert.equal(first.secretHint, '···654');
    assert.equal(first.accessKey, '');
    const kept = await put({ provider: 'custom', endpoint: 'http://127.0.0.1:9/tts/', accessKey: '' });
    assert.equal(kept.hasAccessKey, true, '只多了末尾 / → 视为同一地址');
    const moved = await put({ provider: 'custom', endpoint: 'http://127.0.0.1:10/tts', accessKey: '' });
    assert.equal(moved.hasAccessKey, false);
    assert.equal(moved.secretHint, '');
    const fresh = await put({ provider: 'custom', endpoint: 'http://127.0.0.1:10/tts', accessKey: 'abc' });
    assert.equal(fresh.secretHint, '···', '短 Key 不露字符');
  });

  test('保存：音效 sfxAccessKey 不再被每次保存清掉；换地址才清空', async () => {
    const sfx = 'sfx-SECRET-key-111222';
    const first = await put({ sfxProvider: 'custom', sfxEndpoint: 'http://127.0.0.1:9/sfx', sfxAccessKey: sfx });
    assert.equal(first.hasSfxAccessKey, true);
    assert.equal(first.sfxSecretHint, '···222');
    const kept = await put({ sfxProvider: 'custom', sfxEndpoint: 'http://127.0.0.1:9/sfx', sfxAccessKey: '' });
    assert.equal(kept.hasSfxAccessKey, true, '前端回传的 "" 不能抹掉已保存的音效 Key');
    const moved = await put({ sfxProvider: 'custom', sfxEndpoint: 'http://127.0.0.1:11/sfx', sfxAccessKey: '' });
    assert.equal(moved.hasSfxAccessKey, false);
  });

  test('请求头密钥：customHeaders / sfxCustomHeaders 都脱敏；换地址后占位符不还原旧值', async () => {
    const secretHeaders = JSON.stringify({ Authorization: 'Bearer HDR-SECRET-1', 'X-Trace': 'keep' });
    const saved = await put({ provider: 'custom', endpoint: 'http://127.0.0.1:9/tts', customHeaders: secretHeaders, sfxProvider: 'custom', sfxEndpoint: 'http://127.0.0.1:9/sfx', sfxCustomHeaders: secretHeaders });
    assert.ok(!JSON.stringify(saved).includes('HDR-SECRET-1'), '两组请求头都不能明文回传');
    assert.equal(JSON.parse(saved.sfxCustomHeaders).Authorization, '__SAVED_SECRET__');
    // 地址不变，回传占位符 → 服务端还原（读不到明文，只能看脱敏结果仍是占位符且 hasX 不变）
    const same = await put({ endpoint: 'http://127.0.0.1:9/tts', customHeaders: saved.customHeaders, sfxEndpoint: 'http://127.0.0.1:9/sfx', sfxCustomHeaders: saved.sfxCustomHeaders });
    assert.equal(JSON.parse(same.customHeaders).Authorization, '__SAVED_SECRET__');
    assert.equal(JSON.parse(same.sfxCustomHeaders).Authorization, '__SAVED_SECRET__');
    // 换地址 → 占位符落成空串（脱敏后空值仍按 key 名显示占位符，所以直接读配置文件确认）
    await put({ endpoint: 'http://127.0.0.1:12/tts', customHeaders: same.customHeaders, sfxEndpoint: 'http://127.0.0.1:12/sfx', sfxCustomHeaders: same.sfxCustomHeaders });
    const file = JSON.parse(readFileSync(path.join(scratch, '.shengchang', 'config.json'), 'utf8'));
    assert.equal(JSON.parse(file.customHeaders).Authorization, '');
    assert.equal(JSON.parse(file.sfxCustomHeaders).Authorization, '');
    assert.equal(JSON.parse(file.customHeaders)['X-Trace'], 'keep');
  });
});

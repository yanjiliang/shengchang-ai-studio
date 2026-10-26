// 文本模型（OpenAI 兼容 chat/completions）：base URL 补全、本地免 Key、json_object 不支持时降级、
// <think> 剥离、可选 voiceDescription。只打本机模拟服务。
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { analyzeNovel, llmChatUrl, llmRequiresApiKey, testLlm, validateLlmConfig } from './story-analyzer.js';
import { mergeAnalyzedCharacters } from './character-meta.js';

// voice-references 会打开数据库：先把 HOME / 运行目录指到临时目录。
const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-llm-test-'));
process.env.HOME = scratch;
process.env.SHENGCHANG_RUNTIME_DIR = path.join(scratch, 'runtime');
const { voiceDesignDescription } = await import('./voice-references.js');

const reply = {
  project: { name: '雨夜', genre: '悬疑' },
  characters: [
    { id: 'linxia', name: '林夏', role: '主角', gender: '女', age: '青年', description: '冷静', voiceDescription: '二十多岁女声，中低音，气声略多，语速偏慢' },
    { id: 'laoban', name: '老板', role: '配角', gender: '男', age: '老年', description: '警惕' },
  ],
  scenes: [{ title: '旅馆', lines: [{ type: 'dialogue', speaker: '林夏', speakerId: 'linxia', text: '有人吗？', emotion: '紧张', intensity: 50, pace: 90 }] }],
};

let server;
let base;
const state = { requests: [], rejectJsonMode: false, think: false };

before(async () => {
  server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      state.requests.push({ path: request.url, authorization: request.headers.authorization, body });
      if (request.url !== '/v1/chat/completions') { response.writeHead(404); return response.end('not found'); }
      if (state.rejectJsonMode && body.response_format) { response.writeHead(400, { 'Content-Type': 'application/json' }); return response.end(JSON.stringify({ error: "'response_format.type' must be 'json_schema'" })); }
      const content = `${state.think ? '<think>先想想 {"不是":"结果"}</think>\n' : ''}\`\`\`json\n${JSON.stringify(reply)}\n\`\`\``;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  rmSync(scratch, { recursive: true, force: true });
});
beforeEach(() => { state.requests.length = 0; state.rejectJsonMode = false; state.think = false; });

const localConfig = () => ({ llmEndpoint: `${base}/v1`, llmApiKey: '', llmModel: 'qwen3:8b', llmSystemPrompt: '你是编剧。' });

describe('OpenAI 兼容文本模型', () => {
  test('地址：base URL 自动补 /chat/completions；完整地址原样', () => {
    assert.equal(llmChatUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(llmChatUrl('http://127.0.0.1:1234/v1/'), 'http://127.0.0.1:1234/v1/chat/completions');
    assert.equal(llmChatUrl('https://ark.cn-beijing.volces.com/api/v3/chat/completions'), 'https://ark.cn-beijing.volces.com/api/v3/chat/completions');
  });

  test('Key：方舟必填；本地 / 其他兼容服务可空', () => {
    assert.equal(llmRequiresApiKey('https://ark.cn-beijing.volces.com/api/v3/chat/completions'), true);
    assert.equal(llmRequiresApiKey('http://127.0.0.1:11434/v1'), false);
    assert.throws(() => validateLlmConfig({ llmEndpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions', llmApiKey: '', llmModel: 'm' }), /API Key/);
    assert.doesNotThrow(() => validateLlmConfig(localConfig()));
    assert.throws(() => validateLlmConfig({ ...localConfig(), llmModel: '' }), /请填写模型名/);
    assert.throws(() => validateLlmConfig({ ...localConfig(), llmEndpoint: 'not a url' }), /应以 http:\/\/ 或 https:\/\/ 开头/);
  });

  test('本地免 Key：不发 Authorization；拆解保留 voiceDescription', async () => {
    const result = await analyzeNovel(localConfig(), { text: '雨夜，林夏敲响了旧旅馆的门。', filename: 'a.txt', name: '雨夜' });
    assert.equal(result.breakdown, 'llm');
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].authorization, undefined);
    assert.equal(state.requests[0].body.model, 'qwen3:8b');
    assert.deepEqual(state.requests[0].body.response_format, { type: 'json_object' });
    assert.match(state.requests[0].body.messages[0].content, /voiceDescription/);
    const linxia = result.characters.find((item) => item.id === 'linxia');
    assert.equal(linxia.voiceDescription, '二十多岁女声，中低音，气声略多，语速偏慢');
    assert.equal('voiceDescription' in result.characters.find((item) => item.id === 'laoban'), false, '可选字段：没给就不出现');
    assert.equal(voiceDesignDescription(linxia), linxia.voiceDescription);
  });

  test('带 Key 时发 Bearer', async () => {
    await analyzeNovel({ ...localConfig(), llmApiKey: 'sk-local' }, { text: '雨夜。', filename: 'a.txt' });
    assert.equal(state.requests[0].authorization, 'Bearer sk-local');
  });

  test('服务不支持 json_object → 去掉 response_format 重试一次', async () => {
    state.rejectJsonMode = true;
    const result = await analyzeNovel(localConfig(), { text: '雨夜，林夏敲响了旧旅馆的门。', filename: 'a.txt' });
    assert.equal(state.requests.length, 2);
    assert.equal(state.requests[1].body.response_format, undefined);
    assert.equal(result.scenes.length, 1);
  });

  test('测试连接：打一次很短的请求（不带 response_format，max_tokens 很小）', async () => {
    const result = await testLlm(localConfig());
    assert.deepEqual({ ok: result.ok, code: result.code, status: result.status }, { ok: true, code: null, status: 200 });
    assert.equal(typeof result.latencyMs, 'number');
    assert.equal(state.requests.length, 1);
    assert.equal(state.requests[0].path, '/v1/chat/completions');
    assert.equal(state.requests[0].body.response_format, undefined);
    assert.ok(state.requests[0].body.max_tokens <= 32);
  });

  test('推理模型的 <think> 段被剥离', async () => {
    state.think = true;
    const result = await analyzeNovel(localConfig(), { text: '雨夜。', filename: 'a.txt' });
    assert.equal(result.scenes.length, 1);
  });

  test('重新拆解不覆盖用户改过的音色描述', () => {
    const merged = mergeAnalyzedCharacters([{ id: 'linxia', name: '林夏', voiceDescription: '用户改的' }], [{ id: 'linxia', name: '林夏', voiceDescription: '模型给的' }, { id: 'x', name: '新人', voiceDescription: '模型给的' }]);
    assert.equal(merged[0].voiceDescription, '用户改的');
    assert.equal(merged[1].voiceDescription, '模型给的');
  });
});

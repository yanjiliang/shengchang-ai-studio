import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { synthesize } from './model-adapters.js';

// Distinct byte patterns per slice keep ordering assertions meaningful, and the
// 256-byte size clears the length heuristic in extractBase64 the way real
// audio chunks do.
const SLICES = ['A', 'B', 'C'].map((mark) => Buffer.alloc(256, mark));
const WHOLE = Buffer.concat(SLICES);

const routes = {
  // Real shape of /api/v3/tts/unidirectional: chunked NDJSON, one slice per line.
  '/stream': (response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
    SLICES.forEach((slice, index) => response.write(`${JSON.stringify({ code: 0, data: slice.toString('base64'), sequence: index + 1 })}\n`));
    response.end(`${JSON.stringify({ code: 0, data: '', sequence: -1 })}\n`);
  },
  '/single': (response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ code: 0, data: WHOLE.toString('base64'), sequence: -1 }));
  },
  '/pretty': (response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ code: 0, data: WHOLE.toString('base64') }, null, 2));
  },
  '/binary': (response) => {
    response.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    response.end(WHOLE);
  },
  '/business-error': (response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ code: 3003, message: 'invalid speaker: ghost', sequence: -1 }));
  },
  '/mid-stream-error': (response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
    response.write(`${JSON.stringify({ code: 0, data: SLICES[0].toString('base64'), sequence: 1 })}\n`);
    response.end(`${JSON.stringify({ code: 55000000, message: 'server busy' })}\n`);
  },
  '/not-json': (response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('<html>gateway timeout</html>');
  },
  '/http-error': (response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ message: 'unauthorized' }));
  },
};

describe('豆包语音响应解析', () => {
  let server;
  let origin;
  const config = (path) => ({ provider: 'volcengine-api-key', endpoint: `${origin}${path}`, accessKey: 'test-key', resourceId: 'seed-tts-2.0', audioFormat: 'mp3', sampleRate: 24000, responseMode: 'auto' });
  const request = { text: '测试文本', voiceId: 'test_voice', speed: 1 };

  before(async () => {
    server = http.createServer((incoming, response) => {
      const handler = routes[incoming.url];
      if (handler) return handler(response);
      response.writeHead(404);
      return response.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  test('拼接 NDJSON 分片音频', async () => {
    const result = await synthesize(config('/stream'), request);
    assert.deepEqual(result.buffer, WHOLE);
    assert.equal(result.mime, 'audio/mpeg');
  });

  test('单段 JSON 响应保持可用', async () => {
    assert.deepEqual((await synthesize(config('/single'), request)).buffer, WHOLE);
  });

  test('多行缩进的单个 JSON 对象不被当作 NDJSON', async () => {
    assert.deepEqual((await synthesize(config('/pretty'), request)).buffer, WHOLE);
  });

  test('二进制响应保持可用', async () => {
    const result = await synthesize(config('/binary'), request);
    assert.deepEqual(result.buffer, WHOLE);
    assert.equal(result.mime, 'audio/mpeg');
  });

  test('业务错误码透传服务端原因', async () => {
    await assert.rejects(synthesize(config('/business-error'), request), /3003.*invalid speaker: ghost/);
  });

  test('流中途出错不返回残缺音频', async () => {
    await assert.rejects(synthesize(config('/mid-stream-error'), request), /55000000.*server busy/);
  });

  test('非 JSON 响应报告实际内容', async () => {
    await assert.rejects(synthesize(config('/not-json'), request), /不是有效 JSON.*gateway timeout/);
  });

  test('HTTP 错误状态优先报告', async () => {
    await assert.rejects(synthesize(config('/http-error'), request), /返回 401/);
  });
});

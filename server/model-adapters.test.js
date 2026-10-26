import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import { directableVoiceIds, voiceDirectability } from './directable-voices.js';
import { assertVoiceMatchesResource, synthesize, voiceGeneration, voiceInstructions } from './model-adapters.js';

// Distinct byte patterns per slice keep ordering assertions meaningful, and the
// 256-byte size clears the length heuristic in extractBase64 the way real
// audio chunks do.
const SLICES = ['A', 'B', 'C'].map((mark) => Buffer.alloc(256, mark));
const WHOLE = Buffer.concat(SLICES);

// 契约夹具：豆包 v3 unidirectional 的真实形状——音频分片 code=0，最后一个
// 事件 code=20000000（正常结束）并携带 usage（请求头要求返回用量时）。
const FIXTURE_STREAM = readFileSync(new URL('./fixtures/doubao-v3-stream.ndjson', import.meta.url), 'utf8');
// 固定种子的伪随机数：切块方式每次一样，失败可复现。
let seed = 20261026;
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
function writeInChunks(response, text, size) {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  const next = () => {
    if (offset >= bytes.length) return response.end();
    const end = Math.min(bytes.length, offset + size());
    response.write(bytes.subarray(offset, end));
    offset = end;
    setImmediate(next);
  };
  next();
}
let lastRequest = null;
let apiCalls = 0;

const routes = {
  '/fixture-stream': (response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
    for (const line of FIXTURE_STREAM.split('\n').filter(Boolean)) response.write(`${line}\n`);
    response.end();
  },
  // 流形状鲁棒性（0005）：同一份夹具按不同方式切块/拼接。
  '/fixture-tiny-chunks': (response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
    writeInChunks(response, FIXTURE_STREAM, () => 1 + Math.floor(random() * 7));
  },
  '/fixture-random-chunks': (response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
    writeInChunks(response, FIXTURE_STREAM, () => 1 + Math.floor(random() * 300));
  },
  '/fixture-no-trailing-newline': (response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(FIXTURE_STREAM.trimEnd());
  },
  '/fixture-crlf': (response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(FIXTURE_STREAM.split('\n').filter(Boolean).join('\r\n'));
  },
  '/fixture-concatenated': (response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(FIXTURE_STREAM.split('\n').filter(Boolean).join(''));
  },
  '/fixture-sse': (response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.end(FIXTURE_STREAM.split('\n').filter(Boolean).map((line) => `data: ${line}\n\n`).join(''));
  },
  '/usage-before-end': (response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end([{ code: 0, data: WHOLE.toString('base64') }, { code: 0, data: null, usage: { text_words: 7 } }, { code: 20000000, message: 'OK', data: null }].map((item) => JSON.stringify(item)).join('\n'));
  },
  '/usage-after-end': (response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end([{ code: 0, data: WHOLE.toString('base64') }, { code: 20000000, message: 'OK', data: null }, { code: 0, data: null, usage: { text_words: 9 } }].map((item) => JSON.stringify(item)).join('\n'));
  },
  '/end-without-usage': (response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(`${JSON.stringify({ code: 0, data: WHOLE.toString('base64') })}\n${JSON.stringify({ code: 20000000, message: 'ok', data: null })}\n`);
  },
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
    server = http.createServer(async (incoming, response) => {
      apiCalls += 1;
      let body = '';
      for await (const chunk of incoming) body += chunk;
      lastRequest = { headers: incoming.headers, body };
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

  test('契约：20000000 结束事件视为成功，并返回 usage', async () => {
    const result = await synthesize(config('/fixture-stream'), request);
    assert.deepEqual(result.buffer, WHOLE);
    assert.equal(result.usage.text_words, 4);
    assert.equal(result.usage.billedCharacters, 4);
    assert.equal(lastRequest.headers['x-control-require-usage-tokens-return'], '*');
    assert.equal(lastRequest.headers['x-api-resource-id'], 'seed-tts-2.0');
  });

  test('契约：seed-tts-2.0 指令放在 additions.context_texts，不传 model', async () => {
    await synthesize(config('/fixture-stream'), { ...request, emotion: '悲伤', emotionScale: 0.9 });
    const params = JSON.parse(lastRequest.body).req_params;
    assert.equal(params.model, undefined);
    assert.deepEqual(JSON.parse(params.additions).context_texts, ['用特别特别悲伤的语气说，保持当前基础音色稳定。']);
  });

  for (const path of ['/fixture-tiny-chunks', '/fixture-random-chunks', '/fixture-no-trailing-newline', '/fixture-crlf', '/fixture-concatenated', '/fixture-sse']) {
    test(`流形状 ${path}：音频完整、usage 不丢`, async () => {
      const result = await synthesize(config(path), request);
      assert.deepEqual(result.buffer, WHOLE);
      assert.equal(result.usage?.billedCharacters, 4);
    });
  }

  test('usage 出现在非结束事件里也计入', async () => {
    assert.equal((await synthesize(config('/usage-before-end'), request)).usage?.billedCharacters, 7);
  });

  test('usage 出现在 20000000 之后的独立事件里也计入', async () => {
    assert.equal((await synthesize(config('/usage-after-end'), request)).usage?.billedCharacters, 9);
  });

  test('流结束但没有 usage 时写一条调试日志（只有事件键名，不含密钥）', async () => {
    const original = console.warn;
    const logged = [];
    console.warn = (...args) => logged.push(args.join(' '));
    try { await synthesize(config('/end-without-usage'), request); } finally { console.warn = original; }
    assert.equal(logged.length, 1);
    assert.match(logged[0], /没有 usage/);
    assert.match(logged[0], /code,message,data/);
    assert.doesNotMatch(logged[0], /test-key/);
  });

  test('结束事件没有 usage 时 usage 为 null', async () => {
    const result = await synthesize(config('/end-without-usage'), request);
    assert.deepEqual(result.buffer, WHOLE);
    assert.equal(result.usage, null);
  });

  test('预检：1.0 音色配 seed-tts-2.0 直接失败，不调用接口', async () => {
    const before = apiCalls;
    await assert.rejects(synthesize(config('/fixture-stream'), { ...request, voiceId: 'zh_female_cancan_mars_bigtts' }), (error) => error.code === 'VOICE_MODEL_MISMATCH' && /mars_bigtts.*seed-tts-2\.0/.test(error.message));
    assert.equal(apiCalls, before, '预检失败不应发出请求');
  });
});

describe('音色代际预检', () => {
  test('按后缀识别音色代际', () => {
    assert.equal(voiceGeneration('zh_female_vv_uranus_bigtts'), '2.0');
    assert.equal(voiceGeneration('zh_male_chunhui_mars_bigtts'), '1.0');
    assert.equal(voiceGeneration('zh_female_x_moon_bigtts'), '1.0');
    assert.equal(voiceGeneration('S_abc123'), null);
  });

  test('匹配或无法识别时放行', () => {
    assert.doesNotThrow(() => assertVoiceMatchesResource('seed-tts-2.0', 'zh_female_vv_uranus_bigtts'));
    assert.doesNotThrow(() => assertVoiceMatchesResource('seed-icl-2.0', 'S_abc123'));
    assert.doesNotThrow(() => assertVoiceMatchesResource('seed-tts-2.0', 'test_voice'));
  });

  test('1.0 音色配 2.0 资源报错', () => {
    assert.throws(() => assertVoiceMatchesResource('seed-icl-2.0', 'zh_male_shaun_mars_bigtts'), /不能用于 seed-icl-2\.0/);
  });
});

describe('语音指令措辞（只写情绪 + 节奏）', () => {
  const off = { stableSpeaker: false };
  test('情绪强度映射为口语化程度词', () => {
    assert.deepEqual(voiceInstructions({ emotion: '愤怒', emotionScale: 0.6 }, off), ['用特别愤怒的语气说。']);
    assert.deepEqual(voiceInstructions({ emotion: '开心', emotionScale: 0.2 }, off), ['用略带一点开心的语气说。']);
  });

  test('稳定说话人从句默认开启，可关；没有其他指令时不单独发', () => {
    assert.deepEqual(voiceInstructions({ emotion: '愤怒', emotionScale: 0.6 }), ['用特别愤怒的语气说，保持当前基础音色稳定。']);
    assert.deepEqual(voiceInstructions({ speed: 1 }), []);
  });

  test('语速进入节奏描述，潜台词作为情绪来由', () => {
    assert.deepEqual(voiceInstructions({ emotion: '悲伤', emotionScale: 0.9, speed: 0.85, subtext: '被赶走前最后的哀求' }, off), ['用特别特别悲伤的语气说，语速放慢，句间多停顿一下，这句话的情绪来由是：被赶走前最后的哀求。']);
    assert.deepEqual(voiceInstructions({ speed: 1.2 }, off), ['语速加快，说得紧凑一些。']);
  });

  test('不出现音色类措辞，距离不进指令', () => {
    const [text] = voiceInstructions({ emotion: '悲伤', emotionScale: 0.9, speed: 0.8, distance: '远处' }, off);
    assert.doesNotMatch(text, /音色|耳语|沙哑|哭腔|距离|远处/);
  });

  test('没有导演信息时不发指令', () => {
    assert.deepEqual(voiceInstructions({ speed: 1 }), []);
  });
});

describe('可导戏音色白名单', () => {
  test('vv 实测可导戏，猴哥实测不可，其余未验证', () => {
    assert.equal(voiceDirectability('zh_female_vv_uranus_bigtts'), true);
    assert.equal(voiceDirectability('zh_male_sunwukong_uranus_bigtts'), false);
    assert.equal(voiceDirectability('zh_male_qingcang_uranus_bigtts'), null);
    assert.deepEqual(directableVoiceIds(), ['zh_female_vv_uranus_bigtts']);
  });
});

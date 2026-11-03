import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeNovel, splitNovel } from './story-analyzer.js';

const LLM_CONFIG = { llmEndpoint: 'http://llm.local', llmApiKey: 'k', llmModel: 'm' };

test('分块：单换行分段的小说在段落边界切分', () => {
  const paragraphs = Array.from({ length: 200 }, (_unused, index) => `第${index + 1}段。${'叙述文字。'.repeat(20)}`);
  const chunks = splitNovel(paragraphs.join('\n'), 1000);
  assert.ok(chunks.length > 1, '应切分为多块');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1000, `块不应超长: ${chunk.length}`);
    assert.ok(/。$/.test(chunk), '块应在段落边界结束，不应从句子中间断开');
  }
});

test('分块：换行结构在块内保留', () => {
  const chunks = splitNovel('第一段。\n\n第二段。', 1000);
  assert.deepEqual(chunks, ['第一段。\n\n第二段。']);
});

test('未配置文本模型：导入直接报错，不再退回规则拆解', async () => {
  await assert.rejects(
    () => analyzeNovel({}, { text: '雨下了整夜。', filename: 'demo.txt' }, {}),
    (error) => error.code === 'LLM_CONFIG_INVALID' && error.status === 400,
  );
});

test('文本模型超时：不自动重试，直接失败', async () => {
  const aborted = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  let calls = 0;
  await assert.rejects(
    () => analyzeNovel(LLM_CONFIG, { text: '雨下了整夜。', filename: 'n.txt' }, {
      retryDelayMs: 1,
      call: async () => { calls += 1; throw aborted; },
    }),
    /aborted/,
  );
  assert.equal(calls, 1, '超时不应再自动重试一次');
});

test('seedCharacters：后续分块沿用已有角色表', async () => {
  const prompts = [];
  await analyzeNovel(LLM_CONFIG, {
    text: '雨下了整夜。',
    filename: 'n.txt',
    seedCharacters: [{ id: 'tangseng', name: '唐僧', role: '师父' }],
  }, {
    call: async (_config, prompt) => {
      prompts.push(prompt);
      return { project: { genre: '' }, characters: [], scenes: [{ title: '场景', lines: [{ type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text: '台词' }] }] };
    },
  });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /已确认角色表/);
  assert.match(prompts[0], /tangseng/);
});

test('拆解断点续跑：失败后从已完成分块继续，不重付前段', async () => {
  const text = Array.from({ length: 300 }, (_, index) => `第${index}段。林深说：「风向变了。」`).join('\n');
  const totalChunks = splitNovel(text, 500).length;
  assert.ok(totalChunks >= 4, '测试文本应至少切出 4 个分块');
  const sceneOf = (index) => ({ project: { genre: '悬疑' }, characters: [], scenes: [{ title: `场景${index}`, lines: [{ type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text: `第${index}段台词` }] }] });
  let checkpoint = null;
  let brokenChunk = true;
  const firstRunCalls = [];
  await assert.rejects(
    analyzeNovel(LLM_CONFIG, { text, filename: 'n.txt', name: '作品' }, {
      chunkChars: 500, retryDelayMs: 10,
      call: async (_config, source) => { firstRunCalls.push(source); if (brokenChunk && firstRunCalls.length >= 2) throw new Error('第二段失败'); return sceneOf(firstRunCalls.length - 1); },
      onCheckpoint: (value) => { checkpoint = value; },
    }),
    /第二段失败/,
  );
  assert.ok(firstRunCalls.length >= 3, '失败分块应先经历一次自动重试');
  brokenChunk = false;
  assert.equal(checkpoint.chunksDone, 1);
  assert.equal(checkpoint.merged.scenes.length, 1);

  const resumeCalls = [];
  const resumed = await analyzeNovel(LLM_CONFIG, { text, filename: 'n.txt', name: '作品' }, {
    chunkChars: 500, retryDelayMs: 10,
    resume: checkpoint,
    call: async () => { resumeCalls.push(1); return sceneOf(resumeCalls.length + 1); },
  });
  assert.equal(resumeCalls.length, totalChunks - 1, '只应重打未完成的分块');
  assert.equal(resumed.breakdown, 'llm');
  assert.equal(resumed.scenes.length, totalChunks, '断点前的场景与续跑场景全部保留');
});

test('拆解分块自动重试：瞬时失败重打一次后成功', async () => {
  const text = Array.from({ length: 80 }, (_, index) => `第${index}段。她说：「再来一次。」`).join('\n');
  let failures = 0;
  const calls = [];
  const result = await analyzeNovel(LLM_CONFIG, { text, filename: 'n.txt', name: '作品' }, {
    chunkChars: 500,
    retryDelayMs: 10,
    call: async () => {
      calls.push(1);
      if (calls.length === 1) { failures += 1; throw new Error('网络抖动'); }
      return { project: { genre: '' }, characters: [], scenes: [{ title: '场景', lines: [{ type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text: '台词' }] }] };
    },
  });
  assert.equal(failures, 1);
  assert.equal(calls.length, splitNovel(text, 500).length + 1, '第一分块重打了一次');
  assert.equal(result.breakdown, 'llm');
});

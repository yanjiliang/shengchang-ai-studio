import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeNovel, heuristicAnalysis, splitNovel } from './story-analyzer.js';

// No LLM fields -> validateLlmConfig fails -> heuristic path engages.
const NO_LLM_CONFIG = {};

test('规则拆解：无引号段落全部归为旁白', async () => {
  const result = await analyzeNovel(NO_LLM_CONFIG, { text: '雨下了整夜。\n\n旅馆的灯还亮着。\n\n没有人来开门。', filename: 'demo.txt' }, {});
  assert.equal(result.breakdown, 'heuristic');
  assert.ok(result.scenes.length >= 1);
  for (const scene of result.scenes) {
    for (const line of scene.lines) {
      assert.equal(line.speakerId, 'narrator');
      assert.equal(line.speaker, '旁白');
    }
  }
});

test('规则拆解：引号前说话人归属正确', async () => {
  const result = await analyzeNovel(NO_LLM_CONFIG, { text: '林夏低声说道：「你终于来了。」', filename: 'demo.txt' }, {});
  const dialogue = result.scenes[0].lines.filter((line) => line.type === 'dialogue');
  const spoken = dialogue.find((line) => line.text === '你终于来了。');
  assert.ok(spoken, '引号内容应成为台词');
  assert.equal(spoken.speaker, '林夏');
  assert.equal(spoken.speakerId, '林夏');
  assert.ok(result.characters.some((character) => character.name === '林夏'));
  // 归属短语本身不应再以旁白形式重复出现。
  assert.ok(!dialogue.some((line) => line.text.includes('说道')), '归属短语不应进入台词');
});

test('规则拆解：引号后说话人归属正确', async () => {
  const result = await analyzeNovel(NO_LLM_CONFIG, { text: '「路上堵了。」王五叹道。', filename: 'demo.txt' }, {});
  const spoken = result.scenes[0].lines.find((line) => line.text === '路上堵了。');
  assert.equal(spoken.speakerId, '王五');
});

test('规则拆解：代词指向最近说话人', async () => {
  const text = '王五说：「我到了。」\n\n他答道：「先上去等。」';
  const result = await analyzeNovel(NO_LLM_CONFIG, { text, filename: 'demo.txt' }, {});
  const spoken = result.scenes.flatMap((scene) => scene.lines).filter((line) => line.text === '先上去等。');
  assert.equal(spoken.length, 1);
  assert.equal(spoken[0].speakerId, '王五');
});

test('规则拆解：未归属对白归为旁白', async () => {
  const result = await analyzeNovel(NO_LLM_CONFIG, { text: '「到底是谁？」', filename: 'demo.txt' }, {});
  const spoken = result.scenes.flatMap((scene) => scene.lines).find((line) => line.text.includes('到底是谁'));
  assert.ok(spoken);
  assert.equal(spoken.speakerId, 'narrator');
});

test('规则拆解：按章节标题切分场景', async () => {
  const text = '第一章 旧旅馆\n\n雨夜。\n\n第二章 灯\n\n灯亮了。';
  const result = await analyzeNovel(NO_LLM_CONFIG, { text, filename: 'demo.txt' }, {});
  assert.equal(result.scenes.length, 2);
  assert.equal(result.scenes[0].title, '第一章 旧旅馆');
  assert.equal(result.scenes[1].title, '第二章 灯');
});

test('规则拆解：无章节时按段落分组多个场景', () => {
  const paragraphs = Array.from({ length: 100 }, (_unused, index) => `第${index + 1}段叙述文字。`);
  const result = heuristicAnalysis(paragraphs.join('\n\n'), 'demo');
  assert.ok(result.scenes.length >= 2, '应切分为多个场景');
});

test('规则拆解：长叙述切成适合合成的短句', () => {
  const long = '这是一句很长的话。'.repeat(60);
  const result = heuristicAnalysis(long, 'demo');
  const narrations = result.scenes.flatMap((scene) => scene.lines).map((line) => line.text);
  assert.ok(narrations.length > 1);
  assert.ok(narrations.every((text) => text.length <= 180), `每句不应过长: ${Math.max(...narrations.map((text) => text.length))}`);
});

test('规则拆解：英文直引号对白归属正确', async () => {
  const result = await analyzeNovel(NO_LLM_CONFIG, { text: '林夏低声说道："你终于来了。"\n"路上堵了。"王五叹道。', filename: 'demo.txt' }, {});
  const lines = result.scenes.flatMap((scene) => scene.lines).filter((line) => line.type === 'dialogue');
  const first = lines.find((line) => line.text === '你终于来了。');
  const second = lines.find((line) => line.text === '路上堵了。');
  assert.ok(first, '直引号内容应成为台词');
  assert.equal(first.speakerId, '林夏');
  assert.equal(second?.speakerId, '王五');
  assert.ok(!lines.some((line) => line.text.includes('说道')), '归属短语不应进入台词');
});

test('规则拆解：直引号中的知道不误判为说话人', async () => {
  const result = await analyzeNovel(NO_LLM_CONFIG, { text: '"我知道你会来。"她说。', filename: 'demo.txt' }, {});
  assert.ok(!result.characters.some((character) => character.name.includes('知道')));
  const spoken = result.scenes.flatMap((scene) => scene.lines).find((line) => line.text === '我知道你会来。');
  assert.ok(spoken, '直引号内容应成为台词');
});

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

test('拆解断点续跑：失败后从已完成分块继续，不重付前段', async () => {
  const config = { llmEndpoint: 'http://llm.local', llmApiKey: 'k', llmModel: 'm' };
  const text = Array.from({ length: 300 }, (_, index) => `第${index}段。林深说：「风向变了。」`).join('\n');
  const totalChunks = splitNovel(text, 500).length;
  assert.ok(totalChunks >= 4, '测试文本应至少切出 4 个分块');
  const sceneOf = (index) => ({ project: { genre: '悬疑' }, characters: [], scenes: [{ title: `场景${index}`, lines: [{ type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text: `第${index}段台词` }] }] });
  let checkpoint = null;
  let brokenChunk = true;
  const firstRunCalls = [];
  await assert.rejects(
    analyzeNovel(config, { text, filename: 'n.txt', name: '作品' }, {
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
  const resumed = await analyzeNovel(config, { text, filename: 'n.txt', name: '作品' }, {
    chunkChars: 500, retryDelayMs: 10,
    resume: checkpoint,
    call: async (_config, source) => { resumeCalls.push(source); return sceneOf(resumeCalls.length + 1); },
  });
  assert.equal(resumeCalls.length, totalChunks - 1, '只应重打未完成的分块');
  assert.equal(resumed.breakdown, 'llm');
  assert.equal(resumed.scenes.length, totalChunks, '断点前的场景与续跑场景全部保留');
});

test('拆解分块自动重试：瞬时失败重打一次后成功', async () => {
  const config = { llmEndpoint: 'http://llm.local', llmApiKey: 'k', llmModel: 'm' };
  const text = Array.from({ length: 80 }, (_, index) => `第${index}段。她说：「再来一次。」`).join('\n');
  let failures = 0;
  const calls = [];
  const result = await analyzeNovel(config, { text, filename: 'n.txt', name: '作品' }, {
    chunkChars: 500,
    retryDelayMs: 10,
    call: async (_config, source) => {
      calls.push(source);
      if (calls.length === 1) { failures += 1; throw new Error('网络抖动'); }
      return { project: { genre: '' }, characters: [], scenes: [{ title: '场景', lines: [{ type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text: '台词' }] }] };
    },
  });
  assert.equal(failures, 1);
  assert.equal(calls.length, splitNovel(text, 500).length + 1, '第一分块重打了一次');
  assert.equal(result.breakdown, 'llm');
});

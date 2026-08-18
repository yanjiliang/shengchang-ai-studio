import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeNovel, heuristicAnalysis } from './story-analyzer.js';

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

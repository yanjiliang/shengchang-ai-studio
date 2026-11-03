import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeAppendedAnalysis } from './append-analysis.js';

const previous = {
  characters: [
    { id: 'narrator', name: '旁白', role: '叙事者' },
    { id: 'tangseng', name: '唐僧', role: '师父', gender: '男', genderSource: 'user' },
    { id: 'old-only', name: '旧角色', role: '路人' },
  ],
};

test('追加导入：按姓名复用旧角色 id，保留未出场角色，旁白固定 narrator', () => {
  const merged = mergeAppendedAnalysis(previous, {
    characters: [
      { id: 'llm-tangseng', name: '唐僧', role: '取经人', gender: '男' },
      { id: 'llm-wukong', name: '孙悟空', role: '徒弟' },
    ],
    scenes: [{
      title: '第一章',
      lines: [
        { type: 'dialogue', speaker: '唐僧', speakerId: 'llm-tangseng', text: '走吧。' },
        { type: 'dialogue', speaker: '孙悟空', speakerId: 'llm-wukong', text: '好。' },
        { type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text: '山门。' },
      ],
    }],
  });
  assert.deepEqual(merged.characters.map((character) => character.id), ['narrator', 'tangseng', 'old-only', 'llm-wukong']);
  assert.equal(merged.characters.find((character) => character.id === 'tangseng').role, '取经人');
  assert.equal(merged.characters.find((character) => character.id === 'tangseng').genderSource, 'user');
  assert.equal(merged.scenes[0].lines[0].speakerId, 'tangseng');
  assert.equal(merged.scenes[0].lines[1].speakerId, 'llm-wukong');
  assert.equal(merged.scenes[0].lines[2].speakerId, 'narrator');
});

test('追加导入：用姓名当 id 也能映射到已有角色', () => {
  const merged = mergeAppendedAnalysis(
    { characters: [{ id: 'tangseng', name: '唐僧' }] },
    {
      characters: [{ id: '唐僧', name: '唐僧' }],
      scenes: [{ lines: [{ type: 'dialogue', speaker: '唐僧', speakerId: '唐僧', text: '走。' }] }],
    },
  );
  assert.equal(merged.characters.length, 1);
  assert.equal(merged.characters[0].id, 'tangseng');
  assert.equal(merged.scenes[0].lines[0].speakerId, 'tangseng');
});

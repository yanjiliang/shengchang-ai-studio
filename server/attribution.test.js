import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAttribution } from './attribution.js';

const builtinIndex = new Map([
  ['builtin-ambient-rain-light', { id: 'builtin-ambient-rain-light', name: '小雨 · 屋檐', origin: 'synthesized' }],
  ['builtin-music-pad-warm', { id: 'builtin-music-pad-warm', name: '温暖 · 柔光和声', origin: 'synthesized' }],
]);
const assets = [
  { id: 'gen-abc', name: '远处汽笛', source: 'generated', prompt: '远处轮船汽笛，悠长', provider: 'demo' },
  { id: 'up-1', name: '自录酒馆人声', source: 'upload' },
];
const lines = [
  { type: 'ambient', assetId: 'builtin-ambient-rain-light' },
  { type: 'music', assetId: 'builtin-music-pad-warm' },
  { type: 'sfx', assetId: 'gen-abc' },
  { type: 'sfx', assetId: 'up-1' },
  { type: 'dialogue', assetId: 'builtin-ambient-rain-light' },
];

test('来源清单：三源分组，对白不参与，去重', () => {
  const text = buildAttribution({ lines, assets, builtinIndex });
  assert.match(text, /内置素材（CC0/);
  assert.match(text, /AI 生成素材/);
  assert.match(text, /本地导入素材/);
  assert.match(text, /小雨 · 屋檐/);
  assert.match(text, /生成描述：远处轮船汽笛，悠长/);
  assert.equal((text.match(/小雨 · 屋檐/g) || []).length, 1, '同一素材只列一次');
});

test('来源清单：无素材时给出说明', () => {
  const text = buildAttribution({ lines: [{ type: 'dialogue' }], assets: [], builtinIndex });
  assert.match(text, /未使用任何声音素材/);
});

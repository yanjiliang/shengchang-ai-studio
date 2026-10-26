import test from 'node:test';
import assert from 'node:assert/strict';
import { labVariantRequest, normalizeLinePatch, numericIntensity } from './direction-lab.js';
import { buildGenerationRequest, emotionScaleFor } from '../../shared/generation-requests.mjs';

const line0 = { id: 'l1', speakerId: 'a', text: '你好', emotion: '平静', intensity: 0, pace: 90 };
const line40 = { ...line0, intensity: 40 };
const base = (line) => buildGenerationRequest(line, { a: 'v1' });

test('方向实验：Breeze 变体强度 0 → emotionOff true', () => {
  const r = labVariantRequest(base(line40), { emotion: '平静', intensity: 0 }, 'breeze');
  assert.equal(r.emotionOff, true);
  assert.equal(r.emotionScale, emotionScaleFor(0));
});

test('方向实验：Breeze 变体强度 40 → emotionOff false', () => {
  assert.equal(labVariantRequest(base(line40), { emotion: '愤怒', intensity: 40 }, 'breeze').emotionOff, false);
});

test('方向实验：台词强度 0、变体 60 → emotionOff false（不从台词漏进来）', () => {
  const src = base(line0);
  assert.equal(src.emotionOff, true);
  const r = labVariantRequest(src, { emotion: '愤怒', intensity: 60 }, 'breeze');
  assert.equal(r.emotionOff, false);
  assert.equal(r.emotionScale, 0.6);
});

test('方向实验：豆包 / 自定义变体强度 0 → emotionOff false，emotionScale 照 emotionScaleFor（0.4，不是 0.1）', () => {
  for (const provider of ['volcengine-api-key', 'custom']) {
    const r = labVariantRequest(base(line0), { emotion: '平静', intensity: 0 }, provider);
    assert.equal(r.emotionOff, false);
    assert.equal(r.emotionScale, emotionScaleFor(0));
  }
  // 字符串 "0" 也先转成数字，不会落到旧规则
  assert.equal(labVariantRequest(base(line40), { intensity: '0' }, 'volcengine-api-key').emotionScale, emotionScaleFor(0));
});

test('强度按数字序列化：0 是 0 而不是 "0"', () => {
  assert.equal(numericIntensity('0'), 0);
  assert.equal(numericIntensity(0), 0);
  assert.equal(numericIntensity(undefined), undefined);
  const patch = normalizeLinePatch({ intensity: '0' });
  assert.equal(JSON.stringify(patch), '{"intensity":0}');
  assert.deepEqual(normalizeLinePatch({ text: 'x' }), { text: 'x' });
  assert.match(JSON.stringify(labVariantRequest(base(line40), { intensity: '0' }, 'breeze')), /"emotionOff":true/);
});

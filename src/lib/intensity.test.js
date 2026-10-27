import test from 'node:test';
import assert from 'node:assert/strict';
import { intensityOf, isNoEmotion } from './intensity.js';

test('情绪强度 0 保留为 0（不加情绪），缺省才用 40，超过 100 夹到 100', () => {
  assert.equal(intensityOf(0), 0);
  assert.equal(intensityOf('0'), 0);
  assert.equal(isNoEmotion(0), true);
  assert.equal(intensityOf(undefined), 40);
  assert.equal(intensityOf(null), 40);
  assert.equal(intensityOf(''), 40);
  assert.equal(intensityOf('abc'), 40);
  assert.equal(intensityOf(140), 100);
  assert.equal(intensityOf(-5), 0);
  assert.equal(intensityOf(65), 65);
});

test('强度 0：只有 Breeze 说「不加情绪」，豆包如实显示 0', async () => {
  const { showsNoEmotion } = await import('./intensity.js');
  assert.equal(showsNoEmotion(0, 'breeze'), true);
  assert.equal(showsNoEmotion('0', 'breeze'), true);
  assert.equal(showsNoEmotion(0, 'volcengine-api-key'), false);
  assert.equal(showsNoEmotion(undefined, 'breeze'), false); // 没填 = 40，不是 0
  assert.equal(showsNoEmotion(5, 'breeze'), false);
});

test('ScriptLine / SceneCanvas 的强度显示保留 0', async () => {
  const { deliveryLabel } = await import('../components/studio/delivery-label.js');
  assert.equal(deliveryLabel({ emotion: '平静', intensity: 0, pace: 100 }, 'breeze'), '不加情绪 · 语速 1.00');
  assert.equal(deliveryLabel({ emotion: '平静', intensity: 0, pace: 100 }, 'volcengine-api-key'), '平静 0% · 语速 1.00');
  assert.equal(deliveryLabel({ emotion: '平静', pace: 90 }, 'breeze'), '平静 40% · 语速 0.90');
});

test('强度 0 的提示：Breeze「不加情绪」，豆包「按 40 处理」', async () => {
  const { zeroIntensityHint } = await import('./intensity.js');
  assert.equal(zeroIntensityHint(0, 'breeze'), '不加情绪');
  assert.equal(zeroIntensityHint(0, 'volcengine-api-key'), '豆包上强度 0 按 40 处理');
  assert.equal(zeroIntensityHint(30, 'volcengine-api-key'), '');
  assert.equal(zeroIntensityHint(0, 'demo'), '');
});

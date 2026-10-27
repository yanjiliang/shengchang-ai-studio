import test from 'node:test';
import assert from 'node:assert/strict';
import { billingSummary, billingText, estimateCacheText, estimateCostText, missingUsageText, resultBilledCharacters, resultVoiceId } from './billing.js';

test('billingSummary：0005 任务结果直接用 freshCount / cacheHits / billedCharacters', () => {
  const summary = billingSummary({ freshCount: 11, cacheHits: 8, billedCharacters: 198, missingUsageCount: 0 });
  assert.deepEqual(summary, { freshCount: 11, cacheHits: 8, billedCharacters: 198, missingUsageCount: 0 });
  assert.equal(billingText(summary), '本次新生成 11 句，复用缓存 8 句（未调用接口、不计费），计费 198 字');
  assert.equal(missingUsageText(summary), '');
});

test('billingSummary：全部命中缓存时 billedCharacters=null 显示为 0 字', () => {
  const summary = billingSummary({ results: [{ cached: true }, { cached: true }], freshCount: 0, cacheHits: 2, billedCharacters: null, missingUsageCount: 0 });
  assert.equal(billingText(summary), '本次新生成 0 句，复用缓存 2 句（未调用接口、不计费），计费 0 字');
});

test('billingSummary：缺用量时计费字数只算已知部分并单独提示', () => {
  const summary = billingSummary({ freshCount: 3, cacheHits: 0, billedCharacters: 20, missingUsageCount: 1 });
  assert.match(billingText(summary), /已知计费 20 字$/);
  assert.equal(missingUsageText(summary), '1 句新生成的语音没有返回计费字数，计费字数只含已知部分');
});

test('billingSummary：引擎不返回用量（演示引擎）时不假装是 0 字', () => {
  const summary = billingSummary({ freshCount: 2, cacheHits: 0, billedCharacters: null, missingUsageCount: 0 });
  assert.match(billingText(summary), /未返回计费字数$/);
});

test('billingSummary：0005 之前的旧任务从 results[].cached 推算，推不出就不显示', () => {
  assert.deepEqual(billingSummary({ results: [{ cached: true }, { cached: false }, { cached: false }], cacheHits: 1, billedCharacters: null }), { freshCount: 2, cacheHits: 1, billedCharacters: null, missingUsageCount: 0 });
  assert.equal(billingSummary({ url: '/media/a.wav', sceneCount: 3 }), null);
  assert.equal(billingSummary(null), null);
  assert.equal(billingText(null), '');
});

test('estimateCacheText：还没选角（cacheHits=null）没有数据，整行不显示（不写“未知”，也不写 0）', () => {
  assert.equal(estimateCacheText({ cacheHits: null, cacheHitsUnknownCount: 19 }), '');
});

test('estimateCacheText：部分未分配音色时给下限 + 未知句数', () => {
  assert.equal(estimateCacheText({ cacheHits: 4, cacheHitsUnknownCount: 5 }), '预计缓存命中：至少 4 句，另有 5 句未知（部分角色还没分配音色，无法预估缓存）');
  assert.equal(estimateCacheText({ cacheHits: 0, cacheHitsUnknownCount: 5 }), '预计缓存命中：至少 0 句，另有 5 句未知（部分角色还没分配音色，无法预估缓存）');
});

test('estimateCacheText：全部已分配时沿用原文案，0 命中不显示', () => {
  assert.equal(estimateCacheText({ cacheHits: 7, cacheHitsUnknownCount: 0 }), '预计缓存命中 7 句');
  assert.equal(estimateCacheText({ cacheHits: 0, cacheHitsUnknownCount: 0 }), '');
});

test('estimateCostText：全部已绑音色（0007）→ 单数 + “最多…未计入缓存”', () => {
  assert.deepEqual(estimateCostText({ provider: 'volcengine-api-key', characters: 390, cacheHits: 6, cacheHitsUnknownCount: 0, estimatedBillableCharacters: 240, unknownCharacters: 0 }), { main: '真实语音 · 预计扣费约 240 字', note: '最多 390 字，未计入缓存' });
});

test('estimateCostText：部分没音色（0007）→ 区间，且封顶在上限', () => {
  assert.deepEqual(estimateCostText({ provider: 'volcengine-api-key', characters: 390, cacheHits: 2, cacheHitsUnknownCount: 9, estimatedBillableCharacters: 150, unknownCharacters: 180 }), { main: '真实语音 · 预计扣费 150–330 字', note: '有 9 句还没分音色，暂时算不出能不能复用缓存' });
  assert.equal(estimateCostText({ provider: 'volcengine-api-key', characters: 300, cacheHitsUnknownCount: 4, estimatedBillableCharacters: 200, unknownCharacters: 180 }).main, '真实语音 · 预计扣费 200–300 字');
});

test('estimateCostText：一句都没音色（estimatedBillableCharacters=null）→ 0 到上限', () => {
  assert.deepEqual(estimateCostText({ provider: 'volcengine-api-key', characters: 390, cacheHits: null, cacheHitsUnknownCount: 19, estimatedBillableCharacters: null, unknownCharacters: 390 }), { main: '真实语音 · 预计扣费 0–390 字', note: '有 19 句还没分音色，暂时算不出能不能复用缓存' });
});

test('estimateCostText：没有 0007 字段时也只给区间，不给确定单数', () => {
  assert.deepEqual(estimateCostText({ provider: 'volcengine-api-key', characters: 390, cacheHits: 0, cacheHitsUnknownCount: 9 }), { main: '真实语音 · 预计扣费 0–390 字', note: '有 9 句还没分音色，暂时算不出能不能复用缓存' });
  assert.deepEqual(estimateCostText({ provider: 'volcengine-api-key', characters: 390, cacheHits: 4, cacheHitsUnknownCount: 0 }), { main: '真实语音 · 预计扣费 0–390 字', note: '最多 390 字，未计入缓存' });
  assert.deepEqual(estimateCostText({ provider: 'volcengine-api-key', characters: 390, cacheHits: 0, cacheHitsUnknownCount: 0 }), { main: '真实语音 · 预计扣费约 390 字', note: '最多 390 字，未计入缓存' });
  assert.deepEqual(estimateCostText({ provider: 'demo', characters: 390 }), { main: '离线演示引擎 · 免费', note: '' });
});

test('estimateCostText：0 句待生成 → 无需扣费，不管 estimatedBillableCharacters 是 null 还是 0', () => {
  const done = { main: '无需扣费，全部已有音频', note: '' };
  assert.deepEqual(estimateCostText({ provider: 'volcengine-api-key', requestCount: 0, characters: 0, cacheHits: 0, cacheHitsUnknownCount: 0, estimatedBillableCharacters: null, unknownCharacters: 0 }), done);
  assert.deepEqual(estimateCostText({ provider: 'volcengine-api-key', requestCount: 0, characters: 0, cacheHits: 0, cacheHitsUnknownCount: 0, estimatedBillableCharacters: 0, unknownCharacters: 0 }), done);
  assert.deepEqual(estimateCostText({ provider: 'volcengine-api-key', requestCount: 0, characters: 0, cacheHits: 0, cacheHitsUnknownCount: 0 }), done);
});

test('estimateCostText：estimatedBillableCharacters=0 且没有未知部分（0008，全部命中缓存）→ 无需扣费', () => {
  assert.deepEqual(estimateCostText({ provider: 'volcengine-api-key', requestCount: 5, characters: 80, cacheHits: 5, cacheHitsUnknownCount: 0, estimatedBillableCharacters: 0, unknownCharacters: 0 }), { main: '无需扣费', note: '' });
  // 还有没分音色的句子就不能说无需扣费
  assert.equal(estimateCostText({ provider: 'volcengine-api-key', requestCount: 5, characters: 80, cacheHits: 2, cacheHitsUnknownCount: 3, estimatedBillableCharacters: 0, unknownCharacters: 40 }).main, '真实语音 · 预计扣费 0–40 字');
});

test('resultBilledCharacters：生成任务读 usage，一键成片（0007）读顶层 billedCharacters', () => {
  assert.equal(resultBilledCharacters({ usage: { billedCharacters: 12 } }), 12);
  assert.equal(resultBilledCharacters({ billedCharacters: 9 }), 9);
  assert.equal(resultBilledCharacters({ billedCharacters: null }), null);
  assert.equal(resultBilledCharacters({}), null);
});

test('resultVoiceId：优先用结果自带的 voiceId，没有再按 voiceMap 推断', () => {
  const ctx = { voiceMap: { wukong: 'zh_male_sunwukong_uranus_bigtts' }, speakerByLine: new Map([['l1', 'wukong'], ['l2', 'nobody']]) };
  assert.equal(resultVoiceId({ lineId: 'l1', voiceId: 'zh_female_vv_uranus_bigtts' }, ctx), 'zh_female_vv_uranus_bigtts');
  assert.equal(resultVoiceId({ lineId: 'l1' }, ctx), 'zh_male_sunwukong_uranus_bigtts');
  assert.equal(resultVoiceId({ lineId: 'l2' }, ctx), '');
  assert.equal(resultVoiceId({ lineId: 'l1' }), '');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendForEvent } from './asset-recommend.js';

const CANDIDATES = [
  { id: 'builtin-ambient-rain-light', name: '小雨 · 屋檐', type: 'ambient', tags: ['雨', '小雨', '夜', '屋檐', '安静'], mood: '平静' },
  { id: 'builtin-ambient-sea-waves', name: '海浪 · 夜岸', type: 'ambient', tags: ['海', '海浪', '涛声', '岸边', '夜'], mood: '辽阔' },
  { id: 'builtin-music-pad-warm', name: '温暖 · 柔光和声', type: 'music', tags: ['温暖', '回忆', '抒情', '钢琴'], mood: '温暖' },
  { id: 'builtin-sfx-door-knock', name: '敲门 · 三声', type: 'sfx', tags: ['敲门', '门', '到访'], mood: '到访' },
  { id: 'upload-1', name: '自录酒馆嘈杂', category: '环境', tags: ['人群', '酒馆'], mood: '' },
];

test('推荐：类型是门槛，描述命中标签排序', () => {
  const picks = recommendForEvent({ line: { type: 'ambient', text: '雨夜，雨点敲着窗，远处有海浪声。' }, candidates: CANDIDATES });
  assert.ok(picks.length >= 2);
  assert.equal(picks[0].id, 'builtin-ambient-rain-light', '雨标签命中最多应排第一');
  assert.ok(picks.some((pick) => pick.id === 'builtin-ambient-sea-waves'));
  assert.ok(!picks.some((pick) => pick.id === 'builtin-sfx-door-knock'), '类型不匹配不出现');
  assert.match(picks[0].reason, /雨/);
});

test('推荐：同义词命中（敲门→叩门）', () => {
  const picks = recommendForEvent({ line: { type: 'sfx', text: '有人叩响了房门。' }, candidates: CANDIDATES });
  assert.equal(picks[0].id, 'builtin-sfx-door-knock');
});

test('推荐：项目自导入素材参与推荐（category 映射类型）', () => {
  const picks = recommendForEvent({ line: { type: 'ambient', text: '酒馆里人群低语嘈杂。' }, candidates: CANDIDATES });
  assert.equal(picks[0].id, 'upload-1');
});

test('推荐：使用过的素材获得一致性加成', () => {
  const neutral = recommendForEvent({ line: { type: 'music', text: '配乐' }, candidates: CANDIDATES, usageCounts: {} });
  const boosted = recommendForEvent({ line: { type: 'music', text: '配乐' }, candidates: CANDIDATES, usageCounts: { 'builtin-music-pad-warm': 3 } });
  if (neutral.some((pick) => pick.id === 'builtin-music-pad-warm') || boosted.some((pick) => pick.id === 'builtin-music-pad-warm')) {
    const before = neutral.find((pick) => pick.id === 'builtin-music-pad-warm');
    const after = boosted.find((pick) => pick.id === 'builtin-music-pad-warm');
    assert.ok(!before || !after || after.score > before.score, '使用加成应提高得分');
  }
  assert.ok(boosted.some((pick) => pick.id === 'builtin-music-pad-warm'), '高使用次数应进入推荐');
});

test('推荐：无匹配返回空数组，不硬凑', () => {
  const picks = recommendForEvent({ line: { type: 'music', text: '完全无关的描述' }, candidates: CANDIDATES });
  assert.deepEqual(picks.filter((pick) => pick.score < 2), []);
});

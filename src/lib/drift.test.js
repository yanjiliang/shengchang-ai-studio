import test from 'node:test';
import assert from 'node:assert/strict';
import { acknowledgePatch, driftLabel, driftState, driftTooltip, filterReviewLines, isShortLine, roleDriftSummaries, typicalLine, undoAcknowledgePatch } from './drift.js';

const drift = (score, flagged, extra = {}) => ({ score, flagged, method: 'mfcc13-zscore-loo@v1', baselineLines: ['a', 'b'], nearestRoleId: 'zhubajie', reasons: flagged ? ['drift', 'nearest_other'] : [], voiceId: 'v', ...extra });
const line = (id, speakerId, voiceDrift, extra = {}) => ({ id, type: 'dialogue', speakerId, text: id, audioUrl: `/media/${id}.wav`, audioHash: `h-${id}`, voiceDrift, ...extra });
const names = { sunwukong: '孙悟空', zhubajie: '猪八戒', laoyu: '老妪' };
const nameOf = (id) => names[id];

test('driftState：没音频 / 等待复检 / 样本不足 / 一致 / 偏离 / 已保持原样', () => {
  assert.equal(driftState({ id: 'x' }), 'none');
  assert.equal(driftState(line('l1', 'sunwukong', null)), 'pending');
  assert.equal(driftState(line('l1', 'shaonv', drift(null, false, { reasons: [] }))), 'insufficient');
  assert.equal(driftState(line('l1', 'sunwukong', drift(2.49, false))), 'consistent');
  assert.equal(driftState(line('l11', 'sunwukong', drift(5.17, true))), 'drift');
  assert.equal(driftState(line('l11', 'sunwukong', drift(5.17, true), { driftAcknowledgedHash: 'h-l11' })), 'acknowledged');
  // 重渲后 audioHash 变了，确认自动失效。
  assert.equal(driftState(line('l11', 'sunwukong', drift(5.17, true), { driftAcknowledgedHash: 'old-hash' })), 'drift');
  // voiceDrift 带了 audioHash 且对不上当前音频 → 等待复检。
  assert.equal(driftState(line('l11', 'sunwukong', drift(5.17, true, { audioHash: 'old' }))), 'pending');
});

test('保持原样 / 撤销', () => {
  const item = line('l13', 'sunwukong', drift(5.9, true));
  assert.deepEqual(acknowledgePatch(item), { driftAcknowledgedHash: 'h-l13' });
  assert.deepEqual(undoAcknowledgePatch(), { driftAcknowledgedHash: null });
});

test('标记文案：听起来像 X；分数只在提示里；短句加提示', () => {
  const item = line('l11', 'sunwukong', drift(5.17, true, { reasons: ['drift', 'nearest_other', 'short_line'] }));
  assert.equal(driftLabel(item, nameOf), '音色偏离 · 听起来像猪八戒');
  assert.doesNotMatch(driftLabel(item, nameOf), /5\.17/);
  assert.match(driftTooltip(item, nameOf), /偏离分 5\.17/);
  assert.match(driftTooltip(item, nameOf), /短句，结果仅供参考/);
  assert.equal(isShortLine(item), true);
  assert.equal(driftLabel(line('x', 'sunwukong', drift(5, true, { nearestRoleId: 'sunwukong' })), nameOf), '音色偏离');
});

test('角色汇总：孙悟空 · 5 句中 2 句偏离；已保持原样不算', () => {
  const lines = [
    line('l03', 'sunwukong', drift(2.49, false)), line('l06', 'sunwukong', drift(2.8, false)),
    line('l11', 'sunwukong', drift(5.17, true)), line('l13', 'sunwukong', drift(5.9, true)), line('l17', 'sunwukong', drift(3.0, false)),
    line('l09', 'laoyu', drift(null, false, { reasons: [] })), { id: 'n', type: 'dialogue', speakerId: 'sunwukong', text: '未渲染' },
  ];
  const summaries = roleDriftSummaries(lines, [{ id: 'sunwukong', name: '孙悟空' }, { id: 'laoyu', name: '老妪' }]);
  assert.equal(summaries[0].text, '孙悟空 · 5 句中 2 句偏离');
  assert.deepEqual(summaries[0].lineIds, ['l11', 'l13']);
  assert.equal(summaries[1].insufficient, 1);
  lines[2].driftAcknowledgedHash = 'h-l11';
  assert.equal(roleDriftSummaries(lines, [{ id: 'sunwukong', name: '孙悟空' }])[0].drifted, 1);
});

test('典型句 = 同角色 score 最小且未标记的一句；后端给 typicalLineId 时优先', () => {
  const lines = [line('l03', 'sunwukong', drift(2.49, false)), line('l06', 'sunwukong', drift(2.8, false)), line('l11', 'sunwukong', drift(5.17, true)), line('l02', 'tangseng', drift(1.0, false))];
  assert.equal(typicalLine(lines, lines[2]).id, 'l03');
  const hinted = { ...lines[2], voiceDrift: { ...lines[2].voiceDrift, typicalLineId: 'l06' } };
  assert.equal(typicalLine(lines, hinted).id, 'l06');
  assert.equal(typicalLine([lines[2]], lines[2]), null);
});

test('筛选：按角色只看偏离句', () => {
  const lines = [line('l03', 'sunwukong', drift(2.49, false)), line('l11', 'sunwukong', drift(5.17, true)), line('l19', 'tangseng', drift(4.43, true))];
  assert.deepEqual(filterReviewLines(lines, { roleId: 'sunwukong', onlyFlagged: true }).map((item) => item.id), ['l11']);
  assert.equal(filterReviewLines(lines).length, 3);
});

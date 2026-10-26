// 音色偏离（voiceDrift）的显示逻辑。判定在服务端做（渲染完成后计算），前端只显示。

export const DRIFT_REASONS = ['drift', 'nearest_other', 'short_line'];
export const INSUFFICIENT_TEXT = '样本不足，未检查';
export const SHORT_LINE_NOTE = '短句，结果仅供参考';

const isDialogue = (line) => line?.type === 'dialogue' || (!line?.type && line?.speakerId);

// 'none'（还没音频）| 'pending'（已重渲 · 等待复检）| 'insufficient' | 'consistent' | 'drift' | 'acknowledged'
export function driftState(line) {
  if (!line?.audioUrl) return 'none';
  const drift = line.voiceDrift;
  if (!drift || typeof drift !== 'object') return 'pending';
  // 可选字段：结果对应的音频指纹。和当前音频不一致说明这句已经重渲、复检还没回来。
  if (drift.audioHash && line.audioHash && drift.audioHash !== line.audioHash) return 'pending';
  if (drift.score === null || drift.score === undefined) return drift.flagged ? 'drift' : 'insufficient';
  if (!drift.flagged) return 'consistent';
  if (isAcknowledged(line)) return 'acknowledged';
  return 'drift';
}

export const isAcknowledged = (line) => Boolean(line?.driftAcknowledgedHash) && line.driftAcknowledgedHash === line.audioHash;
export const acknowledgePatch = (line) => ({ driftAcknowledgedHash: line?.audioHash || null });
export const undoAcknowledgePatch = () => ({ driftAcknowledgedHash: null });

export function driftReasons(line) {
  const reasons = Array.isArray(line?.voiceDrift?.reasons) ? line.voiceDrift.reasons : [];
  return reasons.filter((reason) => DRIFT_REASONS.includes(reason));
}
export const isShortLine = (line) => driftReasons(line).includes('short_line');

// 「音色偏离 · 听起来像X」；nearestRoleId 找不到名字时只写「音色偏离」。
export function driftLabel(line, nameOf = () => '') {
  const nearest = line?.voiceDrift?.nearestRoleId;
  const name = nearest && nearest !== line?.speakerId ? nameOf(nearest) : '';
  return name ? `音色偏离 · 听起来像${name}` : '音色偏离';
}

// 分数只放在提示里。
export function driftTooltip(line, nameOf = () => '') {
  const drift = line?.voiceDrift || {};
  const parts = [];
  if (Number.isFinite(drift.score)) parts.push(`偏离分 ${drift.score.toFixed(2)}（同一集内可比，超过 4 标记）`);
  const reasons = driftReasons(line);
  if (reasons.includes('drift')) parts.push('和这个角色其他句子的音色差得较远');
  if (reasons.includes('nearest_other') && drift.nearestRoleId) parts.push(`更像${nameOf(drift.nearestRoleId) || drift.nearestRoleId}`);
  if (reasons.includes('short_line')) parts.push(SHORT_LINE_NOTE);
  const baseline = Array.isArray(drift.baselineLines) ? drift.baselineLines.length : 0;
  if (baseline) parts.push(`对比了同角色 ${baseline} 句`);
  return parts.join('；');
}

// 角色汇总：「孙悟空 · 5 句中 2 句偏离」。只统计有音频的对白；已保持原样的不算偏离。
export function roleDriftSummaries(lines, characters = []) {
  const byRole = new Map();
  for (const line of lines || []) {
    if (!isDialogue(line) || !line.audioUrl || !line.speakerId) continue;
    const entry = byRole.get(line.speakerId) || { roleId: line.speakerId, total: 0, drifted: 0, insufficient: 0, lineIds: [] };
    entry.total += 1;
    const state = driftState(line);
    if (state === 'drift') { entry.drifted += 1; entry.lineIds.push(line.id); }
    if (state === 'insufficient') entry.insufficient += 1;
    byRole.set(line.speakerId, entry);
  }
  const order = new Map(characters.map((character, index) => [character.id, index]));
  const nameOf = (id) => characters.find((character) => character.id === id)?.name || id;
  return [...byRole.values()]
    .map((entry) => ({ ...entry, name: nameOf(entry.roleId), text: `${nameOf(entry.roleId)} · ${entry.total} 句中 ${entry.drifted} 句偏离` }))
    .sort((a, b) => (order.get(a.roleId) ?? 99) - (order.get(b.roleId) ?? 99));
}

// 「试听对比」的典型句：同角色 score 最小、没被标记的一句；后端给了 typicalLineId 就用它。
export function typicalLine(lines, line) {
  const pool = (lines || []).filter((item) => item.id !== line?.id && item.speakerId === line?.speakerId && item.audioUrl);
  const hinted = line?.voiceDrift?.typicalLineId && pool.find((item) => item.id === line.voiceDrift.typicalLineId);
  if (hinted) return hinted;
  const scored = pool.filter((item) => Number.isFinite(item.voiceDrift?.score) && !item.voiceDrift?.flagged)
    .sort((a, b) => a.voiceDrift.score - b.voiceDrift.score);
  return scored[0] || pool.find((item) => !item.voiceDrift?.flagged) || null;
}

// 筛选：只看某个角色的偏离句（aria-pressed 的角色卡）。
export function filterReviewLines(lines, { roleId = null, onlyFlagged = false } = {}) {
  return (lines || []).filter((line) => isDialogue(line)
    && (!roleId || line.speakerId === roleId)
    && (!onlyFlagged || driftState(line) === 'drift'));
}

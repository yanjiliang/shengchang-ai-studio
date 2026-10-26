// 审听修句 + 导出（/workspace/shengchang-review-mode/handoff.md）的纯逻辑。界面在 components/review/。
import { driftState } from './drift.js';

export const MARK_REASONS = ['串字/漏字', '不像这个角色', '情绪不对', '停顿/截断', '其他'];
export const MAX_TAKES = 5;
export const REGEN_RTF = 1.85; // 「换一条」预计用时 = 时长 × 1.85
export const PREV_TAIL_SEC = 2;
export const ROW_HEIGHT = { desktop: 84, mobile: 108 };
export const OVERSCAN = 6;
export const BREEZE_NONCOMMERCIAL = 'Breeze-TTS-2 生成，仅限非商业用途。';
export const SFX_UNBOUND = '音效未绑定素材，导出只有对白。';
export const OFFLINE_REGEN = 'Breeze 未连接，暂时不能换一条；标记、试听、重新混音和导出不受影响';

export const reviewLines = (scenes = []) => scenes.flatMap((scene, sceneIndex) => (scene.lines || [])
  .filter((line) => line.type === 'dialogue')
  .map((line) => ({ ...line, sceneId: scene.id, sceneIndex })));

export function formatClock(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}

// 每句在整集里的起点：只用服务端 remix / export 返回的 starts[]（毫秒或秒都接受），前端不推算。
// mix.lines: [{ lineId, startMs, endMs }]（导出结果的形状）也接受。
export function mixTimeline(mix, lines) {
  if (!mix) return null;
  if (Array.isArray(mix.lines) && mix.lines.length) {
    const byId = new Map(mix.lines.map((item) => [item.lineId, item]));
    return lines.map((line) => { const item = byId.get(line.id); return item ? { start: item.startMs / 1000, end: Number.isFinite(item.endMs) ? item.endMs / 1000 : null } : null; });
  }
  if (Array.isArray(mix.starts)) {
    const inMs = mix.starts.some((value) => value > 1000) || mix.startsUnit === 'ms';
    const starts = mix.starts.map((value) => (inMs ? value / 1000 : value));
    const total = Number(mix.durationMs) / 1000 || null;
    return lines.map((_, index) => Number.isFinite(starts[index]) ? { start: starts[index], end: Number.isFinite(starts[index + 1]) ? starts[index + 1] : total } : null);
  }
  return null;
}

// 播放头所在的句子：最后一个 start <= t 的句子。
export function indexAt(timeline, seconds) {
  if (!timeline) return -1;
  let found = -1;
  timeline.forEach((item, index) => { if (item && item.start <= seconds + 0.001) found = index; });
  return found;
}

// mixStale（派生值）：有句子现在的音频不是混音里的那条。
// 服务端导出结果不带每句用的哪条，所以导出时浏览器记一份 { lineId: audioHash || audioUrl }（mix.audio）。
export const lineAudioKey = (line) => line?.audioHash || line?.audioUrl || '';
export function staleMixLineIds(lines, mix) {
  if (mix?.audio) return lines.filter((line) => line.id in mix.audio && lineAudioKey(line) !== mix.audio[line.id]).map((line) => line.id);
  if (!mix?.takeIds) return [];
  return lines.filter((line) => line.activeTakeId && mix.takeIds[line.id] && mix.takeIds[line.id] !== line.activeTakeId).map((line) => line.id);
}

// 导出结果 / 时间轴（openapi ExportResult、ProjectTimeline）→ 审听用的混音。
// segments 只保留对白；endMs 不含句后停顿（下一句的 startMs 才是）。
export function mixFromExport({ taskId, url, durationMs, lufs = null, lufsReason = null, targetLufs = null, name = '', segments = [] }, audio = null) {
  const lines = (segments || []).filter((segment) => segment.type === 'dialogue').map(({ lineId, sceneId, startMs, endMs }) => ({ lineId, sceneId, startMs, endMs }));
  return { mixId: taskId || url, url: url ? `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(taskId || Date.now())}` : '', name, durationMs, lufs, lufsReason, targetLufs, lines, ...(audio ? { audio } : {}) };
}
export const audioSnapshot = (lines) => Object.fromEntries((lines || []).filter((line) => line.audioUrl).map((line) => [line.id, lineAudioKey(line)]));

// 可能换人：只看服务端 voiceDrift.flagged（driftState === 'drift'）。
export const isDrifted = (line) => driftState(line) === 'drift';
export const isMarked = (line) => Boolean(line?.mark) && !line.mark.resolved;

export function driftBanner(lines) {
  const drifted = lines.map((line, index) => ({ line, index })).filter(({ line }) => isDrifted(line));
  if (!drifted.length) return null;
  const list = drifted.map(({ index }) => `第 ${index + 1} 句`).join('、');
  return { count: drifted.length, text: `有 ${drifted.length} 句可能换人：${list}听起来不像本角色。只在这些句子上标出，其余句子音色一致、不提示。`, action: `只看这 ${drifted.length} 句` };
}

export function filterLines(lines, filter) {
  if (filter === 'marked') return lines.filter(isMarked);
  if (filter === 'drift') return lines.filter(isDrifted);
  return lines;
}

// J / K：在筛选结果里跳上一句 / 下一句。
export function stepLine(visibleIds, currentId, direction) {
  if (!visibleIds.length) return null;
  const index = visibleIds.indexOf(currentId);
  if (index === -1) return direction > 0 ? visibleIds[0] : visibleIds[visibleIds.length - 1];
  return visibleIds[Math.max(0, Math.min(visibleIds.length - 1, index + direction))];
}

// 虚拟列表：固定行高，只渲染可见区域上下各多 OVERSCAN 行。
export function rowWindow({ scrollTop, viewportHeight, rowHeight, count, overscan = OVERSCAN }) {
  if (!count) return { start: 0, end: 0, total: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const visible = Math.ceil(Math.max(viewportHeight, rowHeight) / rowHeight);
  return { start: Math.max(0, first - overscan), end: Math.min(count, first + visible + overscan), total: count * rowHeight };
}

// 行徽标（handoff 第 2 节）。
export function lineBadges(line, { pendingTakeId, mixStaleIds = [], job } = {}) {
  const badges = [];
  if (isDrifted(line)) badges.push({ tone: 'drift', text: '可能换人' });
  if (isMarked(line)) badges.push({ tone: 'mark', text: line.mark.reasons?.length ? `已标记 · ${line.mark.reasons.join('、')}` : '已标记' });
  else if (line.mark?.resolved) badges.push({ tone: 'fixed', text: '已修' });
  const status = job?.status;
  if (status === 'queued') badges.push({ tone: 'job', text: '排队中' });
  if (status === 'running') badges.push({ tone: 'job', text: '生成中' });
  if (status === 'stopping') badges.push({ tone: 'job', text: '停止中' });
  if (status === 'failed') badges.push({ tone: 'error', text: '生成失败' });
  if (pendingTakeId) badges.push({ tone: 'pending', text: '新版待确认' });
  if (line.audioUrl && line.stale === true) badges.push({ tone: 'stale', text: '需重渲', title: staleReasonText(line.staleReason) });
  if (mixStaleIds.includes(line.id)) badges.push({ tone: 'remix', text: '已换新版 · 待混音' });
  return badges;
}

// 服务端 line.staleReason（openapi：text | params | null）→ 提示文案。
export function staleReasonText(reason) {
  if (reason === 'text') return '台词文字改过了，和生成时不一样';
  if (reason === 'params') return '生成参数变了（参考音色、情绪、语速或读音词典）';
  return '和当前设置对不上，需要重新生成';
}

// 豆包「换一条」：同样的文字和参数会命中缓存或得到差不多的结果，而且按字扣费，先确认。
export const doubaoRegenConfirm = (text) => `豆包不支持换种子，重新生成会扣 ${String(text || '').length} 字，结果可能差不多`;

export function lineAriaLabel(line, index, { start, drifted, marked } = {}) {
  const parts = [`第 ${index + 1} 句，${line.speaker || ''}：${line.text || ''}`];
  if (drifted) parts.push('可能换人');
  if (marked) parts.push('已标记');
  if (Number.isFinite(start)) parts.push(`从 ${formatClock(start)} 开始播放`);
  return parts.join('，');
}

// 「换一条」提示。
export function regenHint({ edited, durationSec, batchRunning }) {
  const eta = Math.max(1, Math.round((Number(durationSec) || 0) * REGEN_RTF));
  const parts = [edited ? `按改过的台词和情绪生成，预计约 ${eta} 秒。` : `台词和情绪没改，换个随机种子也会出一条不一样的。预计约 ${eta} 秒。`];
  if (batchRunning) parts.push('会插到批量配音前面。');
  return parts.join('');
}

// 换一条任务的事件 → 这一句的状态补丁。0043 起 Breeze 预检失败 / 进通道前失败只有 queued → failed（没有 started），
// 所以 failed 不依赖之前是否 running：直接清掉排队位置和进度，不留转圈，也不显示任务 message（如「命中缓存」）。
export function takeJobPatch(event = {}, errorText = '') {
  const status = event.status === 'cancelling' ? 'stopping' : event.status;
  if (status === 'queued') return { status: 'queued', queuePosition: event.queuePosition ?? 0, progress: 0 };
  if (status === 'running') return { status: 'running', progress: event.progress ?? 0, queuePosition: null };
  if (status === 'stopping') return { status: 'stopping' };
  if (status === 'failed') return { status: 'failed', error: errorText || event.error || '生成失败', queuePosition: null, progress: 0 };
  if (status === 'cancelled') return { status: 'cancelled', queuePosition: null };
  return null;
}
export const takeJobBusy = (job) => !!job && ['queued', 'running', 'stopping'].includes(job.status);

// 换一条的任务状态文案。queuePosition：前面还有几句修改（不含批量配音）。
export function jobText(job) {
  if (!job) return null;
  if (job.status === 'queued') return { title: Number(job.queuePosition) > 0 ? `排队中，前面还有 ${job.queuePosition} 句` : '排队中', detail: Number.isFinite(job.currentLineEtaSec) ? `等当前这句配完，约 ${Math.ceil(job.currentLineEtaSec)} 秒` : '马上开始', cancel: '取消' };
  if (job.status === 'running') return { title: '正在生成新的一条', detail: Number.isFinite(job.etaS) ? `约剩 ${Math.max(1, Math.ceil(job.etaS))} 秒` : '', cancel: '取消' };
  if (job.status === 'stopping') return { title: '当前这句完成后停止', detail: '正在生成的句子不能打断', cancel: null };
  if (job.status === 'cancelled') return { title: '已取消', detail: '', cancel: null };
  if (job.status === 'failed') return { title: '这一条没有生成出来', detail: `原因：${job.error || '未知错误'}`, note: '原版不受影响', retry: '重试' };
  if (job.status === 'offline') return { title: '等 Breeze 恢复连接', detail: '', cancel: '取消' };
  return null;
}

// 版本记录：最多 5 版；超出时清理最早的、既不在用也不在当前混音里、也不是待确认的那版。
export function pruneTakes(takes, { activeTakeId, mixTakeId, pendingTakeId, max = MAX_TAKES } = {}) {
  const list = [...takes];
  while (list.length > max) {
    const index = list.findIndex((take) => ![activeTakeId, mixTakeId, pendingTakeId].includes(take.takeId));
    if (index === -1) break;
    list.splice(index, 1);
  }
  return list;
}

export function takeTags(take, { activeTakeId, mixTakeId, pendingTakeId }) {
  const tags = [];
  if (take.takeId === activeTakeId) tags.push('在用');
  if (take.takeId === mixTakeId) tags.push('在混音里');
  if (take.takeId === pendingTakeId) tags.push('待确认');
  return tags;
}

// 导出前置检查：需重新混音 → 只给「重新混音并导出」；还有标记或换人句 → 不挡，按钮「仍然导出」。
// staleLineCount 来自服务端 GET /export-precheck（和导出结果同一算法）。有过期句时先问：
// 重配这几句，还是按现在的版本导出（不拦）。
export function exportPrecheck({ mixStale, markedCount = 0, driftCount = 0, staleLineCount = 0 }) {
  const stale = Number(staleLineCount) > 0 ? Number(staleLineCount) : 0;
  if (stale) return { primary: '按现在的版本导出', remixFirst: Boolean(mixStale), warning: null, stale: { count: stale, title: staleExportText(stale), fix: `先重配这 ${stale} 句` } };
  if (mixStale) return { primary: '重新混音并导出', remixFirst: true, warning: null };
  const issues = markedCount + driftCount;
  if (issues) return { primary: '仍然导出', remixFirst: false, warning: { title: `还有 ${issues} 句标了问题，仍要导出？`, detail: '不影响导出，之后修好可以再导一次。', action: '先去看看' } };
  return { primary: '导出', remixFirst: false, warning: null };
}

export function exportNotes({ sfxUnbound, breeze }) {
  return [sfxUnbound ? SFX_UNBOUND : null, breeze ? BREEZE_NONCOMMERCIAL : null].filter(Boolean);
}

export const staleExportText = (count) => `还有 ${count} 句改过但没重新配音`;
// 0037 export-precheck：pendingLineCount = 没音频 + 过期（文本非空），pendingCharCount = 发给引擎的字数（估算）。
export function pendingRenderText(pendingLineCount, pendingCharCount) {
  const lines = Number(pendingLineCount);
  if (!Number.isFinite(lines) || lines <= 0) return '';
  const chars = Number(pendingCharCount);
  return Number.isFinite(chars) && chars > 0 ? `还需渲染 ${lines} 句，约 ${chars} 字（估算）` : `还需渲染 ${lines} 句`;
}

export function exportSummary(result) {
  if (!result) return null;
  const seconds = Number(result.durationMs) / 1000;
  return {
    name: result.name || '整集.mp3',
    duration: Number.isFinite(seconds) ? `${formatClock(seconds)}（${seconds.toFixed(1)} 秒）` : '—',
    loudness: Number.isFinite(result.lufs) ? `${String(result.lufs.toFixed(1)).replace('-', '−')} LUFS` : '未测量',
    // 导出不拦：还有需重渲的句子只提醒。
    staleLineCount: Number(result.staleLineCount) > 0 ? Number(result.staleLineCount) : 0,
    counts: [Number.isFinite(result.lineCount) ? `${result.lineCount} 句对白` : null, Number.isFinite(result.sceneCount) ? `${result.sceneCount} 个场景` : null].filter(Boolean).join(' · '),
  };
}

export const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

// 审听页读取中（fe-0010）：知道几句就写几句，不知道就不写数字。
export const readingLinesText = (count) => (Number(count) > 0 ? `正在读取 ${Number(count)} 句台词` : '正在读取台词');

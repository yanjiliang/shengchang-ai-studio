// 角色声音设计（本地 Breeze-TTS-2）的纯逻辑：试听任务状态、排队文案、取消、
// 上传检查、锁定影响、需重渲判定。
import { SECONDS_PER_CHAR, BREEZE_RATIO, formatSeconds } from './engine.js';

export const TAKE_COUNT = 3;
export const NEUTRAL_SUFFIX = '这段话用正常语速、平静中性的语气说，不带情绪。';
export const UPLOAD_MIN_SEC = 5; // 硬下限（服务端同）
export const UPLOAD_SUGGEST_MIN_SEC = 10; // 5–10 秒可以锁定，只提示
export const UPLOAD_MAX_SEC = 30;
export const CONSENT_TEXT = '这是我本人的声音，或我已获得声音主人的授权。使用他人声音产生的责任由我承担。';
export const SEED_TOOLTIP = '仅存档，不能用来复现声音';

const TAKE_STATUSES = ['queued', 'running', 'ready', 'error', 'cancelled'];
const STATUS_ALIASES = { done: 'ready', completed: 'ready', failed: 'error', pending: 'queued', generating: 'running' };
const normalizeStatus = (status) => {
  const value = STATUS_ALIASES[status] || status;
  return TAKE_STATUSES.includes(value) ? value : 'queued';
};

export const takeEtaSeconds = (text) => [...String(text || '')].length * SECONDS_PER_CHAR * BREEZE_RATIO.mid;

export function emptyDraft(description = '') {
  return { description, takes: [], jobId: null, jobStatus: 'idle', pickedTakeId: null, currentLineEtaSec: null, notice: '' };
}

// 开始一批：先放占位卡（排队中），等服务端事件替换。
export function startDraft(draft, { jobId, count = TAKE_COUNT, slotOffset = 0 }) {
  const placeholders = Array.from({ length: count }, (_, index) => ({ slot: slotOffset + index, takeId: null, status: 'queued', queuePosition: index, audioUrl: '', seed: null }));
  return { ...draft, jobId, jobStatus: 'running', notice: '', takes: slotOffset ? [...draft.takes, ...placeholders] : placeholders, pickedTakeId: slotOffset ? draft.pickedTakeId : null };
}

// 失败的一版重新生成：替换那张卡，状态回到排队。
export function retrySlot(draft, slot, { jobId } = {}) {
  return { ...draft, jobId: jobId || draft.jobId, jobStatus: 'running', takes: draft.takes.map((take) => take.slot === slot ? { slot, takeId: null, status: 'queued', queuePosition: null, audioUrl: '', seed: null, retried: true } : take) };
}

// 服务端事件：{ takeId, audioUrl, seed, lineIndex, queuePosition, status, etaSec, progress, error, durationSec, f0Hz, slot }
// 或 job 级事件：{ jobId, status: 'cancelling'|'cancelled'|'done'|'running', currentLineEtaSec }。
// 只认参考音频（lineIndex 为空或 -1）；用台词试听的 take（lineIndex >= 0）挂到 lineTakes。
export function applyJobEvent(draft, event) {
  if (!event || typeof event !== 'object') return draft;
  let next = { ...draft };
  if (event.jobId && draft.jobId && event.jobId !== draft.jobId && !event.takeId) return draft;
  if ('currentLineEtaSec' in event) next.currentLineEtaSec = Number.isFinite(event.currentLineEtaSec) ? event.currentLineEtaSec : null;
  if (!event.takeId && event.status) {
    if (event.status === 'cancelling') return { ...next, jobStatus: 'cancelling', takes: next.takes.filter((take) => take.status !== 'queued') };
    if (event.status === 'cancelled') {
      // 正在生成的那一版做完后丢弃（Design 原型的做法；服务端如果保留 audioUrl，这里也保留）。
      const kept = next.takes.filter((take) => take.status === 'ready');
      return { ...next, jobStatus: 'cancelled', takes: kept };
    }
    if (['done', 'completed'].includes(event.status)) return { ...failActiveTakes(next, '这一版没有生成出来'), jobStatus: 'done' };
    if (event.status === 'failed') return { ...failActiveTakes(next, String(event.error || 'Breeze 返回错误')), jobStatus: 'done' };
    if (event.status === 'queued' && Number.isFinite(event.queuePosition)) {
      // 整个任务还在 Breeze 队列里：前面还有 queuePosition 个任务（openapi Task.queuePosition）。
      return { ...next, jobQueuePosition: event.queuePosition, takes: next.takes.map((take) => take.status === 'queued' ? { ...take, queuePosition: event.queuePosition + (take.slot ?? 0) } : take) };
    }
    if (event.status === 'running') {
      // Breeze 一版一版地生成：第一张还没好的卡就是正在生成的那版。
      let marked = false;
      const takes = next.takes.map((take, index) => {
        if (take.status === 'running') { marked = true; return take; }
        if (take.status !== 'queued') return take;
        if (!marked) { marked = true; return { ...take, status: 'running', queuePosition: null, progress: 0 }; }
        return { ...take, queuePosition: index };
      });
      return { ...next, jobStatus: next.jobStatus === 'cancelling' ? 'cancelling' : 'running', jobQueuePosition: null, takes };
    }
    return next;
  }
  if (!event.takeId) return next;
  if (Number.isInteger(event.lineIndex) && event.lineIndex >= 0) {
    const lineTakes = { ...(next.lineTakes || {}) };
    lineTakes[`${event.parentTakeId || ''}:${event.lineIndex}`] = { ...event, status: normalizeStatus(event.status) };
    return { ...next, lineTakes };
  }
  const takes = [...next.takes];
  let index = takes.findIndex((take) => take.takeId === event.takeId);
  if (index < 0 && Number.isInteger(event.slot)) index = takes.findIndex((take) => take.slot === event.slot);
  if (index < 0) index = takes.findIndex((take) => !take.takeId && take.status !== 'error');
  const status = normalizeStatus(event.status || (event.audioUrl ? 'ready' : 'queued'));
  const base = index >= 0 ? takes[index] : { slot: takes.length };
  const merged = {
    ...base, takeId: event.takeId, status,
    audioUrl: event.audioUrl ?? base.audioUrl ?? '',
    seed: event.seed ?? base.seed ?? null,
    queuePosition: Number.isFinite(event.queuePosition) ? event.queuePosition : status === 'queued' ? base.queuePosition ?? null : null,
    etaSec: Number.isFinite(event.etaSec) ? event.etaSec : base.etaSec ?? null,
    progress: Number.isFinite(event.progress) ? event.progress : status === 'ready' ? 1 : base.progress ?? 0,
    durationSec: event.durationSec ?? base.durationSec ?? null,
    f0Hz: event.f0Hz ?? base.f0Hz ?? null,
    nearestRoleId: event.nearestRoleId ?? base.nearestRoleId ?? null,
    error: status === 'error' ? String(event.error || event.reason || 'Breeze 返回错误') : '',
  };
  if (index >= 0) takes[index] = merged; else takes.push(merged);
  if (next.jobStatus === 'cancelling' && status === 'cancelled') return applyJobEvent({ ...next, takes }, { status: 'cancelled' });
  const filtered = takes.filter((take) => take.status !== 'cancelled');
  const allSettled = filtered.length > 0 && filtered.every((take) => ['ready', 'error'].includes(take.status));
  return { ...next, takes: filtered, jobStatus: allSettled && next.jobStatus === 'running' ? 'done' : next.jobStatus };
}

// 点「全部取消」后的本地状态：没有正在生成的版 → 立即已取消；有 → 排队的移除，等这一版做完。
export function requestCancel(draft) {
  const running = draft.takes.some((take) => take.status === 'running');
  if (!running) return { ...draft, jobStatus: 'cancelled', takes: draft.takes.filter((take) => take.status === 'ready') };
  return { ...draft, jobStatus: 'cancelling', takes: draft.takes.filter((take) => take.status !== 'queued') };
}

export const isGenerating = (draft) => ['running', 'cancelling'].includes(draft?.jobStatus) && draft.takes.some((take) => ['queued', 'running'].includes(take.status));
export const cancelButtonText = (draft) => draft?.jobStatus === 'cancelling' ? '当前这句完成后停止' : '全部取消';

// 排队文案（Design 第 4 条）。currentLineEtaSec：正在配的那句台词还剩多久（没有就是 null）。
export function takeQueueText(take, draft, { referenceText = '' } = {}) {
  if (take.status === 'running') {
    const remaining = Number.isFinite(take.etaSec) ? take.etaSec : takeEtaSeconds(referenceText) * (1 - (take.progress || 0));
    return { title: '正在生成', detail: `还需约 ${formatSeconds(remaining)}` };
  }
  if (take.status !== 'queued') return null;
  const lineEta = Number.isFinite(draft?.currentLineEtaSec) ? draft.currentLineEtaSec : null;
  const position = Number.isFinite(take.queuePosition) ? take.queuePosition : 0;
  if (position === 0) {
    return lineEta !== null
      ? { title: `排队中 · 等当前这句配完，约 ${formatSeconds(lineEta)}`, detail: '配完这句就先做试听' }
      : { title: '排队中', detail: '马上开始' };
  }
  const startIn = (lineEta || 0) + position * takeEtaSeconds(referenceText);
  return { title: `排队中 · 前面还有 ${position} 版`, detail: `约 ${formatSeconds(startIn)}后开始` };
}

// 「全部完成还需约 T 秒」：当前这句台词剩余 + 本角色还没做完的试听；剩下的台词不算。
export function draftRemainingSeconds(draft, { referenceText = '' } = {}) {
  const per = takeEtaSeconds(referenceText);
  let total = draft.takes.some((take) => take.status === 'queued') && !draft.takes.some((take) => take.status === 'running') ? (draft.currentLineEtaSec || 0) : 0;
  for (const take of draft.takes) {
    if (take.status === 'running') total += Number.isFinite(take.etaSec) ? take.etaSec : per * (1 - (take.progress || 0));
    if (take.status === 'queued') total += per;
  }
  return total;
}

// 维度标签（Design dimsCovered）：关键词命中就打 ✓。
export const DIMENSIONS = [
  { id: 'age', label: '年龄', example: '三十岁上下', words: ['岁', '少年', '青年', '中年', '老年', '老人', '孩子', '童', '年轻', '年迈', '老妇', '老翁', '少女'] },
  { id: 'gender', label: '性别', example: '男声', words: ['男', '女', '少女', '老妇', '老翁', '妇人', '汉子'] },
  { id: 'pitch', label: '音高', example: '中低音', words: ['低沉', '低音', '高音', '中音', '音高', '高亢', '尖', '沉', '中低', '中高', '偏高', '偏低'] },
  { id: 'texture', label: '质感', example: '略带沙哑，有颗粒感', words: ['沙哑', '清亮', '浑厚', '磁性', '气声', '颗粒', '明亮', '温润', '厚', '薄', '干净', '粗', '嘶哑', '圆润', '鼻音', '胸腔'] },
  { id: 'pace', label: '语速', example: '语速偏慢', words: ['语速', '快', '慢', '从容', '急促', '不紧不慢', '节奏'] },
];
export const dimensionsCovered = (description) => DIMENSIONS.filter((dim) => dim.words.some((word) => String(description || '').includes(word))).map((dim) => dim.id);

// 实际发给 Breeze 的描述 = 用户描述 + 自动追加的中性语气句。
export function designPrompt(description) {
  const text = String(description || '').trim();
  return text ? `${text.replace(/[。.]?$/, '。')}${NEUTRAL_SUFFIX}` : '';
}

// 上传录音检查：时长 5–30 秒（不合格阻止锁定；5–10 秒只提示）；原话必填；每秒 <2 或 >7.5 字只提示；必须勾选授权。
export function uploadChecks({ durationSec = null, transcript = '', consent = false, decodeError = '' } = {}) {
  const errors = []; const warnings = [];
  if (decodeError) errors.push({ field: 'file', text: '读不出这个文件，请换一个 wav / mp3 / m4a' });
  else if (durationSec === null || durationSec === undefined) errors.push({ field: 'file', text: '先选择一段录音' });
  else if (durationSec < UPLOAD_MIN_SEC) errors.push({ field: 'file', text: `录音太短（${durationSec.toFixed(1)} 秒），至少要 5 秒，建议 10 到 30 秒` });
  else if (durationSec > UPLOAD_MAX_SEC) errors.push({ field: 'file', text: `录音太长（${durationSec.toFixed(1)} 秒），最长 30 秒` });
  else if (durationSec < UPLOAD_SUGGEST_MIN_SEC) warnings.push({ field: 'file', text: `录音 ${durationSec.toFixed(1)} 秒，建议 10 到 30 秒，太短可能不稳` });
  const chars = [...String(transcript || '').replace(/\s+/g, '')].length;
  if (!chars) errors.push({ field: 'transcript', text: '请填写录音里说的原话，克隆需要逐字对应' });
  else if (Number.isFinite(durationSec) && durationSec > 0) {
    const rate = chars / durationSec;
    if (rate < 2) warnings.push({ field: 'transcript', text: `原话只有 ${chars} 字，和 ${durationSec.toFixed(1)} 秒的录音对不上（每秒不到 2 个字），请检查是否漏写` });
    if (rate > 7.5) warnings.push({ field: 'transcript', text: `原话有 ${chars} 字，${durationSec.toFixed(1)} 秒说不完（每秒超过 7.5 个字），请检查是否多写` });
  }
  if (!consent) errors.push({ field: 'consent', text: '请先确认声音授权' });
  return { errors, warnings, canLock: errors.length === 0 };
}

// 角色的对白台词。
export function roleLines(scenes, roleId) {
  return (scenes || []).flatMap((scene) => (scene.lines || []).filter((line) => line.type === 'dialogue' && line.speakerId === roleId));
}

// impact 返回 { affectedLineCount, lineIds[] }（约定）；也接受 Design 草案的
// { unrenderedCount, staleCount, staleLineIds[] }。未渲染句数接口没给时从项目里算。
// 服务端 impact 是「按当前参考音，哪些已生成台词已经对不上」（锁定之后才有意义；锁定前通常是 0）。
// 锁定前要预告的是「换了参考音以后」：这个角色所有已生成的台词都会对不上，所以和本地已生成的句子取并集。
export function impactSummary(payload, lines = [], { beforeLock = true } = {}) {
  const ids = Array.isArray(payload?.lineIds) ? payload.lineIds : Array.isArray(payload?.staleLineIds) ? payload.staleLineIds : [];
  const byId = new Map(lines.map((line) => [line.id, line]));
  const all = beforeLock ? [...new Set([...ids, ...lines.filter((line) => line.audioUrl).map((line) => line.id)])] : ids;
  const serverCount = Number.isFinite(payload?.affectedLineCount) ? payload.affectedLineCount : Number.isFinite(payload?.staleCount) ? payload.staleCount : ids.length;
  const staleCount = beforeLock ? Math.max(serverCount, all.length) : serverCount;
  const unrenderedCount = Number.isFinite(payload?.unrenderedCount) ? payload.unrenderedCount : lines.filter((line) => !line.audioUrl).length;
  return { staleCount, unrenderedCount, staleLines: all.map((id) => byId.get(id) || { id, text: id }) };
}

// 「需重渲」只看服务端给的 line.stale === true（服务端按参考音频指纹 / 文字改动算，前端不自己推断）。
export function lineNeedsRerender(line) {
  return Boolean(line?.audioUrl) && line.stale === true;
}
export const staleLineCount = (lines) => (lines || []).filter((line) => lineNeedsRerender(line)).length;

// 角色列表上的状态。
export function roleVoiceStatus(character, draft) {
  if (draft && isGenerating(draft)) {
    const ready = draft.takes.filter((take) => take.status === 'ready').length;
    const running = draft.takes.some((take) => take.status === 'running');
    if (!running) {
      const first = draft.takes.find((take) => take.status === 'queued');
      return first && first.queuePosition > 0 ? `排队中，前面还有 ${first.queuePosition} 版` : '排队中，等当前这句配完';
    }
    return `生成中 ${ready}/${draft.takes.length}`;
  }
  if (character?.voice?.referenceId) return character.voice.source === 'uploaded' ? '已锁定 · 上传录音' : '已锁定 · 描述生成';
  if (draft?.takes?.some((take) => take.status === 'ready')) return '试听中';
  return '未设计';
}

// Breeze 断开：正在生成和排队的版变成失败卡片（「重新生成这一版」连上后可用）。
export const DISCONNECTED_REASON = 'Breeze 服务断开了';
export function failActiveTakes(draft, reason = DISCONNECTED_REASON) {
  if (!draft?.takes?.some((take) => ['queued', 'running'].includes(take.status))) return draft;
  return { ...draft, jobStatus: 'done', takes: draft.takes.map((take) => ['queued', 'running'].includes(take.status) ? { ...take, status: 'error', error: reason, queuePosition: null } : take) };
}

// 服务端 VoiceReference.source 是 design | upload；界面里用 designed | uploaded。
const uiSource = (source) => (source === 'upload' || source === 'uploaded' ? 'uploaded' : 'designed');

// 锁定后界面用的参考音色。以服务端返回的 VoiceReference（referenceId / audioHash / version /
// audioUrl / transcript）为准，试听卡上的信息（seed、时长、音高）补充。
export function lockedVoice({ result, take, draft, previous, transcript, source }) {
  const kind = uiSource(result.source || source);
  return {
    engine: 'breeze-tts-2',
    source: kind,
    referenceId: result.referenceId,
    audioHash: result.audioHash,
    breezeVoiceId: result.breezeVoiceId || '',
    refAudioUrl: result.audioUrl || take?.audioUrl || '',
    refTranscript: result.transcript ?? transcript ?? draft?.referenceText ?? '',
    ...(kind === 'uploaded' ? {} : { description: draft?.description || '', seed: take?.seed ?? result.seed ?? null }),
    durationSec: result.durationSec ?? take?.durationSec ?? null,
    f0Hz: result.f0Hz ?? take?.f0Hz ?? null,
    lockedAt: new Date().toISOString(),
    version: Number.isInteger(result.version) ? result.version : (previous?.version || 0) + 1,
  };
}

// 项目里 state.voiceReferences[roleId]（服务端写，浏览器保存覆盖不了）→ 界面用的参考音色。
// cached 是角色上存的同一个 referenceId 的界面数据（音高等服务端不存的字段）。
export function voiceFromReference(reference, cached = null) {
  if (!reference?.referenceId) return null;
  const same = cached?.referenceId === reference.referenceId ? cached : {};
  const kind = uiSource(reference.source);
  return {
    ...same,
    engine: 'breeze-tts-2', source: kind, referenceId: reference.referenceId, audioHash: reference.audioHash,
    breezeVoiceId: reference.breezeVoiceId || '', refAudioUrl: reference.audioUrl || same.refAudioUrl || '', refTranscript: reference.transcript ?? same.refTranscript ?? '',
    ...(kind === 'uploaded' ? {} : { description: reference.description || same.description || '', seed: reference.seed ?? same.seed ?? null }),
    durationSec: Number.isFinite(reference.durationMs) ? reference.durationMs / 1000 : same.durationSec ?? null,
    lockedAt: reference.createdAt ? new Date(reference.createdAt).toISOString() : same.lockedAt || null,
    version: reference.version || same.version || 1,
  };
}

// 浏览器状态里的乐观更新：锁定接口已经写了服务端，这里同步一份，等下次读项目时被服务端的覆盖。
export function referenceFromVoice(voice) {
  if (!voice?.referenceId) return null;
  return { referenceId: voice.referenceId, audioHash: voice.audioHash, breezeVoiceId: voice.breezeVoiceId || '', audioUrl: voice.refAudioUrl, transcript: voice.refTranscript, description: voice.description || '', seed: voice.seed ?? null, version: voice.version, source: voice.source === 'uploaded' ? 'upload' : 'design', durationMs: Number.isFinite(voice.durationSec) ? Math.round(voice.durationSec * 1000) : null, createdAt: Date.parse(voice.lockedAt) || Date.now() };
}

// 锁定接口的 warnings[]（0026 起）：只提示，不拦。REFERENCE_SHORT = 上传录音 5–10 秒。
export function referenceWarningTexts(warnings = []) {
  return (Array.isArray(warnings) ? warnings : []).map((warning) => {
    if (warning?.code === 'REFERENCE_SHORT') {
      const seconds = Number(warning.durationMs) / 1000;
      const min = warning.recommendedMinSeconds || UPLOAD_SUGGEST_MIN_SEC; const max = warning.recommendedMaxSeconds || 30;
      return `录音偏短${Number.isFinite(seconds) && seconds > 0 ? `（${seconds.toFixed(1)} 秒）` : ''}，已经锁定；${min} 到 ${max} 秒的录音音色会更稳`;
    }
    return warning?.message || '';
  }).filter(Boolean);
}

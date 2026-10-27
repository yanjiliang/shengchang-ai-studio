// Breeze 连不上（0036 BREEZE_UNREACHABLE）。硬规则：绝不自动改用豆包——不管是健康检查失败、任务失败
// 还是启动时的默认值。引擎只在用户自己去设置里点了才变；这里只给「重试 / 继续」和「去设置」。
export const BREEZE_UNREACHABLE = 'BREEZE_UNREACHABLE';
export const BEFORE_START_TEXT = 'Breeze 连不上，还没开始配音，没有花任何额度。请确认 Mac 上的 Breeze 服务已启动。';

const codeOf = (source = {}) => source.code || source.errorCode || source.payload?.code || source.result?.code || '';
const num = (value) => (Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : null);

// 已配好 N / 还剩 M。依赖（按顺序取第一个有的）：
//   0037：result.completedLineCount / result.remainingLineCount（开始前连不上 N=0）
//   0036：M = result.skippedCount（含停下时那一句）；N = 开始时这次要生成的句数（estimate.requestCount）− M，
//         或 freshCount + cacheHits，或 results.length
export function outageCounts(result = {}, { requestCount = null } = {}) {
  const r = result || {};
  const remaining = num(r.remainingLineCount) ?? num(r.skippedCount) ?? num(r.remainingCount) ?? num(r.failedCount) ?? (Array.isArray(r.skippedLineIds) ? r.skippedLineIds.length : null);
  const planned = num(r.totalCount) ?? num(requestCount);
  const done = num(r.completedLineCount) ?? num(r.doneCount)
    ?? (num(r.freshCount) !== null || num(r.cacheHits) !== null ? (num(r.freshCount) || 0) + (num(r.cacheHits) || 0) : null)
    ?? (planned !== null && remaining !== null ? Math.max(0, planned - remaining) : null)
    ?? (Array.isArray(r.results) ? r.results.length : null) ?? 0;
  return { done, remaining: remaining ?? (planned !== null ? Math.max(0, planned - done) : null) };
}

// source：POST one-click 抛出的错误，或失败的一键任务（GET /api/tasks/:id）。不是 Breeze 断开就返回 null。
// 返回的 actions 只有 retry / resume / settings —— 没有「换豆包」。
export function breezeOutage(source, context = {}) {
  if (!source || codeOf(source) !== BREEZE_UNREACHABLE) return null;
  const isTask = typeof source.status === 'string' && !(source instanceof Error);
  const result = isTask ? { ...(source.payload || {}), ...(source.result || {}) } : (source.payload || {});
  const { done, remaining } = outageCounts(result, context);
  // causeCode：BREEZE_UNREACHABLE（连不上）或 BREEZE_TIMEOUT（超时后探测也不通）。文案不变，超时多一行原因。
  const causeCode = result.causeCode || '';
  const extra = { ...(causeCode ? { causeCode } : {}), ...(causeCode === 'BREEZE_TIMEOUT' ? { detail: TIMEOUT_DETAIL } : {}) };
  if (!isTask || done === 0) return { phase: 'before', ...extra, text: BEFORE_START_TEXT, actions: ['retry', 'settings'] };
  return { phase: 'midrun', ...extra, done, remaining, text: `Breeze 中途断开，已配好 ${done} 句${remaining !== null ? `，还剩 ${remaining} 句` : ''}`, actions: ['resume'] };
}
export const TIMEOUT_DETAIL = '原因：Breeze 太久没有响应';

// N4：一键成片开始前的健康检查。连不上和「没有响应」（探测超时）都不开始、都给同样的横幅
// （重试连接 / 去设置），只是文案不同；不承诺自动重试，也绝不换引擎。health 是 normalizeBreezeStatus 的结果。
export const NO_RESPONSE_TEXT = 'Breeze 没有响应，可能正忙或卡住了。可以在 Mac 上重启 Breeze，再点重试。';
export function breezeHealthOutage(health) {
  if (!health || health.state !== 'disconnected') return null;
  if (health.cause === 'timeout') return { phase: 'before', causeCode: 'BREEZE_TIMEOUT', text: NO_RESPONSE_TEXT, actions: ['retry', 'settings'] };
  return breezeOutage({ code: BREEZE_UNREACHABLE });
}

// 单句「换一条」失败事件（0037 带 code / causeCode）：只在这一句上提示，不弹整页横幅，也不换引擎。
export function lineTakeError(event = {}) {
  if (event.code !== BREEZE_UNREACHABLE) return event.error || '生成失败';
  return event.causeCode === 'BREEZE_TIMEOUT' ? 'Breeze 太久没有响应，这一句没生成，没有花额度' : 'Breeze 连不上，这一句没生成，没有花额度';
}
export const outageActionLabel = { retry: '重试连接', settings: '去设置', resume: 'Breeze 恢复后继续' };

// 生成进行中，健康检查偶尔超时不算断开（顶部状态不闪「未连接」）。
export function steadyBreezeStatus(previous, next, { generating = false } = {}) {
  if (generating && next?.state === 'disconnected' && previous?.state !== 'disconnected') return { ...(previous?.state === 'connected' ? previous : next), state: 'connected', label: '生成中' };
  return next;
}

// 换到豆包后的第一次生成：先确认（M 句、约 X 字、声音和 Breeze 不一样）。
// X = estimatedBillableCharacters（扣掉已知缓存命中）；没绑音色时服务端给 null，就用总字数 characters 当上限。
// 0 句要生成时不需要这条确认（返回空串）。
export function doubaoSwitchConfirm(estimate = {}) {
  const lines = num(estimate.requestCount) ?? num(estimate.dialogueCount) ?? 0;
  if (!lines) return '';
  const chars = num(estimate.estimatedBillableCharacters) ?? num(estimate.characters);
  return chars === null ? `接下来 ${lines} 句会用豆包生成，会按字扣额度，声音也会和 Breeze 不一样` : `接下来 ${lines} 句会用豆包生成，约扣 ${chars} 字额度，声音也会和 Breeze 不一样`;
}

// fe-0010（Design）：换豆包后第一次生成的确认框。标题只说上限「最多约扣 X 字额度」，
// X = 全部待生成句的字数 characters（没扣缓存，所以是「最多」）；没有就退回 estimatedBillableCharacters。
// 0 句要生成时返回 null（不需要这条确认）。
export function doubaoSwitchDialog(estimate = {}) {
  const lines = num(estimate.requestCount) ?? num(estimate.dialogueCount) ?? 0;
  if (!lines) return null;
  const chars = num(estimate.characters) ?? num(estimate.estimatedBillableCharacters);
  return {
    title: chars === null ? '会按字扣豆包额度' : `最多约扣 ${chars} 字额度`,
    detail: `接下来 ${lines} 句会用豆包生成，声音也会和 Breeze 不一样`,
  };
}

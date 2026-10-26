// 句后停顿默认值：服务端混音（media-store.js resolveSceneTimeline）和前端时间轴
// 预览（src/lib/timeline.js）共用这一份，避免两边算出不同的总长。
//
// 慢速台词自动多留一点气口（0010）：语音指令不再要求“句间多停顿”（模型会把
// 停顿塞进句子内部，导致句中断裂），改由混音层在句后加长停顿。
//   pace ≥ 90（速度 ≥ 0.9，默认 90）：320ms，与原来完全一致；
//   pace < 90：每慢 1 档加 15ms，最多加 240ms（pace 74 及以下封顶 560ms）。
// 只在用户没有手动设置 mix.gapAfterMs 时生效；手动值（含 0）永远优先。
export const BASE_GAP_AFTER_MS = 320;
export const SLOW_PACE_THRESHOLD = 90;
export const SLOW_GAP_STEP_MS = 15;
export const SLOW_GAP_MAX_EXTRA_MS = 240;

export function defaultGapAfterMs(line) {
  const pace = Number(line?.pace);
  if (!Number.isFinite(pace) || pace <= 0 || pace >= SLOW_PACE_THRESHOLD) return BASE_GAP_AFTER_MS;
  return BASE_GAP_AFTER_MS + Math.min(SLOW_GAP_MAX_EXTRA_MS, Math.round((SLOW_PACE_THRESHOLD - pace) * SLOW_GAP_STEP_MS));
}

export function resolveGapAfterMs(line) {
  const explicit = line?.mix?.gapAfterMs;
  return explicit === undefined || explicit === null || explicit === '' ? defaultGapAfterMs(line) : explicit;
}

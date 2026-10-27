import { emotionScaleFor } from '../../shared/generation-requests.mjs';

// 强度一律按数字发（0 而不是 "0"）：豆包只把数字 0 当 40，字符串 "0" 会落到旧规则。
// 空 / 非数字原样交给服务端的缺省规则（按 40）。
export function numericIntensity(value) {
  if (value === null || value === undefined || value === '') return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

// 编辑台词时的补丁：intensity 先转成数字再存（之后 PUT 项目、生成请求都是数字）。
export function normalizeLinePatch(patch = {}) {
  return 'intensity' in patch ? { ...patch, intensity: numericIntensity(patch.intensity) } : patch;
}

// 方向实验的一个变体请求。base 是台词本身的请求（可能带着台词强度 0 的 emotionOff），
// 所以每个变体都显式写 emotionOff：Breeze 上 = 变体强度恰好为 0；豆包 / 自定义一律 false
// （服务端只认严格的 true）。emotionScale 用 emotionScaleFor，不做 || 40 / || 0.4 兜底。
export function labVariantRequest(base, variant = {}, provider) {
  const intensity = numericIntensity(variant.intensity);
  return {
    ...base,
    emotion: variant.emotion,
    emotionScale: emotionScaleFor(intensity),
    subtext: variant.subtext || '',
    distance: variant.distance || '',
    emotionOff: provider === 'breeze' && intensity === 0,
  };
}

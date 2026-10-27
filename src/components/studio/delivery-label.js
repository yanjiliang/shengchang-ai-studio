import { intensityOf, showsNoEmotion, NO_EMOTION_LABEL } from '../../lib/intensity.js';

// Derived fresh from the live fields on every render — the stored
// line.delivery snapshot could drift after Inspector edits.
// 强度 0 原样保留；Breeze 下 0 = 不加情绪，豆包下如实写 0%。
export function deliveryLabel(line, provider) {
  const intensity = intensityOf(line.intensity);
  const pace = (Number(line.pace) || 90) / 100;
  const mood = showsNoEmotion(intensity, provider) ? NO_EMOTION_LABEL : `${line.emotion || '克制'} ${intensity}%`;
  return `${mood} · 语速 ${pace.toFixed(2)}`;
}

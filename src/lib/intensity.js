// 情绪强度 0–100。0 必须原样保留，不能被 `|| 40` 吞成 40。
// 缺省 / 不是数字才用 40；超过 100 夹到 100（服务端同样夹）。
export const DEFAULT_INTENSITY = 40;
export const NO_EMOTION_LABEL = '不加情绪';
export const NO_SUBTEXT_NOTE = '无情绪时不发送';
// 唯一开关：强度 0 时 Breeze 只发语速、不发情绪和情绪来由（0038 定稿）。
// 豆包仍是旧行为（0 照常发），所以只对 Breeze 生效；要改规则只改这一行。
export const BREEZE_DROPS_EMOTION_AT_ZERO = true;
export function intensityOf(value) {
  const number = value === null || value === undefined || value === '' ? NaN : Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : DEFAULT_INTENSITY;
}
export const isNoEmotion = (value) => intensityOf(value) === 0;
// 「不加情绪」/「无情绪时不发送」只在 Breeze 下说；豆包老老实实显示 0。
export const showsNoEmotion = (value, provider) => BREEZE_DROPS_EMOTION_AT_ZERO && provider === 'breeze' && isNoEmotion(value);

// 豆包上强度 0 按 40 处理（0039）：滑块照实显示 0，旁边只给这条提示，不说「不加情绪」。
export const DOUBAO_ZERO_HINT = '豆包上强度 0 按 40 处理';
export const zeroIntensityHint = (value, provider) => (isNoEmotion(value) ? (provider === 'breeze' ? NO_EMOTION_LABEL : provider === 'volcengine-api-key' ? DOUBAO_ZERO_HINT : '') : '');


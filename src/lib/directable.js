// “可导演”标记（Design 规则）：只按“实测验证过 / 没验证过”二分，不做第二套标记。
// 数据只有一份：server/directable-voices.json（Back-end 的实测白名单，
// 一键成片的音色轮换也读它）。复测后只改那个数据文件，前端自动跟上。
import catalog from '../../server/directable-voices.json' with { type: 'json' };

export const DIRECTABLE_LABEL = '可导演';
export const DRIFT_RISK_HINT = '这个音色可能被情绪带偏';

// 只有 directable === true 才算验证过；false（实测不可导演）和未收录一样，都不挂标记。
export function isVerifiedDirectable(voiceId, voices = catalog.voices) {
  return Boolean(voiceId) && voices?.[voiceId]?.directable === true;
}

// 服务端只在 豆包 API Key + seed-tts-2.0 时把情绪/潜台词写进 context_texts
// （model-adapters.js synthesizeVolcengineApiKey）；其他引擎不发指令，也就谈不上被带偏。
export function sendsVoiceInstructions(config) {
  return config?.provider === 'volcengine-api-key' && config?.resourceId === 'seed-tts-2.0';
}

// 与 voiceInstructions() 的情绪部分对齐：有情绪词或潜台词就会生成情绪指令。
// 单独的语速变化不算“情绪指令”。
export function hasEmotionDirection(line) {
  return Boolean(String(line?.emotion || '').trim() || String(line?.subtext || '').trim());
}

// 音色的短名：优先用白名单条目里的 label（Back-end 以后可加），否则从 voice_id 去掉
// zh_female_ / zh_male_ 前缀和 _uranus_bigtts / _bigtts 后缀，例如 zh_female_vv_uranus_bigtts → vv。
export function voiceShortName(voiceId, voices = catalog.voices) {
  const label = voices?.[voiceId]?.label;
  if (label) return label;
  return String(voiceId || '').replace(/^zh_(female|male)_/, '').replace(/(_uranus)?_bigtts$/, '') || String(voiceId || '');
}

export function directableVoiceNames(voices = catalog.voices) {
  return Object.keys(voices || {}).filter((voiceId) => voices[voiceId]?.directable === true).map((voiceId) => voiceShortName(voiceId, voices));
}

// 角色音色页顶部只放一条横幅（Design 定稿，替代逐张角色卡的提示）：
// 当前配置真的会发情绪指令，且至少一个已绑定音色的角色用的是没验证可导演的音色时才显示。
// 名单从 directable-voices.json 生成，复测后自动跟上。返回空字符串表示不显示。
export function castDirectableBanner({ characters, voiceMap, config, voices = catalog.voices }) {
  if (!sendsVoiceInstructions(config)) return '';
  const risky = (characters || []).some((character) => {
    const voiceId = voiceMap?.[character.id];
    return Boolean(voiceId) && !isVerifiedDirectable(voiceId, voices);
  });
  if (!risky) return '';
  const names = directableVoiceNames(voices);
  return names.length
    ? `目前只有 ${names.join('、')} 实测可导演，其余音色加情绪指令可能带偏音色`
    : '目前还没有实测可导演的音色，加情绪指令可能带偏音色';
}

// 已绑定、没验证过、会发指令、这句有情绪指令 → 提示可能被情绪带偏。
export function emotionDriftRisk({ line, voiceId, config, voices }) {
  return Boolean(voiceId) && sendsVoiceInstructions(config) && hasEmotionDirection(line) && !isVerifiedDirectable(voiceId, voices);
}

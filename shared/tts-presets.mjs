// 设置页切换语音引擎时往草稿里填的预设值。前端（SettingsView 的 providerPresets）和服务端
// （tts-providers.js 的 applyTtsUpdate：切引擎那次保存里等于预设的字段视为“没改”）共用这一份，
// 两边不会漂移。纯数据，不依赖 node / 浏览器 API。
export const VOLCENGINE_DEFAULT_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';

export const TTS_UI_PRESETS = {
  demo: { endpoint: '本地内置，无外部请求', resourceId: 'demo', model: 'demo-voice-engine', audioFormat: 'wav' },
  'volcengine-api-key': { endpoint: VOLCENGINE_DEFAULT_ENDPOINT, resourceId: 'seed-tts-2.0', model: '', audioFormat: 'mp3' },
  custom: { endpoint: '', resourceId: '', model: '', audioFormat: 'mp3' },
  breeze: {},
};

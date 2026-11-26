// 句后停顿默认值：服务端混音（media-store.js resolveSceneTimeline）和前端时间轴
// 预览（src/lib/timeline.js）共用这一份，避免两边算出不同的总长。
//
// 慢速台词自动多留一点气口（0010）：只对 Breeze 渲染的台词（line.audioEngine ===
// 'breeze'）生效——Breeze 的指令不再要求“句间多停顿”（模型会把停顿塞进句子内部），
// 改由混音层在句后加长停顿。豆包台词仍由指令负责停顿，句后停顿保持 320ms。
//   pace ≥ 90（速度 ≥ 0.9，默认 90）：320ms，与原来完全一致；
//   pace < 90：每慢 1 档加 15ms，最多加 240ms（pace 74 及以下封顶 560ms）。
// 只在用户没有手动设置 mix.gapAfterMs 时生效；手动值（含 0）永远优先。
export const BASE_GAP_AFTER_MS = 320;
export const SLOW_PACE_THRESHOLD = 90;
export const SLOW_GAP_STEP_MS = 15;
export const SLOW_GAP_MAX_EXTRA_MS = 240;

export function defaultGapAfterMs(line) {
  if (line?.audioEngine !== 'breeze') return BASE_GAP_AFTER_MS;
  const pace = Number(line?.pace);
  if (!Number.isFinite(pace) || pace <= 0 || pace >= SLOW_PACE_THRESHOLD) return BASE_GAP_AFTER_MS;
  return BASE_GAP_AFTER_MS + Math.min(SLOW_GAP_MAX_EXTRA_MS, Math.round((SLOW_PACE_THRESHOLD - pace) * SLOW_GAP_STEP_MS));
}

export function resolveGapAfterMs(line) {
  const explicit = line?.mix?.gapAfterMs;
  return explicit === undefined || explicit === null || explicit === '' ? defaultGapAfterMs(line) : explicit;
}

// 动作音效（sfx）默认跟随脚本位置：未手动设 mix.startMs 且无旧版 line.time 时，
// 锚定到当前对白游标，并推进一段有上限的节奏气口（短音效完整播完 + 200ms 气口，
// 长音效最多推进 1.8s，让后续对白自然搭在尾音上，避免长脚步/人群造成大段空白）。
export const SFX_GAP_AFTER_MS = 200;
export const SFX_MAX_ADVANCE_MS = 1800;

export function sfxCursorAdvanceMs(durationMs) {
  const ms = Number(durationMs);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(Math.round(ms) + SFX_GAP_AFTER_MS, SFX_MAX_ADVANCE_MS);
}

export function parseLegacyStartMs(value) {
  const match = String(value || '').match(/^(\d+):(\d{2})$/);
  return match ? (Number(match[1]) * 60 + Number(match[2])) * 1000 : null;
}

// 各轨道默认混音参数：服务端混音（media-store.js）与前端时间轴（src/lib/timeline.js）共用。
// 动作音效（sfx）淡入默认 0ms、淡出 100ms，保留敲门/拍桌/拔剑等瞬态冲击，不再按声床套 400ms 淡入。
export function defaultGainDb(type) {
  if (type === 'dialogue') return 0;
  if (type === 'music') return -18;
  if (type === 'ambient') return -14;
  return -6;
}

export function defaultFadeInMs(type) {
  return type === 'ambient' || type === 'music' ? 400 : 0;
}

export function defaultFadeOutMs(type) {
  if (type === 'dialogue') return 0;
  if (type === 'sfx') return 100;
  return 700;
}

export function defaultLoop(type) {
  return type === 'ambient' || type === 'music';
}

// 说话距离的混音声场预设：TTS 引擎不响应距离指令，统一在 FFmpeg 混音层做声学建模。
// 滤镜均采用标准 FFmpeg 内置滤波（highpass/lowpass/bass/treble/aecho/volume），
// 反射延迟采用非整数互质毫秒数避免纯音/窄带梳状共振；近讲保持干声直通。
export const DISTANCE_OPTIONS = ['耳语', '近讲', '中距', '远距'];

export const DISTANCE_PRESETS = {
  耳语: {
    label: '耳语',
    summary: '贴耳近场：轻提近讲温暖度与气声、整体压低音量',
    filters: ['highpass=f=80', 'bass=g=2.5:f=180:t=q:w=0.8', 'treble=g=2:f=5500:t=q:w=0.8', 'volume=-3.5dB'],
  },
  近讲: {
    label: '近讲',
    summary: '基准干声，不做距离衰减',
    filters: [],
  },
  中距: {
    label: '中距',
    summary: '退后一步：柔和衰减并加轻微室内早反射',
    filters: ['highpass=f=130', 'lowpass=f=7500', 'aecho=0.85:0.88:19.3|37.7:0.18|0.10', 'volume=-0.5dB'],
  },
  远距: {
    label: '远距',
    summary: '远处声场：高频空气吸收、明显衰减与空间回响',
    filters: ['highpass=f=240', 'lowpass=f=3200', 'aecho=0.75:0.80:29.3|53.7|89.1:0.30|0.20|0.12', 'volume=-2.0dB'],
  },
};

export function normalizeDistance(value) {
  const text = String(value || '').trim();
  if (!text) return '近讲';
  if (DISTANCE_PRESETS[text]) return text;
  if (/耳语|贴耳|气声|窃窃私语|whisper/i.test(text)) return '耳语';
  if (/远距|远处|远景|遥远|喊话|隔门|门外|distant|far/i.test(text)) return '远距';
  if (/中距|中景|中等|适中|稍远|medium|mid/i.test(text)) return '中距';
  return '近讲';
}

export function distanceFilters(value) {
  return [...DISTANCE_PRESETS[normalizeDistance(value)].filters];
}

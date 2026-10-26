import { TTS_UI_PRESETS } from '../../shared/tts-presets.mjs';
// 配音引擎（本地 Breeze-TTS-2 / 豆包）的纯逻辑：识别当前引擎、Breeze 预设、
// 用时估算、状态归一化。界面文案集中在这里，方便测试和统一用词（用「字」，不用「字符」）。

export const BREEZE_DEFAULT_BASE = 'http://127.0.0.1:4180';
export const BREEZE_MODEL = 'breeze-tts-2';
export const BREEZE_LICENSE_NOTE = 'Breeze-TTS-2 生成，仅限非商业用途';
export const BREEZE_LICENSE_FULL = 'Breeze 模型权重及生成音频仅限研究与非商业使用';
export const BREEZE_HARDWARE_NOTE = '需要 Apple 芯片的 Mac，建议 24 GB 以上内存（16 GB 未测试），首次需下载约 7 GB 模型';
export const BREEZE_TIME_NOTE = '生成用时约为音频时长的 1.6–1.85 倍';
export const BREEZE_START_HINT = '在 Mac 上运行 breeze-deploy/start.sh 启动本地服务';

// Design：音频时长 ≈ 字数 × 0.19 秒；生成用时 ≈ 音频时长 × 1.75，展示为 1.6–1.85 倍区间。
export const SECONDS_PER_CHAR = 0.19;
export const BREEZE_RATIO = { low: 1.6, mid: 1.75, high: 1.85 };

// 旧配置：原生 provider 'breeze' 之前用自定义 HTTP 接口接到本地 /voice_clone。
const isLocalBreezeEndpoint = (endpoint) => /\/voice_clone\/?$/.test(String(endpoint || ''));

// 'breeze' | 'doubao' | 'demo' | 'custom' | 'none'
export function engineOf(config) {
  if (!config || config.provider === 'unavailable') return 'none';
  if (config.provider === 'breeze' || config.engine === 'breeze') return 'breeze';
  if (config.provider === 'custom' && (config.model === BREEZE_MODEL || isLocalBreezeEndpoint(config.endpoint))) return 'breeze';
  if (config.provider === 'volcengine-api-key') return 'doubao';
  if (config.provider === 'demo') return 'demo';
  return 'custom';
}

export const isBreeze = (config) => engineOf(config) === 'breeze';
// 0006 的计费界面（计费字数、复用缓存不计费、预计扣费）只对按字计费的引擎有意义。
export const showsBilling = (config) => !isBreeze(config);
// 「可导演」只针对豆包。
export const showsDirectable = (config) => engineOf(config) === 'doubao';
// Breeze 不需要 API Key；豆包和自定义接口需要。
export const needsCredential = (config) => !['demo', 'breeze', 'none'].includes(engineOf(config));

// 原生 Breeze 预设（openapi PublicConfig：provider 'breeze' + breezeEndpoint）。
// 豆包的 endpoint / accessKey 是独立字段，切到 Breeze 不覆盖，切回豆包只改 provider。
export function breezePreset(base = BREEZE_DEFAULT_BASE) {
  return { provider: 'breeze', breezeEndpoint: normalizeBreezeBase(base) || BREEZE_DEFAULT_BASE };
}
// Breeze 服务地址只要「主机:端口」那一段：用户常把 …/tts、…/voices 整个贴进来。
// 服务端保存时也会去掉末尾的 /tts；前端先规整一遍并提示。
export function normalizeBreezeBase(value) {
  let text = String(value || '').trim().replace(/\/+$/, '');
  for (let i = 0; i < 3; i += 1) text = text.replace(/\/(?:tts|voices|voice_clone|health)$/i, '').replace(/\/+$/, '');
  return text;
}
export const BREEZE_TTS_STRIPPED = '已去掉末尾的 /tts，只需填服务地址';
export function breezeBaseHint(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const base = normalizeBreezeBase(raw);
  if (!/^https?:\/\/[^/\s]+/i.test(base)) return '地址要写成 http://主机:端口，例如 http://127.0.0.1:4180';
  const trimmed = raw.replace(/\/+$/, '');
  if (base === trimmed) return '';
  // Design 文案：/tts 是最常见的误填；其他路径一样去掉，只是把去掉的那段写出来。
  const removed = trimmed.slice(base.length) || '/tts';
  return /^\/tts$/i.test(removed) ? BREEZE_TTS_STRIPPED : `已去掉末尾的 ${removed}，只需填服务地址`;
}
export const breezeBaseOf = (config) => String(config?.provider === 'breeze' ? config.breezeEndpoint || BREEZE_DEFAULT_BASE : String(config?.endpoint || '').replace(/\/voice_clone\/?$/, '') || BREEZE_DEFAULT_BASE).replace(/\/+$/, '');

// 文本理解模型：任何 OpenAI 兼容的 /chat/completions。只有火山方舟（*.volces.com）必须填 Key
// （与服务端 llmApiKeyRequired 同一规则；草稿里改了地址时前端先按这个规则算）。
export function llmKeyRequired(endpoint) {
  try { return /(^|\.)volces\.com$/i.test(new URL(String(endpoint || '')).hostname); } catch { return false; }
}

// 预设和服务端同一份（shared/tts-presets.mjs TTS_UI_PRESETS）。
export const DOUBAO_PRESET = { provider: 'volcengine-api-key', ...TTS_UI_PRESETS['volcengine-api-key'] };

const charCount = (text) => [...String(text || '')].length;
export const estimateAudioSeconds = (chars) => Math.max(0, Number(chars) || 0) * SECONDS_PER_CHAR;

// 输入：字数，或 { text }，或 { audioSeconds }。输出生成用时区间（秒）。
export function breezeGenerationSeconds(input) {
  const audio = typeof input === 'number' ? estimateAudioSeconds(input)
    : Number.isFinite(input?.audioSeconds) ? input.audioSeconds
    : estimateAudioSeconds(charCount(input?.text));
  return { audioSeconds: audio, low: audio * BREEZE_RATIO.low, mid: audio * BREEZE_RATIO.mid, high: audio * BREEZE_RATIO.high };
}

export function formatSeconds(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (value < 60) return `${value} 秒`;
  const minutes = Math.floor(value / 60); const rest = value % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

export function formatSecondsRange(low, high) {
  const a = Math.max(1, Math.round(low)); const b = Math.max(a, Math.round(high));
  if (b < 60) return a === b ? `约 ${a} 秒` : `约 ${a}–${b} 秒`;
  const minA = Math.max(1, Math.round(a / 60)); const minB = Math.max(minA, Math.round(b / 60));
  return minA === minB ? `约 ${minA} 分钟` : `约 ${minA}–${minB} 分钟`;
}

// 一键成片 / 批量生成的确认框：Breeze 不显示扣费，改显示预计用时。
// estimate 是 one-click-estimate 的返回：estimatedBillableCharacters = 需要新生成的字数（命中缓存的不算）。
export function breezeEstimateText(estimate) {
  if (!estimate) return { main: '', note: '' };
  if (estimate.requestCount === 0) return { main: '全部已有音频，无需生成', note: '' };
  const total = Number(estimate.characters) || 0;
  const known = Number.isFinite(Number(estimate.estimatedBillableCharacters)) && estimate.estimatedBillableCharacters !== null;
  const low = known ? Number(estimate.estimatedBillableCharacters) : total;
  const high = known ? Math.min(total || low, low + (Number(estimate.unknownCharacters) || 0)) : total;
  if (high === 0) return { main: '全部可复用缓存，无需生成', note: '' };
  const range = formatSecondsRange(breezeGenerationSeconds(low).low, breezeGenerationSeconds(high).high);
  return { main: `本地 Breeze · 预计用时${range}`, note: `按 ${low === high ? low : `${low}–${high}`} 字估算；${BREEZE_TIME_NOTE}。${BREEZE_LICENSE_NOTE}` };
}

// 单句（重渲这句）：Breeze 显示用时，豆包显示约 N 字（Design：text.length，含标点）。
export function lineCostText(line, config) {
  const chars = String(line?.text || '').length;
  if (isBreeze(config)) {
    const range = breezeGenerationSeconds({ text: line?.text });
    return { main: `本地 Breeze · 预计用时${formatSecondsRange(range.low, range.high)}`, note: `${BREEZE_TIME_NOTE}；不计费` };
  }
  if (engineOf(config) === 'demo') return { main: '离线演示引擎 · 免费', note: '' };
  return { main: `约 ${chars} 字`, note: '按台词字数估算，以火山控制台扣费为准' };
}

// GET /api/engines/breeze/status 的返回归一化。接口还没有（404）时 state = 'unknown'。
export function normalizeBreezeStatus(payload, { httpStatus } = {}) {
  if (httpStatus === 404 || httpStatus === 501) return { state: 'unknown', label: '状态接口未接入', detail: '服务端还没有 Breeze 状态接口' };
  if (!payload || typeof payload !== 'object') return { state: 'disconnected', label: '未连接', detail: '' };
  const connected = payload.reachable === true || payload.ok === true || payload.connected === true || payload.state === 'connected' || payload.status === 'ok';
  // 0036：via busy = 正在 / 刚刚生成，服务端没探测，算连得上；latencyMs / voiceCount 为 null。
  const busy = payload.via === 'busy' || payload.busy === true || Number(payload.queueLength) > 0 || Number(payload.inFlightCount) > 0;
  // 服务端的健康检查真的请求了 Breeze 的 /voices；带回音色数就显示出来。
  const voiceCount = Array.isArray(payload.voices) ? payload.voices.length : Number.isFinite(payload.voiceCount) ? payload.voiceCount : null;
  return {
    state: connected ? 'connected' : 'disconnected',
    label: connected ? (busy ? '生成中' : '已连接') : '未连接',
    detail: connected ? [payload.model, payload.device, voiceCount !== null ? `已读到 ${voiceCount} 个音色` : '', Number.isFinite(payload.latencyMs) ? `${payload.latencyMs} ms` : ''].filter(Boolean).join(' · ') : String(payload.error || payload.message || ''),
    endpoint: payload.endpoint || payload.url || '',
    via: payload.via || '',
    inFlightCount: Number(payload.inFlightCount) || 0,
    lastSuccessAt: Number.isFinite(payload.lastSuccessAt) ? payload.lastSuccessAt : null,
    queueLength: Number(payload.queueLength) || 0,
    currentLineEtaSec: Number.isFinite(payload.currentLineEtaSec) ? payload.currentLineEtaSec : null,
  };
}

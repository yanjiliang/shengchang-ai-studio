import { randomUUID } from 'node:crypto';
import { breezeCustomConfig, breezeSettings, explainBreezeFailure, parseSeedHeader, upstreamError } from './breeze.js';
import { numberOr } from '../shared/generation-requests.mjs';

function requestTimeout(timeoutMs = 90_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function parseJsonObject(value, fieldName) {
  try {
    const parsed = JSON.parse(value || '{}');
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    return parsed;
  } catch {
    throw new Error(`${fieldName}必须是有效的 JSON 对象`);
  }
}

function interpolateTemplate(template, values) {
  return template.replace(/{{\s*([\w]+)\s*}}/g, (_, key) => {
    const value = values[key];
    if (typeof value === 'number') return String(value);
    return JSON.stringify(value ?? '').slice(1, -1);
  });
}

function audioMime(format) {
  if (format === 'wav') return 'audio/wav';
  if (format === 'ogg_opus') return 'audio/ogg';
  return 'audio/mpeg';
}

function extractBase64(payload) {
  const candidates = [payload?.data, payload?.audio, payload?.audio_data, payload?.result?.data, payload?.result?.audio, payload?.result?.audio_data];
  return candidates.find((item) => typeof item === 'string' && item.length > 20) || null;
}

function decodeBase64Audio(value) {
  return Buffer.from(value.replace(/^data:audio\/[^;]+;base64,/, ''), 'base64');
}

// The v3 unidirectional endpoint answers with chunked NDJSON: one JSON object
// per line, each carrying a base64 audio slice. Single-object responses stay
// valid, so try the whole body first and only then fall back to stream parsing.
// The body is read in full (response.text()) before parsing, so a line split
// across network reads can't lose an event. The scanner below also tolerates
// CRLF, a missing trailing newline, several objects on one line ("}{") and
// SSE-style "data: " prefixes; any other byte outside an object means the
// body is not a JSON stream at all.
export function parseJsonStream(text) {
  const payloads = [];
  let depth = 0; let start = -1; let inString = false; let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { if (depth === 0) return null; inString = true; continue; }
    if (char === '{') { if (depth === 0) start = index; depth += 1; continue; }
    if (char === '}') {
      if (depth === 0) return null;
      depth -= 1;
      if (depth === 0) {
        try { payloads.push(JSON.parse(text.slice(start, index + 1))); } catch { return null; }
      }
      continue;
    }
    if (depth > 0) continue;
    if (/\s/.test(char)) continue;
    // SSE framing: "data:" before an object, "event:/id:" lines are ignored.
    const rest = text.slice(index, index + 6);
    if (rest.startsWith('data:')) { index += 4; continue; }
    const lineEnd = text.indexOf('\n', index);
    if (/^(event|id|retry):/.test(text.slice(index, index + 6))) { index = lineEnd < 0 ? text.length : lineEnd; continue; }
    return null;
  }
  if (depth !== 0) return null;
  return payloads.length ? payloads : null;
}

// 豆包 v3 流式接口：音频分片 code=0，流的最后一个事件 code=20000000 表示正常结束
// （同时携带 usage）。其余非零码才是业务错误。
const DOUBAO_SUCCESS_CODES = new Set([0, 20000000]);

function assertNoServiceError(payload) {
  const code = Number(payload?.code);
  if (Number.isFinite(code) && !DOUBAO_SUCCESS_CODES.has(code)) throw new Error(`模型服务返回错误码 ${code}: ${payload.message || payload.Message || '没有错误描述'}`);
}

// 请求头 X-Control-Require-Usage-Tokens-Return: * 让豆包在结束事件里返回用量，
// 例如 { usage: { text_words: 12 } }。保留原始对象，另外归一出计费字数。
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const billed = Number(usage.text_words ?? usage.textWords);
  return { ...usage, billedCharacters: Number.isFinite(billed) ? billed : null };
}

// 调试日志：豆包流正常结束却没带 usage。只记录事件数、code 序列和最后一个
// 事件的键名（不记录音频、文本或任何请求头/密钥），方便对照原始响应。
function logMissingUsage(payloads) {
  const last = payloads[payloads.length - 1] || {};
  const codes = [...new Set(payloads.map((item) => item?.code))].join('/');
  console.warn(`[doubao-tts] 流结束但没有 usage：events=${payloads.length} codes=${codes} lastEventKeys=${Object.keys(last).join(',')}`);
}

// 音色代际 vs 模型资源校验：1.0 音色（*_mars_bigtts / *_moon_bigtts）不能用于
// seed-tts-2.0 / seed-icl-2.0。识别不了的 id（克隆音色 S_xxx 等）放行，交给服务端判断。
const VOICE_GENERATION_RULES = [
  { pattern: /_(mars|moon)_bigtts$/, generation: '1.0' },
  { pattern: /_uranus_bigtts$/, generation: '2.0' },
];
const RESOURCE_GENERATIONS = { 'seed-tts-2.0': '2.0', 'seed-icl-2.0': '2.0' };

export function voiceGeneration(voiceId) {
  return VOICE_GENERATION_RULES.find((rule) => rule.pattern.test(String(voiceId || '')))?.generation || null;
}

export function assertVoiceMatchesResource(resourceId, voiceId) {
  const expected = RESOURCE_GENERATIONS[resourceId];
  const actual = voiceGeneration(voiceId);
  if (expected && actual && expected !== actual) {
    const error = new Error(`音色 ${voiceId} 属于豆包 ${actual} 音色，不能用于 ${resourceId}；请在“角色音色”中换成 ${expected} 音色（如 *_uranus_bigtts）`);
    error.code = 'VOICE_MODEL_MISMATCH';
    throw error;
  }
}

async function parseAudioResponse(response, config) {
  if (!response.ok) {
    const message = (await response.text()).slice(0, 800);
    throw new Error(`模型服务返回 ${response.status}: ${message || response.statusText}`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (contentType.startsWith('audio/') || config.responseMode === 'binary') {
    return { buffer: Buffer.from(await response.arrayBuffer()), mime: contentType || audioMime(config.audioFormat) };
  }
  const text = await response.text();
  let payloads;
  try { payloads = [JSON.parse(text)]; }
  catch { payloads = parseJsonStream(text); }
  if (!payloads) throw new Error(`模型服务返回的响应不是有效 JSON: ${text.slice(0, 300)}`);
  const slices = [];
  let usage = null;
  for (const payload of payloads) {
    assertNoServiceError(payload);
    const base64 = extractBase64(payload);
    if (base64) slices.push(decodeBase64Audio(base64));
    // usage 可能在结束事件里，也可能单独成一个事件（在 20000000 前后都有可能）：
    // 取最后一个带 usage 的事件，不因为看到 20000000 就停止解析。
    if (payload?.usage) usage = normalizeUsage(payload.usage);
  }
  if (!slices.length) throw new Error('响应中没有找到音频数据，请检查响应方式和接口版本');
  if (!usage && config.expectUsage) logMissingUsage(payloads);
  return { buffer: Buffer.concat(slices), mime: audioMime(config.audioFormat), usage };
}

// seed-tts-2.0 官方音色的语音指令（additions.context_texts）。2026-10-26 实测
// （zh_female_vv_uranus_bigtts）：情绪和节奏类指令有效，音色类指令（耳语、
// 沙哑、哭腔等）无效，所以这里只写情绪 + 节奏，不出现任何音色词。措辞学官方
// 示例的口语化祈使句（“用特别痛心的语气说”），而不是参数化的“强度约 N%”。
// 声音距离不再进指令：模型不认它，距离感应由混音层处理。
const EMOTION_DEGREE = [
  { min: 0.8, word: '特别特别' },
  { min: 0.6, word: '特别' },
  { min: 0.4, word: '比较' },
  { min: 0, word: '略带一点' },
];

// 豆包措辞保持原样（改了就要升 TTS_INSTRUCTION_VERSION，整批豆包缓存失效、重新计费）。
// Breeze 只写程度、不写停顿：“句间多停顿”会让模型在句子内部插入长停顿、把一句话
// 说断；Breeze 渲染的慢速台词改由混音层加长句后停顿（shared/mix-defaults.mjs）。
function pacingPhrase(speed, { pauseWording = true } = {}) {
  const value = Number(speed) || 1;
  if (value <= 0.9) return pauseWording ? '语速放慢，句间多停顿一下' : '语速稍慢、从容';
  if (value >= 1.1) return '语速加快，说得紧凑一些';
  return '';
}

// 指令逻辑版本：措辞/拼装规则一改就要加一，它进音频缓存键（database.js
// audioContentHash），旧指令生成的缓存自然失效，不会被当成新指令的结果复用。
export const TTS_INSTRUCTION_VERSION = 2;
// Breeze 专用措辞的版本（只进 Breeze 的缓存键，不影响豆包缓存）。1：慢速不写停顿。
// 改为 breezeInstruction（声场为准）时没有加：规则与 1 逐字相同（Tavi 的 server.py 也一样），
// 只多了 300 字上限，现有 Breeze 缓存 / stale 判断不受影响。
export const BREEZE_INSTRUCTION_VERSION = 1;

// 稳定说话人从句（0001 之前就有，0005 恢复，配置 ttsStableSpeaker 控制，默认开）：
// 实测未验证可导演的男声在情绪指令下会漂移（同一角色句间音高/音色不一致），
// 这句话本身不改变音色，只提示模型别跟着情绪跑偏。没有其他指令时不单独发送。
export const STABLE_SPEAKER_CLAUSE = '保持当前基础音色稳定';

export function voiceInstructions(request, { stableSpeaker = true, pauseWording = true } = {}) {
  const fragments = [];
  if (request.emotion) {
    const scale = Math.min(1, Math.max(0.1, numberOr(request.emotionScale, 0.4)));
    const degree = EMOTION_DEGREE.find((item) => scale >= item.min).word;
    fragments.push(`用${degree}${request.emotion}的语气说`);
  }
  const pacing = pacingPhrase(request.speed, { pauseWording });
  if (pacing) fragments.push(pacing);
  const subtext = String(request.subtext || '').trim().slice(0, 100);
  if (subtext) fragments.push(`这句话的情绪来由是：${subtext}`);
  if (fragments.length && stableSpeaker) fragments.push(STABLE_SPEAKER_CLAUSE);
  return fragments.length ? [`${fragments.join('，')}。`] : [];
}

// Breeze /tts 的指令：声场说了算（Breeze 已改为优先用请求里的 instruction，≤ 300 字；
// 缺省 / null 才由 Breeze 自己拼；空字符串 = 不要指令，纯克隆）。规则照搬 Tavi 的
// Breeze server.py（第 37–58 行）——两边一致，接管前后同一参数出同一条指令：
//   - 情绪：emotionScale 缺省 0.4、夹到 [0.1, 1]；≥0.8 特别特别 / ≥0.6 特别 / ≥0.4 比较 /
//     否则 略带一点；“用{程度}{情绪}的语气说”；
//   - speed ≤ 0.9 “语速稍慢、从容”，≥ 1.1 “语速加快，说得紧凑一些”，否则不写；
//   - 潜台词取前 100 字：“这句话的情绪来由是：{潜台词}”；
//   - 用“，”连接、句号结尾；什么都没有 → ''（纯克隆）。
// 不加豆包的“保持当前基础音色稳定”，也不写停顿（慢速句的停顿由混音层加）。
// 措辞 / 规则一改就要加 BREEZE_INSTRUCTION_VERSION（进 Breeze 缓存键）。
// 豆包的 voiceInstructions / TTS_INSTRUCTION_VERSION 与此无关，保持不动。
export const BREEZE_INSTRUCTION_MAX_CHARS = 300;
export function breezeInstruction(request = {}) {
  const parts = [];
  if (request.emotion) {
    const scale = Math.min(1, Math.max(0.1, numberOr(request.emotionScale, 0.4)));
    const degree = EMOTION_DEGREE.find((item) => scale >= item.min).word;
    parts.push(`用${degree}${request.emotion}的语气说`);
  }
  const speed = Number(request.speed) || 1;
  if (speed <= 0.9) parts.push('语速稍慢、从容');
  else if (speed >= 1.1) parts.push('语速加快，说得紧凑一些');
  const subtext = String(request.subtext || '').trim().slice(0, 100);
  if (subtext) parts.push(`这句话的情绪来由是：${subtext}`);
  if (!parts.length) return '';
  return Array.from(`${parts.join('，')}。`).slice(0, BREEZE_INSTRUCTION_MAX_CHARS).join('');
}

// Breeze 在响应头 X-Instruction-B64 里回显它实际用的指令（base64 UTF-8）。没有这个头
// （旧版 Breeze）返回 null。
export function parseInstructionHeader(value) {
  if (value === null || value === undefined) return null;
  try { return Buffer.from(String(value), 'base64').toString('utf8'); } catch { return null; }
}

async function synthesizeVolcengineApiKey(config, request) {
  assertVoiceMatchesResource(config.resourceId, request.voiceId);
  const timeout = requestTimeout(config.engineTimeoutMs?.['volcengine-api-key'] || 90_000);
  try {
    const instructions = config.resourceId === 'seed-tts-2.0' ? voiceInstructions(request, { stableSpeaker: config.ttsStableSpeaker !== false }) : [];
    const response = await fetch(config.endpoint || 'https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
      method: 'POST', signal: timeout.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': config.accessKey,
        'X-Api-Resource-Id': config.resourceId,
        'X-Api-Request-Id': randomUUID(),
        'X-Control-Require-Usage-Tokens-Return': '*',
      },
      body: JSON.stringify({
        req_params: {
          text: request.text,
          speaker: request.voiceId,
          ...(config.model ? { model: config.model } : {}),
          audio_params: {
            format: config.audioFormat,
            sample_rate: config.sampleRate,
            speech_rate: Math.round(((request.speed || 1) - 1) * 100),
          },
          additions: JSON.stringify({
            disable_markdown_filter: true,
            ...(instructions.length ? { context_texts: instructions } : {}),
          }),
        },
      }),
    });
    return parseAudioResponse(response, { ...config, expectUsage: true });
  } finally { timeout.clear(); }
}

async function synthesizeCustom(config, request) {
  const timeout = requestTimeout(config.timeoutMs || config.engineTimeoutMs?.custom || 90_000);
  try {
    const headers = parseJsonObject(config.customHeaders, '自定义请求头');
    if (config.accessKey && !Object.values(headers).some((value) => String(value).includes(config.accessKey))) headers.Authorization ||= `Bearer ${config.accessKey}`;
    let body = interpolateTemplate(config.customBodyTemplate, {
      text: request.text, voiceId: request.voiceId, emotion: request.emotion || '',
      emotionScale: numberOr(request.emotionScale, 1), speed: request.speed || 1, model: config.model, resourceId: config.resourceId,
      subtext: request.subtext || '', distance: request.distance || '',
      // 同一套情绪/节奏指令（与豆包 seed-tts-2.0 同源，含 TTS_INSTRUCTION_VERSION）。
      // Breeze：声场的指令为准（breezeInstruction，可能是 '' = 纯克隆）。其他 custom 服务
      // 沿用豆包同源的指令（含 TTS_INSTRUCTION_VERSION）。
      instruction: config.breeze ? breezeInstruction(request) : (voiceInstructions(request, { stableSpeaker: config.ttsStableSpeaker !== false })[0] || ''),
    });
    // Breeze 预设：显式种子（单句换种子重生成）才进请求体；没有就让服务用默认种子。
    if (config.breeze && Number.isSafeInteger(request.seed)) body = JSON.stringify({ ...JSON.parse(body), seed: request.seed });
    const response = await fetch(config.endpoint, { method: 'POST', signal: timeout.signal, headers: { 'Content-Type': 'application/json', ...headers }, body });
    if (config.breeze && !response.ok) throw await upstreamError(response, '/tts');
    const seed = parseSeedHeader(response.headers.get('x-seed'));
    const audio = await parseAudioResponse(response, config);
    const result = seed === null ? audio : { ...audio, seed };
    if (!config.breeze) return result;
    // 核对 Breeze 实际用的指令；不一致只记日志（说明 Breeze 那边没按声场的来），不报错。
    const sent = JSON.parse(body).instruction ?? null;
    const used = parseInstructionHeader(response.headers.get('x-instruction-b64'));
    if (used !== null && sent !== null && used !== sent) console.warn(`[breeze] /tts 实际指令与声场发送的不一致：sent=${JSON.stringify(sent)} used=${JSON.stringify(used)}`);
    return { ...result, instructionSent: sent, instructionUsed: used };
  } finally { timeout.clear(); }
}

// Breeze-TTS-2 预设：走 custom 适配器，只是地址/模板/超时由预设给出。
async function synthesizeBreeze(config, request) {
  const custom = breezeCustomConfig(config);
  try { return await synthesizeCustom(custom, request); }
  catch (error) { throw explainBreezeFailure(error, { endpoint: breezeSettings(config).endpoint, timeoutMs: custom.timeoutMs }); }
}

function writeWavHeader(buffer, sampleRate = 24000, channels = 1) {
  const header = Buffer.alloc(44);
  const bytesPerSample = 2;
  header.write('RIFF', 0); header.writeUInt32LE(36 + buffer.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(buffer.length, 40);
  return Buffer.concat([header, buffer]);
}

function demoAudio(request, config) {
  const seconds = Math.max(0.8, Math.min(8, request.text.length * 0.115));
  const sampleRate = Number(config.sampleRate) || 24000;
  const samples = Math.floor(seconds * sampleRate);
  const pcm = Buffer.alloc(samples * 2);
  const baseFrequency = 150 + (request.voiceId || '').split('').reduce((sum, char) => sum + char.charCodeAt(0), 0) % 90;
  for (let index = 0; index < samples; index += 1) {
    const envelope = Math.min(1, index / (sampleRate * 0.035), (samples - index) / (sampleRate * 0.06));
    const syllable = 0.55 + 0.45 * Math.sin((2 * Math.PI * index) / (sampleRate * 0.22));
    const sample = Math.sin((2 * Math.PI * baseFrequency * index) / sampleRate) * 0.14 * envelope * syllable;
    pcm.writeInt16LE(Math.round(sample * 32767), index * 2);
  }
  return { buffer: writeWavHeader(pcm, sampleRate), mime: 'audio/wav' };
}

// --- Sound-effect / music-bed generation (SoundPicker 生成 tab) -----------
// Same provider pattern as speech: demo synth (offline placeholder), or a
// custom HTTP template against any text-to-SFX service.

export function validateSoundConfig(config) {
  const provider = config.sfxProvider || 'demo';
  if (provider === 'demo') return;
  if (provider === 'custom') {
    if (!config.sfxEndpoint) throw new Error('请填写音效生成接口地址');
    if (!String(config.sfxCustomBodyTemplate || '').includes('{{prompt}}')) throw new Error('音效请求体模板需包含 {{prompt}}');
    return;
  }
  throw new Error(`不支持的音效生成适配器: ${provider}`);
}

function demoSound(request, config) {
  const sampleRate = Number(config.sampleRate) || 24000;
  const defaultSeconds = request.type === 'music' || request.type === 'ambient' ? 12 : 3;
  const seconds = Math.max(1, Math.min(30, Number(request.durationMs) ? Number(request.durationMs) / 1000 : defaultSeconds));
  const samples = Math.floor(seconds * sampleRate);
  const pcm = Buffer.alloc(samples * 2);
  const seed = [...String(request.prompt || '')].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  let filtered = 0;
  for (let index = 0; index < samples; index += 1) {
    const t = index / sampleRate;
    let sample = 0;
    if (request.type === 'music') {
      const base = 150 + (seed % 6) * 26;
      const chord = Math.sin(2 * Math.PI * base * t) + Math.sin(2 * Math.PI * base * 1.5 * t) + Math.sin(2 * Math.PI * base * 2 * t);
      sample = 0.18 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.15 * t + seed)) * (chord / 3);
    } else if (request.type === 'ambient') {
      const white = Math.random() * 2 - 1;
      filtered += 0.04 * (white - filtered);
      sample = filtered * 0.95 * (0.7 + 0.3 * Math.sin(2 * Math.PI * 0.2 * t + seed));
    } else {
      const decay = Math.exp(-2.2 * t);
      const white = Math.random() * 2 - 1;
      filtered += 0.2 * (white - filtered);
      sample = filtered * decay * 1.4;
    }
    const envelope = Math.min(1, t / 0.05, (seconds - t) / 0.4);
    pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample * envelope)) * 32767), index * 2);
  }
  return { buffer: writeWavHeader(pcm, sampleRate), mime: 'audio/wav' };
}

async function synthesizeSoundCustom(config, request) {
  const timeout = requestTimeout(120_000);
  try {
    const headers = parseJsonObject(config.sfxCustomHeaders, '音效生成请求头');
    if (config.sfxAccessKey && !Object.values(headers).some((value) => String(value).includes(config.sfxAccessKey))) headers.Authorization ||= `Bearer ${config.sfxAccessKey}`;
    const body = interpolateTemplate(config.sfxCustomBodyTemplate, {
      prompt: request.prompt, durationSec: (Number(request.durationMs) || 0) / 1000 || '', type: request.type || 'sfx', model: config.sfxModel,
    });
    const response = await fetch(config.sfxEndpoint, { method: 'POST', signal: timeout.signal, headers: { 'Content-Type': 'application/json', ...headers }, body });
    return parseAudioResponse(response, { ...config, responseMode: 'auto', audioFormat: 'mp3' });
  } finally { timeout.clear(); }
}

export async function synthesizeSound(config, request) {
  validateSoundConfig(config);
  if (!String(request.prompt || '').trim()) throw new Error('音效生成描述不能为空');
  const provider = config.sfxProvider || 'demo';
  if (provider === 'demo') return demoSound(request, config);
  if (provider === 'custom') return synthesizeSoundCustom(config, request);
  throw new Error(`不支持的音效生成适配器: ${provider}`);
}

export function validateProviderConfig(config) {
  if (config.provider === 'demo') return;
  // 本地 Breeze 服务不需要凭证，只要地址合法。
  if (config.provider === 'breeze') { breezeSettings(config); return; }
  if (!config.endpoint) throw new Error('请填写接口地址');
  // 自定义 HTTP 接口（如本机 Breeze TTS）可以不鉴权：凭证只对豆包必填，
  // custom 填了 accessKey 才会附带 Authorization 头。
  if (config.provider === 'volcengine-api-key' && !config.accessKey) throw new Error('请填写访问凭证');
  if (config.provider === 'volcengine-api-key' && !config.resourceId) throw new Error('请选择豆包语音模型');
}

export async function synthesize(config, request) {
  validateProviderConfig(config);
  if (!request.text?.trim()) throw new Error('合成文本不能为空');
  if (!request.voiceId?.trim()) throw new Error('请先在“角色音色”中为该角色绑定 voice_id');
  if (config.provider === 'demo') return demoAudio(request, config);
  if (config.provider === 'volcengine-api-key') return synthesizeVolcengineApiKey(config, request);
  if (config.provider === 'custom') return synthesizeCustom(config, request);
  if (config.provider === 'breeze') return synthesizeBreeze(config, request);
  throw new Error(`不支持的模型适配器: ${config.provider}`);
}

export async function designVoice(config, input) {
  if (config.provider === 'demo') return { voiceId: `demo_${randomUUID().slice(0, 8)}`, preview: await synthesize(config, { text: input.sampleText || '这是角色的声音基准。', voiceId: input.characterId }) };
  const timeout = requestTimeout();
  try {
    if (config.provider === 'volcengine-api-key') {
      if (!input.voiceId?.trim()) throw new Error('请先填写用于设计的基础 speaker_id');
      const response = await fetch('https://openspeech.bytedance.com/api/v3/tts/voice_design', {
        method: 'POST', signal: timeout.signal,
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.accessKey, 'X-Api-Request-Id': randomUUID() },
        body: JSON.stringify({
          speaker_id: input.voiceId.trim(),
          prompt: { text_prompt: String(input.description || '自然、清晰、适合广播剧表演。').slice(0, 200) },
          text: (input.sampleText || '这是角色的声音基准。').slice(0, 300),
          language: 0,
        }),
      });
      if (!response.ok) throw new Error(`音色设计接口返回 ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const payload = await response.json();
      const voiceId = payload.speaker_id || payload.voice_id || payload.data?.speaker_id || payload.data?.voice_id;
      if (!voiceId) throw new Error('音色设计响应中没有返回 speaker_id');
      return { voiceId, status: payload.status, previewUrl: payload.demo_audio || undefined };
    }
    throw new Error('音色设计仅支持新版豆包语音 API Key 连接');
  } finally { timeout.clear(); }
}

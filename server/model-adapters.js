import { randomUUID } from 'node:crypto';

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
// valid, so try the whole body first and only then fall back to line parsing.
function parseJsonLines(text) {
  const payloads = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { payloads.push(JSON.parse(trimmed)); } catch { return null; }
  }
  return payloads.length ? payloads : null;
}

function assertNoServiceError(payload) {
  const code = Number(payload?.code);
  if (Number.isFinite(code) && code !== 0) throw new Error(`模型服务返回错误码 ${code}: ${payload.message || payload.Message || '没有错误描述'}`);
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
  catch { payloads = parseJsonLines(text); }
  if (!payloads) throw new Error(`模型服务返回的响应不是有效 JSON: ${text.slice(0, 300)}`);
  const slices = [];
  for (const payload of payloads) {
    assertNoServiceError(payload);
    const base64 = extractBase64(payload);
    if (base64) slices.push(decodeBase64Audio(base64));
  }
  if (!slices.length) throw new Error('响应中没有找到音频数据，请检查响应方式和接口版本');
  return { buffer: Buffer.concat(slices), mime: audioMime(config.audioFormat) };
}

// The current API supports voice instructions for seed-tts-2.0 official
// voices. Director fields (潜台词/情绪强度/声音距离) only reach the model
// through this channel, so they all fold into one instruction sentence.
function voiceInstructions(request) {
  const fragments = [];
  if (request.emotion) {
    const scale = Math.round(Math.min(1, Math.max(0.1, Number(request.emotionScale) || 0.4)) * 100);
    fragments.push(`以${request.emotion}的情绪自然表达（强度约 ${scale}%）`);
  }
  const subtext = String(request.subtext || '').trim().slice(0, 100);
  if (subtext) fragments.push(`说话意图：${subtext}`);
  const distance = String(request.distance || '').trim();
  if (distance && distance !== '近讲') fragments.push(`声音距离感：${distance}`);
  return fragments.length ? [`请${fragments.join('；')}，保持当前基础音色稳定。`] : [];
}

async function synthesizeVolcengineApiKey(config, request) {
  const timeout = requestTimeout();
  try {
    const instructions = config.resourceId === 'seed-tts-2.0' ? voiceInstructions(request) : [];
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
    return parseAudioResponse(response, config);
  } finally { timeout.clear(); }
}

async function synthesizeCustom(config, request) {
  const timeout = requestTimeout();
  try {
    const headers = parseJsonObject(config.customHeaders, '自定义请求头');
    if (config.accessKey && !Object.values(headers).some((value) => String(value).includes(config.accessKey))) headers.Authorization ||= `Bearer ${config.accessKey}`;
    const body = interpolateTemplate(config.customBodyTemplate, {
      text: request.text, voiceId: request.voiceId, emotion: request.emotion || '',
      emotionScale: request.emotionScale || 1, speed: request.speed || 1, model: config.model, resourceId: config.resourceId,
      subtext: request.subtext || '', distance: request.distance || '',
    });
    const response = await fetch(config.endpoint, { method: 'POST', signal: timeout.signal, headers: { 'Content-Type': 'application/json', ...headers }, body });
    return parseAudioResponse(response, config);
  } finally { timeout.clear(); }
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

export function validateProviderConfig(config) {
  if (config.provider === 'demo') return;
  if (!config.endpoint) throw new Error('请填写接口地址');
  if (!config.accessKey) throw new Error('请填写访问凭证');
  if (config.provider === 'volcengine-api-key' && !config.resourceId) throw new Error('请选择豆包语音模型');
}

export async function synthesize(config, request) {
  validateProviderConfig(config);
  if (!request.text?.trim()) throw new Error('合成文本不能为空');
  if (!request.voiceId?.trim()) throw new Error('请先在“角色音色”中为该角色绑定 voice_id');
  if (config.provider === 'demo') return demoAudio(request, config);
  if (config.provider === 'volcengine-api-key') return synthesizeVolcengineApiKey(config, request);
  if (config.provider === 'custom') return synthesizeCustom(config, request);
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

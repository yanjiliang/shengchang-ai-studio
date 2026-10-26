// Breeze-TTS-2 本地服务（Tavi 在 Mac 上跑的 HTTP 包装，默认 127.0.0.1:4180）。
// 契约：JSON 请求体；成功返回 audio/wav，实际种子在 X-Seed 头；失败返回
// 400/500 + 纯文本。服务一次只跑一个生成（排队见 breeze-queue.js）。
// 这里只放“怎么跟 Breeze 说话”：地址/超时设置、错误翻译、音频响应解析、
// 健康检查与 /voices 注册。台词合成本身仍走 model-adapters.js 里的 custom
// 适配器（breezeCustomConfig 把预设翻译成 custom 配置），不另起一套。

export const BREEZE_DEFAULT_ENDPOINT = 'http://127.0.0.1:4180';
export const BREEZE_DEFAULT_TIMEOUT_MS = 180_000;
export const BREEZE_MIN_TIMEOUT_MS = 5_000;
export const BREEZE_MAX_TIMEOUT_MS = 900_000;
const HEALTH_TIMEOUT_MS = 3_000;

// /tts 的请求体模板（custom 适配器的 customBodyTemplate 语法）。seed 不在模板
// 里：只有显式指定种子时才注入（injectSeed），否则由 Breeze 用默认种子 42。
export const BREEZE_TTS_TEMPLATE = '{"text":"{{text}}","voiceId":"{{voiceId}}","emotion":"{{emotion}}","subtext":"{{subtext}}","speed":{{speed}},"emotionScale":{{emotionScale}},"instruction":"{{instruction}}"}';

// 保存和使用时都走这里：去掉末尾的 / 和 /tts（用户常把完整的 …/tts 粘进来，
// 不去掉就会请求到 /tts/tts）。返回 null = 地址无效。
export function normalizeBreezeEndpoint(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return BREEZE_DEFAULT_ENDPOINT;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\/tts$/i, '').replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

export function normalizeBreezeTimeout(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number <= 0) return BREEZE_DEFAULT_TIMEOUT_MS;
  return Math.min(BREEZE_MAX_TIMEOUT_MS, Math.max(BREEZE_MIN_TIMEOUT_MS, number));
}

export function breezeSettings(config = {}) {
  const endpoint = normalizeBreezeEndpoint(config.breezeEndpoint);
  if (!endpoint) throw Object.assign(new Error('Breeze 服务地址无效：需要 http(s)://主机:端口 形式'), { status: 400 });
  return { endpoint, timeoutMs: normalizeBreezeTimeout(config.breezeTimeoutMs) };
}

// Breeze 预设 → custom 适配器配置。无鉴权（本地服务），返回体是二进制 wav。
export function breezeCustomConfig(config) {
  const { endpoint, timeoutMs } = breezeSettings(config);
  return {
    ...config,
    provider: 'custom',
    endpoint: `${endpoint}/tts`,
    accessKey: '',
    customHeaders: '{}',
    customBodyTemplate: BREEZE_TTS_TEMPLATE,
    responseMode: 'auto',
    audioFormat: 'wav',
    timeoutMs,
    // 标记：custom 适配器据此注入 seed、送纯情绪指令（不加豆包专用的稳定音色从句）、
    // 用 Breeze 的错误语义。
    breeze: true,
  };
}

export class BreezeError extends Error {
  constructor(message, { status = 502, upstreamStatus = null, code = 'BREEZE_ERROR' } = {}) {
    super(message);
    this.name = 'BreezeError';
    this.status = status;
    this.upstreamStatus = upstreamStatus;
    this.code = code;
  }
}

// fetch 抛出的底层错误 → 给人看的中文原因。AbortError 只在我们自己的超时
// 触发时出现（调用方没有别的 abort 来源）。
export function explainBreezeFailure(error, { endpoint, timeoutMs } = {}) {
  if (error instanceof BreezeError) return error;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
    return new BreezeError(`Breeze 请求超时（${Math.round((timeoutMs || 0) / 1000)} 秒未返回）：服务可能正忙或卡住`, { status: 504, code: 'BREEZE_TIMEOUT' });
  }
  const cause = error?.cause?.code || error?.code || '';
  if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(cause) || /fetch failed/i.test(error?.message || '')) {
    return new BreezeError(`无法连接 Breeze 服务（${endpoint}）：请确认本机 Breeze 服务已启动${cause ? `（${cause}）` : ''}`, { status: 503, code: 'BREEZE_UNREACHABLE' });
  }
  return new BreezeError(`Breeze 调用失败：${error?.message || error}`, { status: 502 });
}

async function breezeFetch(config, pathname, { method = 'POST', body, timeoutMs } = {}) {
  const settings = breezeSettings(config);
  const limit = timeoutMs || settings.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  try {
    return await fetch(`${settings.endpoint}${pathname}`, {
      method, signal: controller.signal,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw explainBreezeFailure(error, { endpoint: settings.endpoint, timeoutMs: limit });
  } finally { clearTimeout(timer); }
}

export async function upstreamError(response, pathname) {
  const text = (await response.text().catch(() => '')).trim().slice(0, 500);
  // Breeze 400 = 我们送的参数它不接受（对调用方是 422）；5xx = 服务内部失败（502）。
  return new BreezeError(`Breeze ${pathname} 返回 ${response.status}${text ? `：${text}` : ''}`, { status: response.status < 500 ? 422 : 502, upstreamStatus: response.status, code: 'BREEZE_UPSTREAM' });
}

export function parseSeedHeader(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const seed = Number(value);
  return Number.isSafeInteger(seed) ? seed : null;
}

// 生成类接口（/voice_design、/voice_clone、/voice_direction）：成功必须是 audio/*。
export async function breezeAudio(config, pathname, body) {
  const response = await breezeFetch(config, pathname, { body });
  if (!response.ok) throw await upstreamError(response, pathname);
  const mime = (response.headers.get('content-type') || '').split(';')[0].trim();
  if (!mime.startsWith('audio/')) throw new BreezeError(`Breeze ${pathname} 返回的不是音频（${mime || '未知类型'}）`, { status: 502, code: 'BREEZE_BAD_RESPONSE' });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new BreezeError(`Breeze ${pathname} 返回了空音频`, { status: 502, code: 'BREEZE_BAD_RESPONSE' });
  return { buffer, mime, seed: parseSeedHeader(response.headers.get('x-seed')) };
}

// GET /voices 的三种形状都认（Breeze 这边不改格式）：
//   { "<id>": "<transcript>", ... }   ← 真 Breeze 现在的返回
//   [ { id, transcript }, ... ] 或 [ "<id>", ... ]
//   { voices: [ ... ] }
// 统一成 [{ id, transcript }]。
export function parseBreezeVoices(payload) {
  const fromList = (list) => list.map((item) => (typeof item === 'string' ? { id: item, transcript: '' } : { id: String(item?.id ?? ''), transcript: String(item?.transcript ?? '') })).filter((item) => item.id);
  if (Array.isArray(payload)) return fromList(payload);
  if (payload && typeof payload === 'object') {
    if (Array.isArray(payload.voices)) return fromList(payload.voices);
    const entries = Object.entries(payload);
    if (entries.every(([, value]) => typeof value === 'string' || (value && typeof value === 'object' && !Array.isArray(value)))) {
      return entries.map(([id, value]) => ({ id, transcript: typeof value === 'string' ? value : String(value?.transcript ?? '') }));
    }
  }
  return null;
}

export async function listBreezeVoices(config, { timeoutMs } = {}) {
  const response = await breezeFetch(config, '/voices', { method: 'GET', timeoutMs });
  if (!response.ok) throw await upstreamError(response, '/voices');
  const voices = parseBreezeVoices(await response.json().catch(() => null));
  if (!voices) throw new BreezeError('Breeze /voices 返回格式无法识别（需要 {id: 参考文本}、[{id, transcript}] 或 {voices: [...]}）', { status: 502, code: 'BREEZE_BAD_RESPONSE' });
  return voices;
}

// 同 id 重复注册会覆盖（契约如此），所以注册是幂等的：同一参考音频重锁不出错。
export async function registerBreezeVoice(config, { id, transcript, wavBase64 }) {
  const response = await breezeFetch(config, '/voices', { body: { id, transcript, wav_base64: wavBase64 } });
  if (!response.ok) throw await upstreamError(response, '/voices');
  return { id };
}

// 健康检查：真的请求一次 GET /voices（轻量、只读、不占生成槽）并解析结果。永远不抛。
// status：ok | unreachable（连不上）| timeout | invalid（连上了但 /voices 报错或格式不认）
// | misconfigured（地址无效）。reachable 只有 status = ok 时为 true——“端口开着但接口坏了”
// 不算健康（0020 起；以前那种情况 reachable 也是 true）。
export async function breezeHealth(config) {
  let endpoint;
  try { endpoint = breezeSettings(config).endpoint; } catch (error) {
    return { engine: 'breeze', status: 'misconfigured', reachable: false, endpoint: String(config.breezeEndpoint || ''), latencyMs: null, voiceCount: null, error: error.message };
  }
  const started = Date.now();
  try {
    const voices = await listBreezeVoices(config, { timeoutMs: HEALTH_TIMEOUT_MS });
    return { engine: 'breeze', status: 'ok', reachable: true, endpoint, latencyMs: Date.now() - started, voiceCount: voices.length, error: '' };
  } catch (error) {
    const status = error?.code === 'BREEZE_UNREACHABLE' ? 'unreachable' : error?.code === 'BREEZE_TIMEOUT' ? 'timeout' : 'invalid';
    return { engine: 'breeze', status, reachable: false, endpoint, latencyMs: Date.now() - started, voiceCount: null, error: error.message };
  }
}

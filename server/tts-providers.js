// 语音合成（TTS）按引擎分槽保存：config.ttsProviders[providerId] = { endpoint, accessKey, ... }。
// config.provider 只是“当前用哪个”的选择器；切引擎不再清空别的引擎的地址和 Key。
// 顶层的 endpoint / accessKey / customHeaders … 仍然保留，永远等于当前引擎那一槽（兼容旧 UI 和所有读取方）。
// 文本模型（llm*）和音效（sfx*）不在这里，结构不变。
import { normalizeEndpoint, sameEndpoint } from '../shared/endpoint.mjs';
import { TTS_UI_PRESETS, VOLCENGINE_DEFAULT_ENDPOINT } from '../shared/tts-presets.mjs';

export const TTS_PROVIDER_IDS = ['demo', 'volcengine-api-key', 'breeze', 'custom'];
export const TTS_SLOT_FIELDS = ['endpoint', 'accessKey', 'resourceId', 'model', 'audioFormat', 'sampleRate', 'responseMode', 'customHeaders', 'customBodyTemplate'];
const DEFAULT_BODY_TEMPLATE = '{"text":"{{text}}","voice_id":"{{voiceId}}","emotion":"{{emotion}}","speed":{{speed}}}';
const SECRET_HEADER = /authorization|token|key|secret/i;
export const SAVED_SECRET = '__SAVED_SECRET__';

// 设置页切引擎时往草稿里填的预设值（TTS_UI_PRESETS，前后端共用，见 shared/tts-presets.mjs）。切引擎的那次保存里，
// 等于预设、或只是从上一个引擎原样带过来的字段，视为“没改”，不覆盖目标槽已保存的值。
export { TTS_UI_PRESETS, VOLCENGINE_DEFAULT_ENDPOINT };

export function sanitizeTtsSlot(providerId, raw = {}) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const isVolc = providerId === 'volcengine-api-key';
  // 默认值与旧平铺配置的 DEFAULT_CONFIG 一致（resourceId 默认 seed-tts-2.0、地址默认空），缓存键因此不变。
  const resourceId = isVolc && !['seed-tts-2.0', 'seed-icl-2.0'].includes(input.resourceId) ? 'seed-tts-2.0' : String(input.resourceId ?? 'seed-tts-2.0');
  return {
    endpoint: String(input.endpoint || ''),
    accessKey: String(input.accessKey || ''),
    resourceId,
    model: isVolc ? (resourceId === 'seed-icl-2.0' ? 'seed-tts-2.0-standard' : '') : String(input.model || ''),
    audioFormat: ['mp3', 'wav', 'ogg_opus'].includes(input.audioFormat) ? input.audioFormat : 'mp3',
    sampleRate: Number(input.sampleRate) || 24000,
    responseMode: String(input.responseMode || 'auto'),
    customHeaders: String(input.customHeaders || '{}'),
    customBodyTemplate: String(input.customBodyTemplate || DEFAULT_BODY_TEMPLATE),
  };
}

// 豆包的空地址 = 官方默认地址（适配器本来就这样回落）；只在比较“地址变没变”时这样看，存储原样不动。
export const effectiveTtsEndpoint = (providerId, endpoint) => normalizeEndpoint(providerId === 'volcengine-api-key' && !normalizeEndpoint(endpoint) ? VOLCENGINE_DEFAULT_ENDPOINT : endpoint);

const pickSlot = (source) => Object.fromEntries(TTS_SLOT_FIELDS.filter((field) => source[field] !== undefined).map((field) => [field, source[field]]));

// 旧的平铺配置（0035 之前）只有一份 endpoint/accessKey：
// - 当前是豆包 / 自定义：整份归当前引擎。
// - 当前是 Demo / Breeze（这两个不用这些字段）：0034 之前切引擎不清 Key，平铺字段其实是上一次用的
//   豆包或自定义接口留下的。resourceId 是 seed-* 或地址不是 http(s)（Demo 预设）→ 归豆包，否则归自定义。
// 幂等：已有 ttsProviders 就不再迁移。
export function migrateFlatTts(input, provider) {
  const flat = pickSlot(input);
  const slots = Object.fromEntries(TTS_PROVIDER_IDS.map((id) => [id, sanitizeTtsSlot(id, {})]));
  if (provider === 'volcengine-api-key' || provider === 'custom') slots[provider] = sanitizeTtsSlot(provider, flat);
  else if (flat.accessKey || /^https?:\/\//i.test(String(flat.endpoint || '').trim())) {
    const owner = /^seed-/.test(String(flat.resourceId || '')) || !/^https?:\/\//i.test(String(flat.endpoint || '').trim()) ? 'volcengine-api-key' : 'custom';
    slots[owner] = sanitizeTtsSlot(owner, flat);
  }
  // Demo / Breeze 自己那一槽保留旧的非密钥字段（resourceId / model / 格式 / 采样率进缓存键，迁移后缓存不失效），
  // 但不带 Key 和请求头。
  if (provider === 'demo' || provider === 'breeze') slots[provider] = sanitizeTtsSlot(provider, { ...flat, accessKey: '', customHeaders: '{}' });
  if (!TTS_PROVIDER_IDS.includes(provider)) slots[provider] = sanitizeTtsSlot(provider, flat);
  return slots;
}

// 旧引擎名（0035 之前的 byte-*）迁到豆包槽时的地址。
// 677f831 的本意是“迁移时用官方默认地址”（当时 DEFAULT_CONFIG.endpoint 就是它）；372c256 把 DEFAULT_CONFIG.endpoint
// 改成 ''（全新安装默认 Demo）之后，这条迁移悄悄变成了“地址清空”。
// - byte-v3：与现在的豆包 HTTP 接口同一代协议，用户填的 http(s) 地址（自建代理 / 内网转发）原样保留；
//   没填、或不是 http(s)（例如 wss:// 双向流地址，HTTP 适配器用不了）→ 官方默认地址 VOLCENGINE_DEFAULT_ENDPOINT。
// - byte-v1 / byte-api-key：行为不变（地址置空 = 适配器回落官方默认地址）。
export const LEGACY_BYTE_PROVIDERS = ['byte-api-key', 'byte-v1', 'byte-v3'];
export function legacyByteEndpoint(legacyProvider, endpoint) {
  if (legacyProvider !== 'byte-v3') return '';
  const value = String(endpoint ?? '').trim();
  return /^https?:\/\/\S+$/i.test(value) ? value : VOLCENGINE_DEFAULT_ENDPOINT;
}

export function sanitizeTtsProviders(input, provider) {
  const stored = input?.ttsProviders;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return migrateFlatTts(input || {}, provider);
  const ids = [...new Set([...TTS_PROVIDER_IDS, provider])];
  return Object.fromEntries(ids.map((id) => [id, sanitizeTtsSlot(id, stored[id])]));
}

// 唯一的“当前引擎设置”入口：顶层平铺字段由它生成，所有适配器 / 健康检查 / 就绪判断读到的都是它。
export function activeTtsSettings(config) {
  return config.ttsProviders?.[config.provider] || sanitizeTtsSlot(config.provider, pickSlot(config));
}

export function redactHeaders(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    for (const key of Object.keys(parsed)) if (SECRET_HEADER.test(key)) parsed[key] = SAVED_SECRET;
    return JSON.stringify(parsed, null, 2);
  } catch { return '{}'; }
}

// 不含任何密钥的每槽摘要（给前端看各引擎的保存情况）。
export function publicTtsProviders(slots, hint) {
  return Object.fromEntries(Object.entries(slots || {}).map(([id, slot]) => {
    const { accessKey, customHeaders, ...rest } = slot;
    return [id, { ...rest, customHeaders: redactHeaders(customHeaders), hasKey: Boolean(accessKey), secretHint: hint(accessKey) }];
  }));
}

const differs = (a, b) => String(a ?? '') !== String(b ?? '');

// PUT /api/config 的 TTS 部分：把请求里的平铺字段写进目标引擎那一槽。
// - 不切引擎：请求里给了的字段都写入。
// - 切引擎：只写真正改过的字段（不等于该引擎的 UI 预设，也不等于上一个引擎原样带过来的值）。
// - Key / 请求头密钥：没给新值时，只有本槽规范化后的地址没变才沿用，否则清空（0034 规则，限本槽内）。
export function applyTtsUpdate(current, body, { currentPublic, preserveSecret = true } = {}) {
  const requested = body.provider === undefined ? current.provider : String(body.provider);
  const target = LEGACY_BYTE_PROVIDERS.includes(requested) ? 'volcengine-api-key' : requested;
  const switching = target !== current.provider;
  const saved = current.ttsProviders?.[target] || sanitizeTtsSlot(target, {});
  const preset = TTS_UI_PRESETS[target] || {};
  const next = { ...saved };
  for (const field of TTS_SLOT_FIELDS) {
    if (field === 'accessKey' || body[field] === undefined) continue;
    if (switching && (!differs(body[field], preset[field]) || !differs(body[field], currentPublic?.[field]))) continue;
    next[field] = body[field];
  }
  const sanitized = sanitizeTtsSlot(target, next);
  const sameAddress = sameEndpoint(effectiveTtsEndpoint(target, sanitized.endpoint), effectiveTtsEndpoint(target, saved.endpoint));
  if (!preserveSecret) sanitized.accessKey = String(body.accessKey ?? saved.accessKey ?? '');
  else sanitized.accessKey = body.accessKey ? String(body.accessKey) : sameAddress ? saved.accessKey : '';
  sanitized.customHeaders = mergeSecretHeaders(sanitized.customHeaders, saved.customHeaders, sameAddress);
  return { provider: target, ttsProviders: { ...current.ttsProviders, [target]: sanitized } };
}

// 占位符 → 地址没变还原旧值，变了落空串；地址变了时，原样留着的旧密钥值也清掉（明文新值保留）。
export function mergeSecretHeaders(incoming, saved, keepSaved) {
  try {
    const merged = JSON.parse(incoming || '{}');
    const previous = JSON.parse(saved || '{}');
    for (const key of Object.keys(merged)) {
      if (merged[key] === SAVED_SECRET) merged[key] = keepSaved ? previous[key] ?? '' : '';
      else if (!keepSaved && SECRET_HEADER.test(key) && merged[key] === previous[key]) merged[key] = '';
    }
    return JSON.stringify(merged);
  } catch { return incoming; }
}

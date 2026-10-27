// 已保存密钥在设置页上的样子（0034 起服务端只回 hasXxx + '···abc'，从不回明文）。
// 一律显示「已设置 ···abc」+「更换」；地址（规范化后）改了又没填新 Key → 服务端会清掉旧 Key，提示重新填。
import { sameEndpoint, sameLlmEndpoint } from '../../shared/endpoint.mjs';

export const SAVED_SECRET = '__SAVED_SECRET__';
export const MASKED_SECRET = '已保存，不显示';
export const REENTER_KEY = '改了地址，请重新填 Key';
export const HEADERS_REENTER = '改了地址，请求头里已保存的密钥不会带过去，请重新填';

// 老格式 'abc••••xyz' 也收成 '···xyz'。
export function hintText(hint) {
  const value = String(hint || '');
  if (!value) return '';
  if (value.startsWith('···')) return value;
  const tail = value.split(/[•·]+/).pop();
  return tail && tail !== value ? `···${tail}` : '···';
}
export const savedKeyLabel = (hint) => `已设置${hintText(hint) ? ` ${hintText(hint)}` : ''}`;

// 一块配置（文本模型 / 语音 / 音效）的密钥状态。same 默认按 sameEndpoint 比较；文本模型用 sameLlmEndpoint。
export function secretState({ hasKey, hint, savedEndpoint, draftEndpoint, typedKey, same = sameEndpoint }) {
  const moved = !same(draftEndpoint ?? '', savedEndpoint ?? '');
  const typed = Boolean(String(typedKey || '').trim());
  const kept = Boolean(hasKey) && !moved;
  return { kept, label: kept ? savedKeyLabel(hint) : '', reenter: Boolean(hasKey) && moved && !typed };
}
export const llmSecretState = (args) => secretState({ ...args, same: sameLlmEndpoint });

// 语音配置按引擎各存一份（0035：config.ttsProviders[id] = { endpoint, resourceId, model, audioFormat, sampleRate,
// responseMode, customBodyTemplate, customHeaders, hasKey, secretHint }）。平铺字段 = 当前引擎那一份。
// 没有 ttsProviders 的老服务端：平铺字段只属于当前保存的那个引擎，别的引擎没有已保存的东西。
export const TTS_SLOT_UI_FIELDS = ['endpoint', 'resourceId', 'model', 'audioFormat', 'sampleRate', 'responseMode', 'customBodyTemplate', 'customHeaders'];
export function providerSaved(config = {}, provider) {
  const own = config?.ttsProviders?.[provider];
  if (own) return { ...Object.fromEntries(TTS_SLOT_UI_FIELDS.filter((field) => own[field] !== undefined).map((field) => [field, own[field]])), hasKey: Boolean(own.hasKey), hint: own.secretHint || '' };
  if (config?.provider === provider) return { ...Object.fromEntries(TTS_SLOT_UI_FIELDS.filter((field) => config[field] !== undefined).map((field) => [field, config[field]])), hasKey: Boolean(config.hasAccessKey), hint: config.secretHint || '' };
  return null;
}

// 切到某个引擎时的草稿：那个引擎有已保存的配置就用它（空值才用预设补，如豆包空地址 = 官方默认地址），
// 没有才用预设。Key 永远不进草稿（只有 hasKey + 末 3 位）。
export function ttsDraftFor(config = {}, provider, presets = {}) {
  const saved = providerSaved(config, provider);
  const preset = presets[provider] || {};
  if (!saved) return { provider, ...preset, accessKey: '' };
  const fields = Object.fromEntries(TTS_SLOT_UI_FIELDS.filter((field) => saved[field] !== undefined && saved[field] !== '').map((field) => [field, saved[field]]));
  return { provider, ...preset, ...fields, accessKey: '' };
}

// PUT /api/config 不带 ttsProviders（服务端按平铺字段写当前引擎那一槽），也不带只读字段。
export function configForSave(draft = {}) {
  const { ttsProviders, hasAccessKey, hasLlmApiKey, hasSfxAccessKey, secretHint, llmSecretHint, sfxSecretHint, voiceReady, configPath, llmApiKeyRequired, ...rest } = draft;
  return rest;
}

// 请求头 JSON 里的 __SAVED_SECRET__ 显示成「已保存，不显示」；保存时原样换回去，服务端按地址决定是否沿用。
export const maskHeaders = (json) => String(json ?? '').split(`"${SAVED_SECRET}"`).join(`"${MASKED_SECRET}"`);
export const unmaskHeaders = (text) => String(text ?? '').split(`"${MASKED_SECRET}"`).join(`"${SAVED_SECRET}"`);
export const hasSavedHeaderSecret = (json) => String(json ?? '').includes(SAVED_SECRET) || String(json ?? '').includes(MASKED_SECRET);

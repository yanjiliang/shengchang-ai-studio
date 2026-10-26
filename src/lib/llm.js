// 文本模型（小说拆解）：通用 OpenAI 兼容接口，没有本地模型（Yan 的决定）。
// 设置页填 Base URL（…/v1）+ API Key + 模型名；「测试连接」通过后才能导入小说。
// 服务端 llmChatUrl() 会在 Base URL 后面补 /chat/completions，所以这里只存 Base URL。

import { normalizeEndpoint, normalizeLlmBaseUrl, sameLlmEndpoint } from '../../shared/endpoint.mjs';

export const LLM_BASE_PLACEHOLDER = '例如 https://api.example.com/v1';
export const LLM_MODEL_PLACEHOLDER = '例如 doubao-seed-1.6、qwen-plus';
export const LLM_KEY_NOTE = '只保存在这台电脑上';
export const LLM_STRIPPED_HINT = '已自动去掉末尾的 /chat/completions';
export const LLM_IMPORT_BLOCKED = '文本模型还没连通，先去设置里测试一下';

// 规范化和「地址变没变」跟服务端用同一份 shared/endpoint.mjs（0034）。
// stripped：用户填的地址末尾带了 /chat/completions，用来显示「已自动去掉…」。
export function normalizeLlmBase(value) {
  const plain = normalizeEndpoint(value);
  const base = normalizeLlmBaseUrl(value);
  return { base, stripped: base !== plain };
}
export const llmUrlChanged = (draftEndpoint, savedEndpoint) => !sameLlmEndpoint(draftEndpoint, savedEndpoint);
export const LLM_REENTER_KEY = '改了地址，请重新填 Key';
export const llmBaseHint = (value) => (normalizeLlmBase(value).stripped ? LLM_STRIPPED_HINT : '');

export const llmKeyPlaceholder = (keyRequired) => (keyRequired ? '必填' : '本地服务可以不填');

// 保存前检查：只有模型名必填（Key 由 llmApiKeyRequired 决定；测试不是保存的前提）。
export function llmFieldErrors(draft = {}, { keyRequired = false } = {}) {
  const errors = {};
  if (!normalizeLlmBase(draft.llmEndpoint).base) errors.llmEndpoint = '填一下服务地址';
  if (!String(draft.llmModel || '').trim()) errors.llmModel = '填一下模型名';
  if (keyRequired && !String(draft.llmApiKey || '').trim() && !draft.hasLlmApiKey) errors.llmApiKey = '这个服务需要 API Key';
  return errors;
}

// 测试通过记的是「哪一套设置」通过了：地址 / 模型 / Key 任何一个变了，就要重新测试。
export function llmFingerprint(config = {}) {
  const key = String(config.llmApiKey || '').trim();
  return [normalizeLlmBase(config.llmEndpoint).base, String(config.llmModel || '').trim(), key ? `new:${key.length}:${key.slice(-4)}` : config.hasLlmApiKey ? `saved:${config.llmSecretHint || ''}` : 'none'].join('|');
}

const STORE = 'shengchang.llmVerified';
const storage = () => { try { return globalThis.localStorage || null; } catch { return null; } };
export function readLlmVerified(store = storage()) {
  try { return JSON.parse(store?.getItem(STORE) || 'null'); } catch { return null; }
}
export function writeLlmVerified(config, { latencyMs } = {}, store = storage()) {
  const record = { fingerprint: llmFingerprint(config), at: Date.now(), latencyMs: Number.isFinite(latencyMs) ? latencyMs : null };
  try { store?.setItem(STORE, JSON.stringify(record)); } catch { /* 隐私模式等：只是不记住 */ }
  return record;
}
export function clearLlmVerified(store = storage()) { try { store?.removeItem(STORE); } catch { /* ignore */ } }

// 导入前：服务端如果给了 llmVerified（建议的字段，见 docs/chain-contract.md）以它为准；
// 否则看这台浏览器记下的、和当前已保存设置一致的那次测试。
export function llmReady(config, verified = readLlmVerified()) {
  if (!config) return false;
  if (typeof config.llmVerified === 'boolean') return config.llmVerified;
  return Boolean(verified && verified.fingerprint === llmFingerprint(config));
}

export function llmSuccessText(result = {}) {
  const ms = Number(result.latencyMs);
  const seconds = Number.isFinite(ms) ? Math.max(0.1, ms / 1000) : null;
  return seconds === null ? '连接正常' : `连接正常，用时 ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} 秒`;
}

// POST /api/config/test-llm（0033 起）：上游结果一律 200 {ok, latencyMs, code, message, status?}，
// 看 ok 不看 HTTP 状态；本地校验没过是 400 LLM_CONFIG_INVALID（0034 起带 field）。
// 返回 { ok, text, field }：field 有值时提示放在那个输入框下面。
export function llmTestOutcome(resultOrError = {}) {
  const payload = resultOrError instanceof Error ? (resultOrError.payload || {}) : resultOrError;
  if (payload.ok === true) return { ok: true, text: llmSuccessText(payload), field: null, latencyMs: Number.isFinite(payload.latencyMs) ? payload.latencyMs : null };
  const code = String(payload.code || resultOrError.code || '');
  const message = String(payload.message || payload.error || resultOrError.message || '');
  if (code === 'LLM_CONFIG_INVALID') return { ok: false, text: message || '设置还没填完整', field: ['llmEndpoint', 'llmModel', 'llmApiKey'].includes(payload.field) ? payload.field : null };
  return { ok: false, text: llmErrorText({ code, message, status: payload.status }), field: null };
}

// code 优先；老服务端（0033 之前）只有「文本模型返回 401: …」这样的 message，从里面认状态码和网络错误。
export function llmErrorText({ code = '', message = '', status = null } = {}) {
  const upstream = Number(status) || Number(String(message).match(/返回\s*(\d{3})/)?.[1]) || null;
  if (code === 'LLM_AUTH' || (!code && (upstream === 401 || upstream === 403))) return 'Key 不对或已过期';
  if (code === 'LLM_NOT_FOUND' || (!code && upstream === 404)) return '地址或模型名不对，请检查是否以 /v1 结尾';
  if (code === 'LLM_UNREACHABLE' || (!code && /abort|timed? ?out|超时|fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|getaddrinfo|socket hang up|连不上/i.test(message))) return '连不上这个地址';
  return message || '测试失败';
}

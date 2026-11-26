// 文本模型（OpenAI 兼容 chat/completions）的配置校验、凭证沿用规则与「测试连接」。
// 从 story-analyzer.js 拆出；story-analyzer.js 仍 re-export 这些符号以保持原有导入路径可用。
import { llmChatUrl, sameEndpoint, sameLlmEndpoint } from '../shared/endpoint.mjs';

// 文本模型走 OpenAI 兼容的 chat/completions：火山方舟（默认）、DeepSeek、OpenAI，
// 以及本地的 Ollama / LM Studio / vLLM / llama.cpp server。llmEndpoint 可以是完整的
// .../chat/completions，也可以只填 base URL（如 http://127.0.0.1:11434/v1）。
export { llmChatUrl };

// API Key 只有托管服务需要；本地 OpenAI 兼容服务通常不校验，留空即可。方舟默认地址仍要求 Key。
export function llmRequiresApiKey(endpoint) {
  try { return /(^|\.)volces\.com$/i.test(new URL(llmChatUrl(endpoint)).hostname); } catch { return true; }
}

// 本地校验错误：code LLM_CONFIG_INVALID + field 指出哪一项（前端据此把错误标到对应输入框）。
const configInvalid = (field, message) => Object.assign(new Error(message), { status: 400, code: 'LLM_CONFIG_INVALID', field });

export function validateLlmConfig(config) {
  if (!String(config.llmEndpoint || '').trim()) throw configInvalid('llmEndpoint', '请填写服务地址（Base URL）');
  let url;
  try { url = new URL(llmChatUrl(config.llmEndpoint)); } catch { url = null; }
  if (!url || !['http:', 'https:'].includes(url.protocol)) throw configInvalid('llmEndpoint', '地址格式不对，应以 http:// 或 https:// 开头');
  if (!config.llmApiKey && llmRequiresApiKey(config.llmEndpoint)) throw configInvalid('llmApiKey', '请填写 API Key（火山方舟必须填写）');
  if (!String(config.llmModel || '').trim()) throw configInvalid('llmModel', '请填写模型名');
}

// 设置页「测试连接」：只验证地址 / Key / 模型名能不能通，不跑拆解（拆解慢且贵）。
// 上游失败也算“测试成功地报告了结果”，所以返回值而不是抛错；本地校验错误由路由层回 400。
export const LLM_TEST_TIMEOUT_MS = 20_000;
const LLM_TEST_MESSAGE_MAX = 300;

// 上游报错原文可能回显请求头或 Key（有的代理会把整个请求打进错误信息），一律抹掉。
export function redactLlmSecret(text, apiKey) {
  let value = String(text ?? '');
  if (apiKey) value = value.split(apiKey).join('***');
  return value.replace(/(authorization["']?\s*[:=]\s*["']?)(bearer\s+)?[^\s"',}]+/gi, '$1$2***').replace(/bearer\s+[A-Za-z0-9._~+\/=-]{6,}/gi, 'Bearer ***');
}

function upstreamMessage(text) {
  try {
    const payload = JSON.parse(text);
    const error = payload?.error;
    const message = typeof error === 'string' ? error : error?.message || payload?.message || payload?.msg;
    if (message) return String(message);
  } catch { /* not JSON */ }
  return String(text || '').trim();
}

const truncate = (text) => (text.length > LLM_TEST_MESSAGE_MAX ? `${text.slice(0, LLM_TEST_MESSAGE_MAX)}…` : text);

// 测试请求时，请求体没带 Key → 只有地址（规范化后）和已保存的一致才沿用已保存的 Key，
// 否则把用户的 Key 发给了另一家服务。保存配置时同样用这条规则。
// 通用版：TTS accessKey、音效 sfxAccessKey 同一规则（地址用 normalizeEndpoint 比较）。
export function resolveSavedSecret(incoming, saved, { secretField, endpointField, same = sameEndpoint }) {
  if (incoming?.[secretField]) return String(incoming[secretField]);
  const endpoint = incoming?.[endpointField] === undefined ? saved?.[endpointField] : incoming[endpointField];
  return same(endpoint, saved?.[endpointField]) ? String(saved?.[secretField] || '') : '';
}

export function resolveLlmApiKey(incoming, saved) {
  return resolveSavedSecret(incoming, saved, { secretField: 'llmApiKey', endpointField: 'llmEndpoint', same: sameLlmEndpoint });
}

export async function testLlm(config, { fetchImpl = fetch, timeoutMs = LLM_TEST_TIMEOUT_MS } = {}) {
  validateLlmConfig(config);
  const apiKey = config.llmApiKey || '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const fail = (code, message, status) => ({ ok: false, latencyMs: Date.now() - startedAt, code, message: truncate(redactLlmSecret(message, apiKey)), ...(status ? { status } : {}) });
  try {
    let response;
    try {
      response = await fetchImpl(llmChatUrl(config.llmEndpoint), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: config.llmModel, max_tokens: 16, temperature: 0, messages: [{ role: 'user', content: '回复“好”。' }] }),
      });
    } catch (error) {
      const timedOut = controller.signal.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError';
      const cause = error?.cause?.code || error?.code || '';
      return fail('LLM_UNREACHABLE', timedOut ? `连接超时（${Math.round(timeoutMs / 1000)} 秒内没有响应）` : `连不上这个地址${cause ? `（${cause}）` : ''}`);
    }
    let text;
    try { text = await response.text(); }
    catch (error) {
      if (controller.signal.aborted) return fail('LLM_UNREACHABLE', `连接超时（${Math.round(timeoutMs / 1000)} 秒内没有响应）`, response.status);
      return fail('LLM_UPSTREAM', `读取响应失败：${error?.message || error}`, response.status);
    }
    if (!response.ok) {
      const code = [401, 403].includes(response.status) ? 'LLM_AUTH' : response.status === 404 ? 'LLM_NOT_FOUND' : 'LLM_UPSTREAM';
      return fail(code, upstreamMessage(text) || `HTTP ${response.status}`, response.status);
    }
    let payload;
    try { payload = JSON.parse(text); } catch { return fail('LLM_UPSTREAM', `响应不是 JSON：${text.trim()}`, response.status); }
    if (!Array.isArray(payload?.choices) || !payload.choices.length) return fail('LLM_UPSTREAM', `响应里没有 choices，不像 chat/completions 接口：${text.trim()}`, response.status);
    return { ok: true, latencyMs: Date.now() - startedAt, code: null, message: '连接正常', status: response.status };
  } finally { clearTimeout(timer); }
}

export const LLM_DEFAULT_TIMEOUT_MS = 600_000;

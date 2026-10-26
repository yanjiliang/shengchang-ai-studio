// 地址规范化：服务端和前端共用同一份，保证“地址变没变”两边判断一致。
// 服务端据此决定没填新 Key 时是否沿用已保存的 Key（换了地址就不沿用，防止 Key 发给另一家服务）。

// 通用：去首尾空白和末尾的 /（TTS、音效等完整接口地址用这个比较）。
export function normalizeEndpoint(endpoint) {
  return String(endpoint ?? '').trim().replace(/\/+$/, '');
}

// 文本模型 base URL：再去掉末尾的 /chat/completions（不区分大小写），
// 所以 https://x/v1、https://x/v1/、https://x/v1/chat/completions 规范化后相同。
export function normalizeLlmBaseUrl(endpoint) {
  return normalizeEndpoint(endpoint).replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
}

// 实际请求的 chat/completions 地址；空输入返回 ''。
export function llmChatUrl(endpoint) {
  const base = normalizeLlmBaseUrl(endpoint);
  return base ? `${base}/chat/completions` : '';
}

export const sameEndpoint = (a, b) => normalizeEndpoint(a) === normalizeEndpoint(b);
export const sameLlmEndpoint = (a, b) => normalizeLlmBaseUrl(a) === normalizeLlmBaseUrl(b);

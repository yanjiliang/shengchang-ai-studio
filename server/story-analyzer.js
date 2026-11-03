import { randomUUID } from 'node:crypto';
import { normalizeAge, normalizeGender } from './character-meta.js';
import { llmChatUrl, sameEndpoint, sameLlmEndpoint } from '../shared/endpoint.mjs';
import { numberOr } from '../shared/generation-requests.mjs';

const SCHEMA_INSTRUCTION = `
将输入小说改编成可制作的中文多人广播剧场景。只返回 JSON，不要 Markdown。
格式：{"project":{"genre":"题材"},"characters":[{"id":"稳定英文或拼音id","name":"姓名","role":"角色定位","gender":"男|女|未知","age":"儿童|少年|青年|中年|老年|未知","description":"声音与性格描述","voiceDescription":"可选：一句给语音合成做音色设计的声音描述（年龄感、性别、音高、音色质感、语速习惯），不写剧情"}],"scenes":[{"title":"场景标题","location":"时间 / 内外 / 地点","mood":"场景氛围","synopsis":"剧情作用","lines":[{"type":"dialogue|ambient|sfx|music","speaker":"说话者，仅dialogue","speakerId":"角色id，仅dialogue","text":"台词或声音描述","subtext":"潜台词","emotion":"情绪","intensity":0到100,"pace":70到120,"distance":"声音距离"}]}]}。
要求：区分旁白与人物对白；用声音事件替代可听见的动作描写；每句保持适合语音合成的长度；speakerId 在全项目稳定；旁白 speakerId 固定为 narrator；不要省略推动剧情的对白。
`;

function extractJson(content) {
  // 推理模型（DeepSeek-R1 / Qwen3 等本地部署）常把思考过程放在 <think> 里，里面可能有花括号。
  const text = String(content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('文本模型没有返回 JSON 对象');
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch (error) { throw new Error(`文本模型返回的 JSON 无法解析: ${error.message}`); }
}

function normalizeLine(line, characterIds) {
  const type = ['dialogue', 'ambient', 'sfx', 'music'].includes(line.type) ? line.type : 'dialogue';
  if (type !== 'dialogue') return { id: randomUUID(), type, label: type === 'ambient' ? '环境声' : type === 'sfx' ? '动作音效' : '背景音乐', text: String(line.text || '').trim() };
  const speaker = String(line.speaker || '旁白').trim();
  let speakerId = String(line.speakerId || (speaker === '旁白' ? 'narrator' : speaker)).trim();
  if (!characterIds.has(speakerId)) speakerId = speaker === '旁白' ? 'narrator' : speakerId.toLowerCase().replace(/\s+/g, '-');
  return { id: randomUUID(), type: 'dialogue', speaker, speakerId, text: String(line.text || '').trim(), subtext: String(line.subtext || '按当前剧情上下文表达。'), emotion: String(line.emotion || '克制'), intensity: Math.min(100, Math.max(0, numberOr(line.intensity, 40))), pace: Math.min(120, Math.max(70, Number(line.pace) || 90)), distance: String(line.distance || '近讲') };
}

function normalizeResult(result, fallbackName) {
  if (!Array.isArray(result.scenes) || !result.scenes.length) throw new Error('文本模型没有返回可用场景');
  const characters = Array.isArray(result.characters) ? result.characters.map((character) => ({ id: String(character.id || randomUUID()), name: String(character.name || '未命名角色'), role: String(character.role || '角色'), gender: normalizeGender(character.gender), age: normalizeAge(character.age), description: String(character.description || ''), ...(String(character.voiceDescription || '').trim() ? { voiceDescription: String(character.voiceDescription).trim().slice(0, 500) } : {}) })) : [];
  if (!characters.some((item) => item.id === 'narrator')) characters.unshift({ id: 'narrator', name: '旁白', role: '叙事者', description: '保持客观、克制，避免播音腔。' });
  const characterIds = new Set(characters.map((item) => item.id));
  const scenes = result.scenes.map((scene, index) => {
    const lines = (scene.lines || []).map((line) => normalizeLine(line, characterIds)).filter((line) => line.text);
    return { id: randomUUID(), number: String(index + 1).padStart(2, '0'), title: String(scene.title || `场景 ${index + 1}`), duration: '待生成', cast: [...new Set(lines.filter((line) => line.type === 'dialogue').map((line) => line.speaker))].join(' · ') || '旁白', status: 'pending', location: String(scene.location || '待设定'), mood: String(scene.mood || '待导演'), synopsis: String(scene.synopsis || ''), lines };
  }).filter((scene) => scene.lines.length);
  return { name: String(result.project?.name || fallbackName || '未命名作品'), genre: String(result.project?.genre || ''), characters, scenes };
}

// Exported for tests.
export function splitNovel(text, maxChars = 24_000) {
  const chunks = [];
  let current = '';
  // Chinese web novels commonly separate paragraphs with a single newline.
  // Split on any line break so those are packed (not hard-cut) below; the
  // regex fallback now only fires on a single line longer than the cap.
  for (const paragraph of text.split(/\r?\n/)) {
    const parts = paragraph.length > maxChars ? paragraph.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, 'g')) : [paragraph];
    for (const part of parts) {
      const candidate = current ? `${current}\n${part}` : part;
      if (candidate.length > maxChars && current) { chunks.push(current); current = part; }
      else current = candidate;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

function mergeAnalysis(target, result) {
  const canonicalById = new Map(target.characters.map((item) => [String(item.id), item]));
  const canonicalByName = new Map(target.characters.map((item) => [String(item.name), item]));
  const idAliases = new Map();
  for (const character of result.characters || []) {
    const rawId = String(character.id || randomUUID());
    const name = String(character.name || '未命名角色');
    const existing = canonicalById.get(rawId) || canonicalByName.get(name);
    const canonical = existing || { ...character, id: rawId, name };
    if (!existing) {
      target.characters.push(canonical);
      canonicalById.set(canonical.id, canonical);
      canonicalByName.set(canonical.name, canonical);
    }
    idAliases.set(rawId, canonical.id);
  }
  for (const scene of result.scenes || []) {
    target.scenes.push({ ...scene, lines: (scene.lines || []).map((line) => {
      if (line.type !== 'dialogue') return line;
      const byName = canonicalByName.get(String(line.speaker || ''));
      return { ...line, speakerId: idAliases.get(String(line.speakerId || '')) || byName?.id || line.speakerId };
    }) });
  }
}

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

// 有的 OpenAI 兼容服务（LM Studio、部分 vLLM / 旧版 llama.cpp）不认
// response_format: json_object，返回 400/422。此时去掉它重试一次，靠提示词约束 JSON。
const rejectsJsonMode = (status, text) => [400, 422].includes(status) && /response_format|json_object|json_schema/i.test(text);

async function callLlm(config, sourceText) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(config.llmTimeoutMs) || LLM_DEFAULT_TIMEOUT_MS);
  const headers = { 'Content-Type': 'application/json', ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}) };
  const body = { model: config.llmModel, temperature: 0.25, max_tokens: 16_384, messages: [{ role: 'system', content: `${config.llmSystemPrompt}\n${SCHEMA_INSTRUCTION}` }, { role: 'user', content: sourceText }] };
  const post = (jsonMode) => fetch(llmChatUrl(config.llmEndpoint), { method: 'POST', signal: controller.signal, headers, body: JSON.stringify(jsonMode ? { ...body, response_format: { type: 'json_object' } } : body) });
  try {
    let response = await post(true);
    if (!response.ok) {
      const text = await response.text();
      if (rejectsJsonMode(response.status, text)) response = await post(false);
      else throw new Error(`文本模型返回 ${response.status}: ${text.slice(0, 800)}`);
    }
    if (!response.ok) throw new Error(`文本模型返回 ${response.status}: ${(await response.text()).slice(0, 800)}`);
    const payload = await response.json();
    // 8k is the floor of current chat-completions output caps (DeepSeek's is
    // exactly 8k). Left unset, many providers default to 2-4k and the
    // breakdown JSON gets cut mid-object; finish_reason 'length' is the
    // provider saying even that was not enough.
    if (payload.choices?.[0]?.finish_reason === 'length') throw new Error('模型输出达到长度上限被截断，拆解结果不完整。请调小 llmChunkChars、换用输出上限更大的模型，或分章导入减少单段篇幅');
    const content = payload.choices?.[0]?.message?.content ?? payload.output?.text ?? payload.result;
    return extractJson(content);
  } finally { clearTimeout(timer); }
}

// Transient network hiccups should not kill a multi-chunk run: one automatic
// retry with a short backoff absorbs them. Timeouts are not retried: a slow
// model that burned the whole per-request timeout will usually burn a second
// one too; surface the failure and let the user retry or raise llmTimeoutMs.
async function callWithRetry(call, config, prompt, { shouldCancel, retryDelayMs }) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await call(config, prompt); }
    catch (error) {
      if (attempt >= 1 || error.code === 'TASK_CANCELLED' || error.name === 'AbortError') throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      if (shouldCancel?.()) throw error;
    }
  }
}

export async function analyzeNovel(config, { text, filename, name, seedCharacters = [] }, { onProgress, shouldCancel, resume, onCheckpoint, call = callLlm, chunkChars = 6_000, retryDelayMs = 2_500 } = {}) {
  if (!text.trim()) throw new Error('小说文本为空');
  const fallbackName = name || filename.replace(/\.[^.]+$/, '');
  const seedRoster = Array.isArray(seedCharacters) ? seedCharacters : [];
  // 文本模型是唯一的拆解路径；没配置或配置不完整时直接报错，不再退回规则拆解。
  validateLlmConfig(config);
  const chunks = splitNovel(text, chunkChars);
  // Chunk-level resume: a failed multi-chunk run checkpoints its merged
  // analysis after every completed chunk; retryTask copies the task payload,
  // so the retry only pays for the chunks it never finished.
  const chunksDone = Math.max(0, Math.min(Number(resume?.chunksDone) || 0, chunks.length - 1));
  const merged = resume?.merged && chunksDone > 0 ? resume.merged : { project: { name: fallbackName, genre: '' }, characters: [...seedRoster], scenes: [] };
  for (let index = chunksDone; index < chunks.length; index += 1) {
    if (shouldCancel?.()) {
      const error = new Error('小说拆解任务已取消');
      error.code = 'TASK_CANCELLED';
      throw error;
    }
    onProgress?.({ current: index + 1, total: chunks.length, progress: 8 + Math.round((index / chunks.length) * 82) });
    const rosterNote = merged.characters.length ? `\n\n已确认角色表（后续必须沿用这些 id，同名人物不可新建 id）：\n${JSON.stringify(merged.characters)}` : '';
    const result = await callWithRetry(call, config, `作品名：${fallbackName}\n这是第 ${index + 1} / ${chunks.length} 段，请只拆解本段，不重复前文场景。${rosterNote}\n\n小说原文：\n${chunks[index]}`, { shouldCancel, retryDelayMs });
    if (index === 0) merged.project = { ...merged.project, ...result.project };
    else if (!merged.project.genre && result.project?.genre) merged.project.genre = result.project.genre;
    mergeAnalysis(merged, result);
    onCheckpoint?.({ chunksDone: index + 1, merged });
  }
  onProgress?.({ current: chunks.length, total: chunks.length, progress: 94 });
  return { ...normalizeResult(merged, fallbackName), breakdown: 'llm' };
}

import { randomUUID } from 'node:crypto';
import { normalizeAge, normalizeGender } from './character-meta.js';

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
  return { id: randomUUID(), type: 'dialogue', speaker, speakerId, text: String(line.text || '').trim(), subtext: String(line.subtext || '按当前剧情上下文表达。'), emotion: String(line.emotion || '克制'), intensity: Math.min(100, Math.max(0, Number(line.intensity) || 40)), pace: Math.min(120, Math.max(70, Number(line.pace) || 90)), distance: String(line.distance || '近讲') };
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
export function llmChatUrl(endpoint) {
  const value = String(endpoint || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  if (/\/chat\/completions$/i.test(value)) return value;
  return `${value}/chat/completions`;
}

// API Key 只有托管服务需要；本地 OpenAI 兼容服务通常不校验，留空即可。方舟默认地址
// 仍要求 Key（没填 Key 时走规则拆解，而不是打一个必然 401 的请求）。
export function llmRequiresApiKey(endpoint) {
  try { return /(^|\.)volces\.com$/i.test(new URL(llmChatUrl(endpoint)).hostname); } catch { return true; }
}

export function validateLlmConfig(config) {
  if (!config.llmEndpoint) throw new Error('请在设置中填写文本理解模型地址');
  try { new URL(llmChatUrl(config.llmEndpoint)); } catch { throw new Error('文本理解模型地址不是合法 URL'); }
  if (!config.llmApiKey && llmRequiresApiKey(config.llmEndpoint)) throw new Error('请在设置中填写文本理解模型 API Key');
  if (!config.llmModel) throw new Error('请在设置中填写文本理解模型名称');
}

// --- Offline rule-based fallback (TODO-1) -------------------------------
// Engages only when no LLM is configured. Chinese dialogue attribution by
// regex is genuinely lossy, so every output is tagged breakdown:'heuristic'
// and the UI asks the user to review it - a wrong guess must be visible,
// not silent.
const CHAPTER_HEADING = /^(?:第[0-9一二三四五六七八九十百千两]+[章节卷回幕集部]|序章|楔子|引子|尾声|终章|后记|番外.{0,10}|chapter\s+\d+)/i;
// Multi-char verbs first; bare 道/答/笑 etc. are deliberately absent - 道
// alone false-positives on 知道 inside quoted text (caught by the golden run).
const SPEECH_VERB = '(?:低声说|轻声说|沉声说|大声说|说道?|问道?|喊道?|叫道?|笑道?|答道|叹道?|骂道?|吼道?|催道|念叨|开口|接话|嘀咕|嘟囔|说|问|喊)';
const SPEECH_ADVERB = '(?:轻声|低声|大声|沉声|冷冷|缓缓|急忙|连忙|忽然|突然|随即|接着|随后|笑着|叹了口气)?';
// Lazy capture (min 1 char) so single-char pronouns resolve and the name
// does not swallow the verb; the after-quote gap is separator-only so it
// cannot eat into the name from the left.
const SPEAKER_NAME = '([\\u4e00-\\u9fa5A-Za-z·]{1,12}?)';
// ASCII double quotes are included alongside CJK quotes: many web novels use
// straight quotes for dialogue, and without them every line lands on the
// narrator. Straight quotes pair sequentially (first opens, second closes).
const QUOTE_OPEN = '[「『“"]';
const QUOTE_CLOSE = '[」』”"]';
const QUOTE_PAIR = /[「『“"]([^「『“”」』"]{1,400})[」』”"]/g;
const SPEAKER_BEFORE_QUOTE = new RegExp(SPEAKER_NAME + SPEECH_ADVERB + SPEECH_VERB + '[\\s:：,，、]*' + QUOTE_OPEN);
const SPEAKER_AFTER_QUOTE = new RegExp(QUOTE_CLOSE + '[\\s,，、:：;；——-]*' + SPEAKER_NAME + SPEECH_ADVERB + SPEECH_VERB);
const PRONOUN_SPEAKERS = new Set(['他', '她', '它', '他们', '她们', '它们']);
// Fragments the name regex grabs that are scene description, not a person.
const NAME_FILLER = /^(?:只听|只见|听|见|这时|然后|接着|突然|忽然|原来|一个|那个|这个)+/;

const MAX_SYNTH_CHARS = 120;

function cleanSpeakerName(raw, lastSpeaker) {
  const name = String(raw || '').replace(NAME_FILLER, '').trim();
  if (PRONOUN_SPEAKERS.has(name)) return lastSpeaker || null;
  if (name.length < 2 || name.length > 12) return null;
  return name;
}

function attributeParagraph(paragraph, lastSpeaker) {
  // Try "X说：「…」" first, then "「…」X说". Both regexes are anchored so the
  // captured name sits directly against a speech verb next to a quote.
  const before = paragraph.match(SPEAKER_BEFORE_QUOTE);
  const after = !before && paragraph.match(SPEAKER_AFTER_QUOTE);
  const matched = before || after;
  if (!matched) return { speaker: null, attributionSpan: '' };
  return { speaker: cleanSpeakerName(matched[1], lastSpeaker), attributionSpan: matched[0] };
}

function narrationChunks(text) {
  if (!text.trim()) return [];
  const sentences = text.split(/(?<=[。！？；!?…])/);
  const chunks = [];
  let buffer = '';
  for (const sentence of sentences) {
    if (buffer && (buffer + sentence).length > MAX_SYNTH_CHARS) { chunks.push(buffer); buffer = sentence; }
    else buffer += sentence;
  }
  if (buffer.trim()) chunks.push(buffer);
  // A single unpunctuated run can still exceed the cap; hard-split it.
  return chunks.flatMap((chunk) => chunk.length > MAX_SYNTH_CHARS * 1.5 ? chunk.match(new RegExp('[\\s\\S]{1,' + MAX_SYNTH_CHARS + '}', 'g')) : [chunk]);
}

export function heuristicAnalysis(text, fallbackName) {
  const paragraphs = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const chapters = [];
  for (const line of paragraphs) {
    if (line.length <= 40 && CHAPTER_HEADING.test(line)) chapters.push({ title: line.slice(0, 24), paragraphs: [] });
    else {
      if (!chapters.length) chapters.push({ title: '', paragraphs: [] });
      chapters[chapters.length - 1].paragraphs.push(line);
    }
  }
  let groups = chapters.filter((chapter) => chapter.paragraphs.length);
  // No recognizable chapter structure: regroup into fixed-size scenes so a
  // chapterless novel still lands as several reviewable scenes, not one giant.
  if (groups.length <= 1) {
    const flat = groups.flatMap((chapter) => chapter.paragraphs);
    groups = [];
    for (let index = 0; index < flat.length; index += 40) groups.push({ title: '', paragraphs: flat.slice(index, index + 40) });
  }

  const speakers = new Map();
  let lastSpeaker = null;
  const scenes = [];
  for (const [index, group] of groups.entries()) {
    const lines = [];
    for (const paragraph of group.paragraphs) {
      const quotes = [...paragraph.matchAll(QUOTE_PAIR)];
      if (!quotes.length) {
        for (const chunk of narrationChunks(paragraph)) lines.push({ type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text: chunk });
        continue;
      }
      const { speaker: attributed, attributionSpan } = attributeParagraph(paragraph, lastSpeaker);
      let speaker = attributed;
      if (speaker) lastSpeaker = speaker;
      // Walk the paragraph quote by quote; the text around quotes becomes
      // narrator lines, minus the attribution clause we already understood.
      const attributionClause = attributionSpan.replace(new RegExp(QUOTE_OPEN + '$'), '').replace(new RegExp('^' + QUOTE_CLOSE), '');
      let cursor = 0;
      const pushNarration = (text) => {
        const narration = (text.includes(attributionClause) && attributionClause ? text.replace(attributionClause, '') : text).replace(/^[\s，。：:、—-]+/, '').trim();
        for (const chunk of narrationChunks(narration)) lines.push({ type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text: chunk });
      };
      for (const quote of quotes) {
        pushNarration(paragraph.slice(cursor, quote.index));
        const text = quote[1].trim();
        cursor = quote.index + quote[0].length;
        if (!text) continue;
        // Unattributed speech falls back to the narrator (TODO-1 spec): a
        // wrong character assignment is worse than an audible narrator.
        const resolved = speaker || '旁白';
        const speakerId = resolved === '旁白' ? 'narrator' : resolved;
        if (speakerId !== 'narrator' && !speakers.has(speakerId)) speakers.set(speakerId, { id: speakerId, name: resolved, role: '角色', description: '由规则拆解推断的说话人，请人工确认角色与声音设定。' });
        lines.push({ type: 'dialogue', speaker: resolved, speakerId, text });
      }
      pushNarration(paragraph.slice(cursor));
    }
    if (lines.length) scenes.push({ title: group.title || '场景 ' + (index + 1), location: '待设定', mood: '待导演', synopsis: '规则拆解：按章节或固定段落分组，未经文本模型理解。', lines });
  }
  const characters = [...speakers.values()];
  return { project: { name: fallbackName, genre: '' }, characters, scenes };
}

export async function testLlm(config) {
  validateLlmConfig(config);
  const startedAt = Date.now();
  const result = await callLlm(config, '将这句话分析为一个广播剧场景：雨夜，林夏敲响了旧旅馆的门。');
  const characters = Array.isArray(result.characters) ? result.characters : [];
  return { latencyMs: Date.now() - startedAt, sceneCount: result.scenes.length, endpoint: llmChatUrl(config.llmEndpoint), model: config.llmModel, characterCount: characters.length, voiceDescriptionCount: characters.filter((item) => String(item?.voiceDescription || '').trim()).length };
}

export const LLM_DEFAULT_TIMEOUT_MS = 180_000;

// 有的 OpenAI 兼容服务（LM Studio、部分 vLLM / 旧版 llama.cpp）不认
// response_format: json_object，返回 400/422。此时去掉它重试一次，靠提示词约束 JSON。
const rejectsJsonMode = (status, text) => [400, 422].includes(status) && /response_format|json_object|json_schema/i.test(text);

async function callLlm(config, sourceText) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(config.llmTimeoutMs) || LLM_DEFAULT_TIMEOUT_MS);
  const headers = { 'Content-Type': 'application/json', ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}) };
  const body = { model: config.llmModel, temperature: 0.25, max_tokens: 8_192, messages: [{ role: 'system', content: `${config.llmSystemPrompt}\n${SCHEMA_INSTRUCTION}` }, { role: 'user', content: sourceText }] };
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
    if (payload.choices?.[0]?.finish_reason === 'length') throw new Error('模型输出达到长度上限被截断，拆解结果不完整。请在设置中换用输出上限更大的模型（建议 ≥16k token），或分章导入减少单段篇幅');
    const content = payload.choices?.[0]?.message?.content ?? payload.output?.text ?? payload.result;
    return extractJson(content);
  } finally { clearTimeout(timer); }
}

// Transient network hiccups should not kill a multi-chunk run: one automatic
// retry with a short backoff absorbs them; persistent failures still surface
// (and chunk-level resume covers the retry).
async function callWithRetry(call, config, prompt, { shouldCancel, retryDelayMs }) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await call(config, prompt); }
    catch (error) {
      if (attempt >= 1 || error.code === 'TASK_CANCELLED') throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      if (shouldCancel?.()) throw error;
    }
  }
}

export async function analyzeNovel(config, { text, filename, name }, { onProgress, shouldCancel, resume, onCheckpoint, call = callLlm, chunkChars = 24_000, retryDelayMs = 2_500 } = {}) {
  if (!text.trim()) throw new Error('小说文本为空');
  const fallbackName = name || filename.replace(/\.[^.]+$/, '');
  // Zero-key fallback (TODO-1): when no LLM is configured, break the novel
  // down with rules instead of failing the import. The result is tagged so
  // both the task message and the UI can label it as heuristic.
  let llmReady = true;
  try { validateLlmConfig(config); } catch { llmReady = false; }
  if (!llmReady) {
    onProgress?.({ current: 1, total: 1, progress: 60 });
    return { ...normalizeResult(heuristicAnalysis(text, fallbackName), fallbackName), breakdown: 'heuristic' };
  }
  const chunks = splitNovel(text, chunkChars);
  // Chunk-level resume: a failed multi-chunk run checkpoints its merged
  // analysis after every completed chunk; retryTask copies the task payload,
  // so the retry only pays for the chunks it never finished.
  const chunksDone = Math.max(0, Math.min(Number(resume?.chunksDone) || 0, chunks.length - 1));
  const merged = resume?.merged && chunksDone > 0 ? resume.merged : { project: { name: fallbackName, genre: '' }, characters: [], scenes: [] };
  for (let index = chunksDone; index < chunks.length; index += 1) {
    if (shouldCancel?.()) {
      const error = new Error('小说拆解任务已取消');
      error.code = 'TASK_CANCELLED';
      throw error;
    }
    onProgress?.({ current: index + 1, total: chunks.length, progress: 8 + Math.round((index / chunks.length) * 82) });
    const roster = merged.characters.length ? `\n\n已确认角色表（后续必须沿用这些 id，同名人物不可新建 id）：\n${JSON.stringify(merged.characters)}` : '';
    const result = await callWithRetry(call, config, `作品名：${fallbackName}\n这是第 ${index + 1} / ${chunks.length} 段，请只拆解本段，不重复前文场景。${roster}\n\n小说原文：\n${chunks[index]}`, { shouldCancel, retryDelayMs });
    if (index === 0) merged.project = { ...merged.project, ...result.project };
    else if (!merged.project.genre && result.project?.genre) merged.project.genre = result.project.genre;
    mergeAnalysis(merged, result);
    onCheckpoint?.({ chunksDone: index + 1, merged });
  }
  onProgress?.({ current: chunks.length, total: chunks.length, progress: 94 });
  return { ...normalizeResult(merged, fallbackName), breakdown: 'llm' };
}

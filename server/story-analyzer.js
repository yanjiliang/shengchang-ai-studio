import { randomUUID } from 'node:crypto';

const SCHEMA_INSTRUCTION = `
将输入小说改编成可制作的中文多人广播剧场景。只返回 JSON，不要 Markdown。
格式：{"project":{"genre":"题材"},"characters":[{"id":"稳定英文或拼音id","name":"姓名","role":"角色定位","description":"声音与性格描述"}],"scenes":[{"title":"场景标题","location":"时间 / 内外 / 地点","mood":"场景氛围","synopsis":"剧情作用","lines":[{"type":"dialogue|ambient|sfx|music","speaker":"说话者，仅dialogue","speakerId":"角色id，仅dialogue","text":"台词或声音描述","subtext":"潜台词","emotion":"情绪","intensity":0到100,"pace":70到120,"distance":"声音距离"}]}]}。
要求：区分旁白与人物对白；用声音事件替代可听见的动作描写；每句保持适合语音合成的长度；speakerId 在全项目稳定；旁白 speakerId 固定为 narrator；不要省略推动剧情的对白。
`;

function extractJson(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('文本模型没有返回 JSON 对象');
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch (error) { throw new Error(`文本模型返回的 JSON 无法解析: ${error.message}`); }
}

function normalizeLine(line, characterIds) {
  const type = ['dialogue', 'ambient', 'sfx', 'music'].includes(line.type) ? line.type : 'dialogue';
  if (type !== 'dialogue') return { id: randomUUID(), type, label: type === 'ambient' ? '环境声' : type === 'sfx' ? '动作音效' : '背景音乐', text: String(line.text || '').trim(), time: '待编排' };
  const speaker = String(line.speaker || '旁白').trim();
  let speakerId = String(line.speakerId || (speaker === '旁白' ? 'narrator' : speaker)).trim();
  if (!characterIds.has(speakerId)) speakerId = speaker === '旁白' ? 'narrator' : speakerId.toLowerCase().replace(/\s+/g, '-');
  return { id: randomUUID(), type: 'dialogue', speaker, speakerId, delivery: `${line.emotion || '克制'} ${Number(line.intensity) || 40}% · 语速 ${((Number(line.pace) || 90) / 100).toFixed(2)}`, text: String(line.text || '').trim(), subtext: String(line.subtext || '按当前剧情上下文表达。'), emotion: String(line.emotion || '克制'), intensity: Math.min(100, Math.max(0, Number(line.intensity) || 40)), pace: Math.min(120, Math.max(70, Number(line.pace) || 90)), distance: String(line.distance || '近讲') };
}

function normalizeResult(result, fallbackName) {
  if (!Array.isArray(result.scenes) || !result.scenes.length) throw new Error('文本模型没有返回可用场景');
  const characters = Array.isArray(result.characters) ? result.characters.map((character) => ({ id: String(character.id || randomUUID()), name: String(character.name || '未命名角色'), role: String(character.role || '角色'), description: String(character.description || '') })) : [];
  if (!characters.some((item) => item.id === 'narrator')) characters.unshift({ id: 'narrator', name: '旁白', role: '叙事者', description: '保持客观、克制，避免播音腔。' });
  const characterIds = new Set(characters.map((item) => item.id));
  const scenes = result.scenes.map((scene, index) => {
    const lines = (scene.lines || []).map((line) => normalizeLine(line, characterIds)).filter((line) => line.text);
    return { id: randomUUID(), number: String(index + 1).padStart(2, '0'), title: String(scene.title || `场景 ${index + 1}`), duration: '待生成', cast: [...new Set(lines.filter((line) => line.type === 'dialogue').map((line) => line.speaker))].join(' · ') || '旁白', status: 'pending', location: String(scene.location || '待设定'), mood: String(scene.mood || '待导演'), synopsis: String(scene.synopsis || ''), arc: [12, 18, 24, 31, 38, 44, 36, 29], lines };
  }).filter((scene) => scene.lines.length);
  return { name: String(result.project?.name || fallbackName || '未命名作品'), genre: String(result.project?.genre || ''), characters, scenes };
}

function splitNovel(text, maxChars = 24_000) {
  const chunks = [];
  let current = '';
  for (const paragraph of text.split(/\n{2,}/)) {
    const parts = paragraph.length > maxChars ? paragraph.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, 'g')) : [paragraph];
    for (const part of parts) {
      const candidate = current ? `${current}\n\n${part}` : part;
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

export function validateLlmConfig(config) {
  if (!config.llmEndpoint) throw new Error('请在设置中填写文本理解模型地址');
  if (!config.llmApiKey) throw new Error('请在设置中填写文本理解模型 API Key');
  if (!config.llmModel) throw new Error('请在设置中填写文本理解模型名称');
}

export async function testLlm(config) {
  validateLlmConfig(config);
  const startedAt = Date.now();
  const result = await callLlm(config, '将这句话分析为一个广播剧场景：雨夜，林夏敲响了旧旅馆的门。');
  return { latencyMs: Date.now() - startedAt, sceneCount: result.scenes.length };
}

async function callLlm(config, sourceText) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180_000);
  try {
    const response = await fetch(config.llmEndpoint, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llmApiKey}` },
      body: JSON.stringify({ model: config.llmModel, temperature: 0.25, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: `${config.llmSystemPrompt}\n${SCHEMA_INSTRUCTION}` }, { role: 'user', content: sourceText }] }),
    });
    if (!response.ok) throw new Error(`文本模型返回 ${response.status}: ${(await response.text()).slice(0, 800)}`);
    const payload = await response.json();
    const content = payload.choices?.[0]?.message?.content ?? payload.output?.text ?? payload.result;
    return extractJson(content);
  } finally { clearTimeout(timer); }
}

export async function analyzeNovel(config, { text, filename, name }, { onProgress, shouldCancel } = {}) {
  validateLlmConfig(config);
  if (!text.trim()) throw new Error('小说文本为空');
  const fallbackName = name || filename.replace(/\.[^.]+$/, '');
  const chunks = splitNovel(text);
  const merged = { project: { name: fallbackName, genre: '' }, characters: [], scenes: [] };
  for (let index = 0; index < chunks.length; index += 1) {
    if (shouldCancel?.()) {
      const error = new Error('小说拆解任务已取消');
      error.code = 'TASK_CANCELLED';
      throw error;
    }
    onProgress?.({ current: index + 1, total: chunks.length, progress: 8 + Math.round((index / chunks.length) * 82) });
    const roster = merged.characters.length ? `\n\n已确认角色表（后续必须沿用这些 id，同名人物不可新建 id）：\n${JSON.stringify(merged.characters)}` : '';
    const result = await callLlm(config, `作品名：${fallbackName}\n这是第 ${index + 1} / ${chunks.length} 段，请只拆解本段，不重复前文场景。${roster}\n\n小说原文：\n${chunks[index]}`);
    if (index === 0) merged.project = { ...merged.project, ...result.project };
    else if (!merged.project.genre && result.project?.genre) merged.project.genre = result.project.genre;
    mergeAnalysis(merged, result);
  }
  onProgress?.({ current: chunks.length, total: chunks.length, progress: 94 });
  return normalizeResult(merged, fallbackName);
}

import { randomUUID } from 'node:crypto';
import { normalizeAge, normalizeGender } from './character-meta.js';
import { llmChatUrl } from '../shared/endpoint.mjs';
import { numberOr } from '../shared/generation-requests.mjs';
import { BASE_GAP_AFTER_MS, normalizeDistance } from '../shared/mix-defaults.mjs';
import { DIRECTOR_PLAN_INSTRUCTION, DIRECTOR_SCENE_INSTRUCTION, DIRECTOR_SINGLE_INSTRUCTION, MAX_SCENES_PER_CHUNK } from './director-prompts.js';
import { LLM_DEFAULT_TIMEOUT_MS, validateLlmConfig } from './llm-client.js';

// 提示词与文本模型客户端已拆到独立模块；这里继续导出，原有导入路径不变。
export { DIRECTOR_PLAN_INSTRUCTION, DIRECTOR_SCENE_INSTRUCTION, DIRECTOR_SINGLE_INSTRUCTION, MAX_SCENES_PER_CHUNK } from './director-prompts.js';
export * from './llm-client.js';

export const DEFAULT_TWO_STAGE_MIN_CHARS = 1_400;

const SOUND_PREFIX = /^(?:\[(?:环境声|环境|动作音效|音效|背景音乐|配乐|音乐|SFX|BGM|AMBIENT)\]|(?:环境声|动作音效|音效|背景音乐|配乐|音乐)\s*[:：])\s*/i;
const BOILERPLATE_SUBTEXT = /^(?:按当前剧情上下文表达|按剧情上下文表达|按上下文表达|按情境表达|正常表达|无潜台词|暂无|无|略)[。.\s]*$/;
const EMOTION_SUFFIX = /(?:的语气|语气|的情绪|情绪)$/;
const CHAPTER_HEADING = /^\s*(?:第[0-9一二三四五六七八九十百千万零两]+[章节回卷集幕部篇]|chapter\s+\d+|序章|楔子|引子|尾声|番外|后记)(?:[\s:：·—\-].*|$)/i;
const SCENE_DIVIDER = /^\s*(?:[*\-=~—─·•]{3,}|[◆◇★☆■□●○]{2,})\s*$/;

function extractJson(content) {
  // 推理模型（DeepSeek-R1 / Qwen3 等本地部署）常把思考过程放在 <think> 里，里面可能有花括号。
  const text = String(content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('文本模型没有返回 JSON 对象');
  try { return JSON.parse(text.slice(start, end + 1)); }
  catch (error) { throw new Error(`文本模型返回的 JSON 无法解析: ${error.message}`); }
}

function cleanSoundText(value) {
  return String(value || '').trim().replace(SOUND_PREFIX, '').trim();
}

function cleanSubtext(value) {
  const text = String(value || '').trim();
  if (!text || BOILERPLATE_SUBTEXT.test(text)) return '';
  return text.slice(0, 100);
}

function cleanEmotion(value) {
  const text = String(value || '').trim().replace(EMOTION_SUFFIX, '').trim();
  return (text || '克制').slice(0, 12);
}

function normalizeDialogueMix(line) {
  const baseMix = line.mix && typeof line.mix === 'object' ? { ...line.mix } : null;
  const hasExplicitGap = baseMix && baseMix.gapAfterMs !== undefined && baseMix.gapAfterMs !== null && baseMix.gapAfterMs !== '';
  const rawPause = line.pauseAfterMs ?? line.gapAfterMs ?? baseMix?.gapAfterMs;
  const parsed = rawPause === '' || rawPause === null || rawPause === undefined ? NaN : Number(rawPause);
  if (Number.isFinite(parsed) && parsed >= 0) {
    const clamped = Math.round(Math.min(3_000, Math.max(0, parsed)));
    if (hasExplicitGap || Math.abs(clamped - BASE_GAP_AFTER_MS) >= 40) {
      return { ...(baseMix || {}), gapAfterMs: clamped };
    }
  }
  return baseMix && Object.keys(baseMix).length ? baseMix : undefined;
}

function normalizeSoundKey(text) {
  return cleanSoundText(text).toLowerCase().replace(/[\s，。、；：！？,.!?;:·—\-()（）[\]【】]/g, '');
}

function bigrams(text) {
  const set = new Set();
  for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
  return set;
}

function isRedundantAmbient(existingKeys, text) {
  const key = normalizeSoundKey(text);
  if (!key) return true;
  for (const prev of existingKeys) {
    if (!prev) continue;
    if (prev === key || prev.includes(key) || key.includes(prev)) return true;
    const a = bigrams(prev);
    const b = bigrams(key);
    if (a.size && b.size) {
      let overlap = 0;
      for (const token of b) if (a.has(token)) overlap += 1;
      if (overlap / Math.min(a.size, b.size) >= 0.45) return true;
    }
  }
  return false;
}

function dedupeSceneLines(lines) {
  const result = [];
  const seenAmbients = [];
  for (const line of lines) {
    if (line.type === 'dialogue') {
      result.push(line);
      continue;
    }
    const key = normalizeSoundKey(line.text);
    if (!key) continue;
    const previous = result[result.length - 1];
    if (previous && previous.type === line.type && normalizeSoundKey(previous.text) === key) continue;
    if (line.type === 'ambient') {
      if (isRedundantAmbient(seenAmbients, line.text)) continue;
      seenAmbients.push(key);
    }
    result.push(line);
  }
  return result;
}

function normalizeLine(line, characterIds, characterByName = new Map()) {
  const type = ['dialogue', 'ambient', 'sfx', 'music'].includes(line.type) ? line.type : 'dialogue';
  if (type !== 'dialogue') {
    const mix = line.mix && typeof line.mix === 'object' ? { ...line.mix } : undefined;
    return {
      id: randomUUID(),
      type,
      label: type === 'ambient' ? '环境声' : type === 'sfx' ? '动作音效' : '背景音乐',
      text: cleanSoundText(line.text),
      ...(mix ? { mix } : {}),
    };
  }
  const speaker = String(line.speaker || '旁白').trim() || '旁白';
  let speakerId = String(line.speakerId || (speaker === '旁白' ? 'narrator' : speaker)).trim();
  if (speaker === '旁白' || speakerId === 'narrator') {
    speakerId = 'narrator';
  } else if (!characterIds.has(speakerId)) {
    speakerId = characterByName.get(speaker) || speakerId.toLowerCase().replace(/\s+/g, '-');
  }
  const mix = normalizeDialogueMix(line);
  return {
    id: randomUUID(),
    type: 'dialogue',
    speaker,
    speakerId,
    text: String(line.text || '').trim(),
    subtext: cleanSubtext(line.subtext),
    emotion: cleanEmotion(line.emotion),
    intensity: Math.round(Math.min(100, Math.max(0, numberOr(line.intensity, 40)))),
    pace: Math.round(Math.min(120, Math.max(70, numberOr(line.pace, 90)))),
    distance: normalizeDistance(line.distance),
    ...(mix ? { mix } : {}),
  };
}

function normalizeCharacter(character) {
  const voiceDescription = String(character.voiceDescription || '').trim().slice(0, 500);
  return {
    id: String(character.id || randomUUID()).trim() || randomUUID(),
    name: String(character.name || '未命名角色').trim() || '未命名角色',
    role: String(character.role || '角色').trim() || '角色',
    gender: normalizeGender(character.gender),
    age: normalizeAge(character.age),
    description: String(character.description || '').trim(),
    ...(voiceDescription ? { voiceDescription } : {}),
  };
}

function normalizeResult(result, fallbackName) {
  if (!Array.isArray(result.scenes) || !result.scenes.length) throw new Error('文本模型没有返回可用场景');
  const characters = Array.isArray(result.characters) ? result.characters.map(normalizeCharacter) : [];
  if (!characters.some((item) => item.id === 'narrator')) {
    characters.unshift({
      id: 'narrator',
      name: '旁白',
      role: '叙事者',
      gender: '未知',
      age: '未知',
      description: '沉稳克制、具画面感与压迫感的精品有声剧旁白，节奏收放自如。',
      voiceDescription: '中性偏成熟声线，中低音区，沉稳清晰，吐字有力，叙事节奏收放自如。',
    });
  }
  const characterIds = new Set(characters.map((item) => item.id));
  const characterByName = new Map(characters.map((item) => [item.name, item.id]));
  const scenes = result.scenes.map((scene, index) => {
    const rawLines = (scene.lines || []).map((line) => normalizeLine(line, characterIds, characterByName)).filter((line) => line.text);
    const lines = dedupeSceneLines(rawLines);
    const emotionArc = String(scene.emotionArc || '').trim().slice(0, 200);
    const directorNote = String(scene.directorNote || '').trim().slice(0, 240);
    return {
      id: randomUUID(),
      number: String(index + 1).padStart(2, '0'),
      title: String(scene.title || `场景 ${index + 1}`).trim() || `场景 ${index + 1}`,
      duration: '待生成',
      cast: [...new Set(lines.filter((line) => line.type === 'dialogue').map((line) => line.speaker))].join(' · ') || '旁白',
      status: 'pending',
      location: String(scene.location || '待设定').trim() || '待设定',
      mood: String(scene.mood || '待导演').trim() || '待导演',
      synopsis: String(scene.synopsis || '').trim(),
      ...(emotionArc ? { emotionArc } : {}),
      ...(directorNote ? { directorNote } : {}),
      lines,
    };
  }).filter((scene) => scene.lines.length);
  if (!scenes.length) throw new Error('文本模型没有返回可用场景');
  return { name: String(result.project?.name || fallbackName || '未命名作品'), genre: String(result.project?.genre || ''), characters, scenes };
}

// Exported for tests.
// 优先在章节标题、分隔线或空行处切分，避免把一场戏从对白中间拦腰切断；
// 若没有自然分隔（如纯单换行密排正文），退回段落边界紧密打包，保证每块 <= maxChars。
export function splitNovel(text, maxChars = 24_000) {
  const chunks = [];
  const rawLines = String(text || '').split(/\r?\n/);
  const pieces = [];
  for (const line of rawLines) {
    if (line.length > maxChars) {
      const slices = line.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, 'g')) || [];
      pieces.push(...slices);
    } else {
      pieces.push(line);
    }
  }

  let current = [];
  let currentLen = 0;
  const minKeep = Math.floor(maxChars * 0.45);
  const joinedLength = (lines) => lines.reduce((sum, item, idx) => sum + item.length + (idx > 0 ? 1 : 0), 0);
  const flushLines = (lines) => {
    const chunk = lines.join('\n').replace(/^\n+|\n+$/g, '');
    if (chunk.trim()) chunks.push(chunk);
  };
  const findNaturalSplit = (lines) => {
    let prefixLen = 0;
    let bestStrong = -1;
    let bestBlank = -1;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (i > 0 && prefixLen >= minKeep && (CHAPTER_HEADING.test(line) || SCENE_DIVIDER.test(line))) {
        bestStrong = i;
      }
      prefixLen += (i > 0 ? 1 : 0) + line.length;
      if (line.trim() === '' && prefixLen >= minKeep && i + 1 < lines.length) {
        bestBlank = i + 1;
      }
    }
    if (bestStrong > 0) return bestStrong;
    if (bestBlank > 0) return bestBlank;
    return -1;
  };

  for (let idx = 0; idx < pieces.length; idx += 1) {
    const part = pieces[idx];
    const nextLen = current.length ? currentLen + 1 + part.length : part.length;
    if (nextLen > maxChars && current.length) {
      const splitAt = findNaturalSplit(current);
      if (splitAt > 0) {
        flushLines(current.slice(0, splitAt));
        current = current.slice(splitAt);
        while (current.length && current[0].trim() === '') current.shift();
        currentLen = joinedLength(current);
        idx -= 1;
        continue;
      }
      flushLines(current);
      current = [part];
      currentLen = part.length;
    } else {
      current.push(part);
      currentLen = nextLen;
    }
  }
  if (current.length) flushLines(current);
  return chunks;
}

function extractParagraphs(chunkText) {
  return String(chunkText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatNumberedParagraphs(paragraphs) {
  return paragraphs.map((line, index) => `[P${index + 1}] ${line}`).join('\n');
}

function normalizeSoundPlan(raw) {
  if (!raw || typeof raw !== 'object') return { ambient: '', keySfx: [], musicCue: '' };
  const keySfx = Array.isArray(raw.keySfx) ? raw.keySfx.map((item) => cleanSoundText(item)).filter(Boolean).slice(0, 8) : [];
  return {
    ambient: cleanSoundText(raw.ambient),
    keySfx,
    musicCue: cleanSoundText(raw.musicCue),
  };
}

function buildDirectorNote(plan) {
  const parts = [String(plan.cameraStrategy || '').trim(), String(plan.soundPlan?.musicCue || '').trim()].filter(Boolean);
  return parts.join('；').slice(0, 200);
}

// Exported for tests. 将阶段一产出的分场规划修正为对 [1..paragraphs.length] 的连续、无遗漏覆盖。
export function resolveScenePlans(paragraphs, rawPlans, { hasPreviousScene = false, maxScenes = MAX_SCENES_PER_CHUNK } = {}) {
  const total = Math.max(1, paragraphs.length);
  if (!Array.isArray(rawPlans) || !rawPlans.length) return null;

  const cleaned = rawPlans
    .filter((item) => item && typeof item === 'object')
    .map((item, idx) => {
      const rawStart = Number(item.startParagraph);
      const rawEnd = Number(item.endParagraph);
      const validStart = Number.isFinite(rawStart) ? Math.min(total, Math.max(1, Math.round(rawStart))) : null;
      const validEnd = Number.isFinite(rawEnd) ? Math.min(total, Math.max(1, Math.round(rawEnd))) : null;
      return {
        order: idx,
        title: String(item.title || `场景 ${idx + 1}`).trim() || `场景 ${idx + 1}`,
        continuesPrevious: Boolean(item.continuesPrevious),
        location: String(item.location || '').trim(),
        mood: String(item.mood || '').trim(),
        synopsis: String(item.synopsis || '').trim(),
        emotionArc: String(item.emotionArc || '').trim(),
        cameraStrategy: String(item.cameraStrategy || '').trim(),
        soundPlan: normalizeSoundPlan(item.soundPlan),
        startParagraph: validStart,
        endParagraph: validEnd !== null && validStart !== null ? Math.max(validStart, validEnd) : validEnd,
      };
    });

  if (!cleaned.length) return null;

  const hasAnyRange = cleaned.some((item) => item.startParagraph !== null);
  let plans;
  if (!hasAnyRange) {
    const capped = cleaned.slice(0, Math.max(1, maxScenes));
    const step = total / capped.length;
    plans = capped.map((item, idx) => ({
      ...item,
      startParagraph: Math.min(total, Math.floor(idx * step) + 1),
      endParagraph: idx === capped.length - 1 ? total : Math.max(Math.floor(idx * step) + 1, Math.floor((idx + 1) * step)),
    }));
  } else {
    const sorted = [...cleaned]
      .filter((item) => item.startParagraph !== null)
      .sort((a, b) => a.startParagraph - b.startParagraph || a.order - b.order);
    plans = [];
    let cursor = 1;
    for (const item of sorted) {
      if (cursor > total) break;
      const start = cursor;
      const rawEnd = item.endParagraph ?? item.startParagraph;
      const end = Math.min(total, Math.max(start, rawEnd));
      plans.push({ ...item, startParagraph: start, endParagraph: end });
      cursor = end + 1;
    }
    if (plans.length && plans[plans.length - 1].endParagraph < total) {
      plans[plans.length - 1].endParagraph = total;
    }
  }

  if (!plans.length) return null;

  // 若模型切得过碎，合并最短的相邻分场，保证单块调用次数可控。
  const limit = Math.max(1, maxScenes);
  while (plans.length > limit) {
    let mergeIdx = 0;
    let smallestSpan = Infinity;
    for (let i = 0; i < plans.length - 1; i += 1) {
      const span = (plans[i].endParagraph - plans[i].startParagraph + 1) + (plans[i + 1].endParagraph - plans[i + 1].startParagraph + 1);
      if (span < smallestSpan) { smallestSpan = span; mergeIdx = i; }
    }
    const left = plans[mergeIdx];
    const right = plans[mergeIdx + 1];
    plans.splice(mergeIdx, 2, {
      ...left,
      endParagraph: right.endParagraph,
      synopsis: [left.synopsis, right.synopsis].filter(Boolean).join('；'),
      emotionArc: [left.emotionArc, right.emotionArc].filter(Boolean).join(' → '),
      cameraStrategy: [left.cameraStrategy, right.cameraStrategy].filter(Boolean).join('；'),
      soundPlan: {
        ambient: left.soundPlan.ambient || right.soundPlan.ambient,
        keySfx: [...new Set([...left.soundPlan.keySfx, ...right.soundPlan.keySfx])].slice(0, 8),
        musicCue: [left.soundPlan.musicCue, right.soundPlan.musicCue].filter(Boolean).join('；'),
      },
    });
  }

  return plans.map((item, idx) => ({
    title: item.title,
    continuesPrevious: idx === 0 && hasPreviousScene && Boolean(item.continuesPrevious),
    location: item.location,
    mood: item.mood,
    synopsis: item.synopsis,
    emotionArc: item.emotionArc,
    cameraStrategy: item.cameraStrategy,
    soundPlan: item.soundPlan,
    startParagraph: item.startParagraph,
    endParagraph: item.endParagraph,
  }));
}

function summarizePreviousScene(scene) {
  if (!scene || !Array.isArray(scene.lines) || !scene.lines.length) return null;
  const lastAmbient = [...scene.lines].reverse().find((line) => line.type === 'ambient')?.text || '';
  const lastMusic = [...scene.lines].reverse().find((line) => line.type === 'music')?.text || '';
  const tailLines = scene.lines
    .filter((line) => line.type === 'dialogue' || line.type === 'sfx')
    .slice(-4)
    .map((line) => (line.type === 'dialogue'
      ? `${line.speaker || '旁白'}（${cleanEmotion(line.emotion)}/${normalizeDistance(line.distance)}）：${String(line.text || '').slice(0, 80)}`
      : `[动作音效] ${cleanSoundText(line.text).slice(0, 60)}`));
  return {
    title: String(scene.title || ''),
    location: String(scene.location || ''),
    mood: String(scene.mood || ''),
    synopsis: String(scene.synopsis || ''),
    emotionArc: String(scene.emotionArc || ''),
    ambient: cleanSoundText(lastAmbient),
    music: cleanSoundText(lastMusic),
    tailLines,
  };
}

function formatPreviousSceneNote(previous, { allowContinue = true } = {}) {
  if (!previous) return '';
  const lines = [
    previous.title ? `标题：${previous.title}` : '',
    previous.location ? `地点：${previous.location}` : '',
    previous.mood ? `气氛：${previous.mood}` : '',
    previous.ambient ? `当前环境声：${previous.ambient}` : '',
    previous.music ? `当前配乐：${previous.music}` : '',
    previous.tailLines?.length ? `尾段衔接：\n${previous.tailLines.map((item) => `  - ${item}`).join('\n')}` : '',
  ].filter(Boolean);
  if (!lines.length) return '';
  const hint = allowContinue
    ? '（若本段开头紧接同一时空/对话未断开，请设 continuesPrevious: true 且不要重复铺设相同环境声；若已换场则设 false）'
    : '（仅供衔接前文氛围与人物状态参考，请开启新场景，continuesPrevious 设为 false）';
  return `\n\n上一段尾场衔接${hint}：\n${lines.join('\n')}`;
}

function formatRosterNote(characters) {
  if (!characters?.length) return '';
  const compact = characters.map((item) => ({
    id: item.id,
    name: item.name,
    role: item.role || '',
    ...(item.gender && item.gender !== '未知' ? { gender: item.gender } : {}),
    ...(item.age && item.age !== '未知' ? { age: item.age } : {}),
  }));
  return `\n\n已确认角色表（后续必须沿用这些 id，同名人物不可新建 id；旁白固定 narrator）：\n${JSON.stringify(compact)}`;
}

function mergeCharacters(target, incoming = []) {
  const canonicalById = new Map(target.characters.map((item) => [String(item.id), item]));
  const canonicalByName = new Map(target.characters.map((item) => [String(item.name), item]));
  const idAliases = new Map();
  for (const character of incoming || []) {
    if (!character || typeof character !== 'object') continue;
    const rawId = String(character.id || randomUUID()).trim() || randomUUID();
    const name = String(character.name || '未命名角色').trim() || '未命名角色';
    const existing = canonicalById.get(rawId) || canonicalByName.get(name);
    if (existing) {
      // 仅补充缺失信息，不覆盖已确认字段。
      if (!existing.voiceDescription && String(character.voiceDescription || '').trim()) {
        existing.voiceDescription = String(character.voiceDescription).trim().slice(0, 500);
      }
      if (!existing.description && String(character.description || '').trim()) {
        existing.description = String(character.description).trim();
      }
      if ((!existing.gender || existing.gender === '未知') && normalizeGender(character.gender) !== '未知') {
        existing.gender = normalizeGender(character.gender);
      }
      if ((!existing.age || existing.age === '未知') && normalizeAge(character.age) !== '未知') {
        existing.age = normalizeAge(character.age);
      }
      idAliases.set(rawId, existing.id);
      continue;
    }
    const canonical = { ...character, id: rawId, name };
    target.characters.push(canonical);
    canonicalById.set(canonical.id, canonical);
    canonicalByName.set(canonical.name, canonical);
    idAliases.set(rawId, canonical.id);
  }
  return { idAliases, canonicalByName };
}

function mergeAnalysis(target, result, { allowContinue = true } = {}) {
  const { idAliases, canonicalByName } = mergeCharacters(target, result.characters || []);
  const incomingScenes = result.scenes || [];
  for (let sceneIndex = 0; sceneIndex < incomingScenes.length; sceneIndex += 1) {
    const scene = incomingScenes[sceneIndex];
    if (!scene || typeof scene !== 'object') continue;
    const mappedLines = (scene.lines || []).map((line) => {
      if (!line || typeof line !== 'object') return null;
      if (line.type !== 'dialogue') return line;
      const speaker = String(line.speaker || '');
      const rawSpeakerId = String(line.speakerId || '');
      if (speaker === '旁白' || rawSpeakerId === 'narrator') return { ...line, speakerId: 'narrator' };
      const byName = canonicalByName.get(speaker);
      return { ...line, speakerId: idAliases.get(rawSpeakerId) || byName?.id || rawSpeakerId };
    }).filter(Boolean);

    const canContinue = sceneIndex === 0 && allowContinue && Boolean(scene.continuesPrevious) && target.scenes.length > 0;
    if (canContinue) {
      const previous = target.scenes[target.scenes.length - 1];
      const existingAmbients = (previous.lines || [])
        .filter((line) => line.type === 'ambient')
        .map((line) => normalizeSoundKey(line.text));
      const trimmedLines = [...mappedLines];
      while (trimmedLines.length && trimmedLines[0].type === 'ambient' && isRedundantAmbient(existingAmbients, trimmedLines[0].text)) {
        trimmedLines.shift();
      }
      previous.lines = [...(previous.lines || []), ...trimmedLines];
      const incomingArc = String(scene.emotionArc || '').trim();
      if (incomingArc && !String(previous.emotionArc || '').includes(incomingArc)) {
        previous.emotionArc = previous.emotionArc ? `${previous.emotionArc} → ${incomingArc}` : incomingArc;
      }
      const incomingSynopsis = String(scene.synopsis || '').trim();
      if (incomingSynopsis && !String(previous.synopsis || '').includes(incomingSynopsis)) {
        const joined = previous.synopsis ? `${previous.synopsis}；${incomingSynopsis}` : incomingSynopsis;
        if (joined.length <= 160) previous.synopsis = joined;
      }
      if ((!previous.mood || previous.mood === '待导演') && scene.mood) previous.mood = scene.mood;
      continue;
    }

    const { continuesPrevious: _ignored, ...cleanScene } = scene;
    target.scenes.push({ ...cleanScene, lines: mappedLines });
  }
}

// 有的 OpenAI 兼容服务（LM Studio、部分 vLLM / 旧版 llama.cpp）不认
// response_format: json_object，返回 400/422。此时去掉它重试一次，靠提示词约束 JSON。
const rejectsJsonMode = (status, text) => [400, 422].includes(status) && /response_format|json_object|json_schema/i.test(text);

async function callLlm(config, userPrompt, { systemInstruction = DIRECTOR_SINGLE_INSTRUCTION, temperature = 0.3, maxTokens = 16_384 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(config.llmTimeoutMs) || LLM_DEFAULT_TIMEOUT_MS);
  const headers = { 'Content-Type': 'application/json', ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}) };
  const systemBase = String(config.llmSystemPrompt || '').trim();
  const systemContent = systemBase ? `${systemBase}\n\n${systemInstruction}` : systemInstruction;
  const body = { model: config.llmModel, temperature, max_tokens: maxTokens, messages: [{ role: 'system', content: systemContent }, { role: 'user', content: userPrompt }] };
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
async function callWithRetry(call, config, prompt, { shouldCancel, retryDelayMs, callOptions }) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await call(config, prompt, callOptions); }
    catch (error) {
      if (attempt >= 1 || error.code === 'TASK_CANCELLED' || error.name === 'AbortError') throw error;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      if (shouldCancel?.()) throw error;
    }
  }
}

function checkCancelled(shouldCancel) {
  if (!shouldCancel?.()) return;
  const error = new Error('小说拆解任务已取消');
  error.code = 'TASK_CANCELLED';
  throw error;
}

function buildSingleStagePrompt({ fallbackName, index, totalChunks, rosterNote, previousNote, chunkText }) {
  return `作品名：${fallbackName}\n这是第 ${index + 1} / ${totalChunks} 段，请按精品电影感多人有声剧导演分镜规范拆解本段，不重复前文场景。${rosterNote}${previousNote}\n\n小说原文：\n${chunkText}`;
}

function buildPlanPrompt({ fallbackName, index, totalChunks, rosterNote, previousNote, paragraphs }) {
  return `作品名：${fallbackName}\n这是第 ${index + 1} / ${totalChunks} 段（共 ${paragraphs.length} 个编号段落），请完成本段的角色建档与分场听觉分镜规划。${rosterNote}${previousNote}\n\n带段落编号的小说原文：\n${formatNumberedParagraphs(paragraphs)}`;
}

function buildScenePrompt({ fallbackName, index, totalChunks, sceneIndex, totalScenes, plan, rosterNote, previousNote, excerpt }) {
  const planBrief = {
    title: plan.title,
    continuesPrevious: plan.continuesPrevious,
    location: plan.location,
    mood: plan.mood,
    synopsis: plan.synopsis,
    emotionArc: plan.emotionArc,
    cameraStrategy: plan.cameraStrategy,
    soundPlan: plan.soundPlan,
  };
  return `作品名：${fallbackName}\n当前进度：第 ${index + 1} / ${totalChunks} 段 · 第 ${sceneIndex + 1} / ${totalScenes} 场\n请严格按照下方导演分镜单精写本场听觉分镜剧本，覆盖全部对应原文，不遗漏关键对白与动作拟音。\n\n本场导演分镜单：\n${JSON.stringify(planBrief)}${rosterNote}${previousNote}\n\n本场对应小说原文：\n${excerpt}`;
}

function extractStageTwoScenes(sceneResult, plan, isFirstSceneInChunk) {
  const rawScenes = Array.isArray(sceneResult?.scenes) && sceneResult.scenes.length
    ? sceneResult.scenes
    : (sceneResult?.scene && typeof sceneResult.scene === 'object' ? [sceneResult.scene] : []);
  return rawScenes.map((scene, idx) => ({
    ...scene,
    title: String(scene.title || plan.title || '').trim(),
    location: String(scene.location || plan.location || '').trim(),
    mood: String(scene.mood || plan.mood || '').trim(),
    synopsis: String(scene.synopsis || plan.synopsis || '').trim(),
    emotionArc: String(scene.emotionArc || plan.emotionArc || '').trim(),
    directorNote: String(scene.directorNote || buildDirectorNote(plan) || '').trim(),
    continuesPrevious: isFirstSceneInChunk && idx === 0 && Boolean(plan.continuesPrevious),
  }));
}

export async function analyzeNovel(
  config,
  { text, filename, name, seedCharacters = [], seedPreviousScene = null },
  { onProgress, shouldCancel, resume, onCheckpoint, call = callLlm, chunkChars = 6_000, retryDelayMs = 2_500, twoStage = true, twoStageMinChars = DEFAULT_TWO_STAGE_MIN_CHARS } = {},
) {
  if (!text.trim()) throw new Error('小说文本为空');
  const fallbackName = name || filename.replace(/\.[^.]+$/, '');
  const seedRoster = Array.isArray(seedCharacters) ? seedCharacters : [];
  // 文本模型是唯一的拆解路径；没配置或配置不完整时直接报错，不再退回规则拆解。
  validateLlmConfig(config);
  const chunks = splitNovel(text, chunkChars);
  // Chunk & scene-level resume: failed runs checkpoint after every completed
  // stage/scene/chunk; retryTask copies the task payload so retry only pays
  // for the unfinished work.
  const chunksDone = Math.max(0, Math.min(Number(resume?.chunksDone) || 0, chunks.length - 1));
  const resumedActive = resume?.activeChunk && Number(resume.activeChunk.index) === chunksDone ? resume.activeChunk : null;
  const hasResumeState = Boolean(resume?.merged && (chunksDone > 0 || resumedActive));
  const merged = hasResumeState ? structuredClone(resume.merged) : { project: { name: fallbackName, genre: '' }, characters: [...seedRoster], scenes: [] };
  const initialPreviousScene = summarizePreviousScene(seedPreviousScene);

  for (let index = chunksDone; index < chunks.length; index += 1) {
    checkCancelled(shouldCancel);
    const chunkText = chunks[index];
    const chunkStart = 8 + Math.round((index / chunks.length) * 86);
    const chunkEnd = 8 + Math.round(((index + 1) / chunks.length) * 86);
    const chunkSpan = Math.max(1, chunkEnd - chunkStart);
    const allowChunkContinue = index > 0 && merged.scenes.length > 0;
    const previousForChunk = merged.scenes.length ? summarizePreviousScene(merged.scenes[merged.scenes.length - 1]) : initialPreviousScene;
    const useTwoStage = Boolean(twoStage) && chunkText.length >= twoStageMinChars;

    if (!useTwoStage) {
      onProgress?.({
        current: index + 1,
        total: chunks.length,
        progress: chunkStart,
        stage: 'single',
        message: chunks.length > 1 ? `正在拆解原文 ${index + 1} / ${chunks.length} 段` : '正在精写听觉分镜剧本',
      });
      const prompt = buildSingleStagePrompt({
        fallbackName,
        index,
        totalChunks: chunks.length,
        rosterNote: formatRosterNote(merged.characters),
        previousNote: formatPreviousSceneNote(previousForChunk, { allowContinue: allowChunkContinue }),
        chunkText,
      });
      const result = await callWithRetry(call, config, prompt, {
        shouldCancel,
        retryDelayMs,
        callOptions: { stage: 'single', systemInstruction: DIRECTOR_SINGLE_INSTRUCTION, temperature: 0.35 },
      });
      if (index === 0) merged.project = { ...merged.project, ...result.project };
      else if (!merged.project.genre && result.project?.genre) merged.project.genre = result.project.genre;
      mergeAnalysis(merged, result, { allowContinue: allowChunkContinue });
      onCheckpoint?.({ chunksDone: index + 1, merged });
      continue;
    }

    // Two-stage director pipeline:
    // Stage 1: Director reading + scene breakdown plan over numbered paragraphs.
    // Stage 2: Dedicated cinematic audio storyboard scripting per planned scene.
    const paragraphs = extractParagraphs(chunkText);
    const active = resumedActive && resumedActive.index === index ? resumedActive : null;
    let scenePlans = active?.scenePlans || null;
    let startSceneIndex = active ? Math.max(0, Number(active.scenesDone) || 0) : 0;

    if (!scenePlans) {
      const prefix = chunks.length > 1 ? `第 ${index + 1} / ${chunks.length} 段 · ` : '';
      onProgress?.({
        current: index + 1,
        total: chunks.length,
        progress: chunkStart,
        stage: 'plan',
        message: `${prefix}导演读本与分场策划`,
      });
      const planPrompt = buildPlanPrompt({
        fallbackName,
        index,
        totalChunks: chunks.length,
        rosterNote: formatRosterNote(merged.characters),
        previousNote: formatPreviousSceneNote(previousForChunk, { allowContinue: allowChunkContinue }),
        paragraphs,
      });
      const planResult = await callWithRetry(call, config, planPrompt, {
        shouldCancel,
        retryDelayMs,
        callOptions: { stage: 'plan', systemInstruction: DIRECTOR_PLAN_INSTRUCTION, temperature: 0.2 },
      });
      if (index === 0 && planResult?.project) merged.project = { ...merged.project, ...planResult.project };
      else if (!merged.project.genre && planResult?.project?.genre) merged.project.genre = planResult.project.genre;

      const resolved = resolveScenePlans(paragraphs, planResult?.scenePlan, { hasPreviousScene: allowChunkContinue });
      if (!resolved) {
        // 兼容未遵循分场策划格式的模型：若它直接返回了完整 scenes 则直接采纳，否则回退单阶段。
        if (Array.isArray(planResult?.scenes) && planResult.scenes.length) {
          mergeAnalysis(merged, planResult, { allowContinue: allowChunkContinue });
          onCheckpoint?.({ chunksDone: index + 1, merged, activeChunk: null });
          continue;
        }
        const fallbackPrompt = buildSingleStagePrompt({
          fallbackName,
          index,
          totalChunks: chunks.length,
          rosterNote: formatRosterNote(merged.characters),
          previousNote: formatPreviousSceneNote(previousForChunk, { allowContinue: allowChunkContinue }),
          chunkText,
        });
        const fallbackResult = await callWithRetry(call, config, fallbackPrompt, {
          shouldCancel,
          retryDelayMs,
          callOptions: { stage: 'single', systemInstruction: DIRECTOR_SINGLE_INSTRUCTION, temperature: 0.35 },
        });
        if (index === 0 && fallbackResult?.project) merged.project = { ...merged.project, ...fallbackResult.project };
        else if (!merged.project.genre && fallbackResult?.project?.genre) merged.project.genre = fallbackResult.project.genre;
        mergeAnalysis(merged, fallbackResult, { allowContinue: allowChunkContinue });
        onCheckpoint?.({ chunksDone: index + 1, merged, activeChunk: null });
        continue;
      }

      mergeCharacters(merged, planResult.characters || []);
      scenePlans = resolved;
      startSceneIndex = 0;
      onCheckpoint?.({ chunksDone: index, merged, activeChunk: { index, scenePlans, scenesDone: 0 } });
    }

    for (let sceneIndex = startSceneIndex; sceneIndex < scenePlans.length; sceneIndex += 1) {
      checkCancelled(shouldCancel);
      const plan = scenePlans[sceneIndex];
      const prefix = chunks.length > 1 ? `第 ${index + 1} / ${chunks.length} 段 · ` : '';
      const titleSuffix = plan.title ? `（${plan.title}）` : '';
      onProgress?.({
        current: index + 1,
        total: chunks.length,
        sceneIndex: sceneIndex + 1,
        sceneTotal: scenePlans.length,
        progress: chunkStart + Math.round((0.2 + 0.8 * (sceneIndex / scenePlans.length)) * chunkSpan),
        stage: 'scene',
        message: `${prefix}精写第 ${sceneIndex + 1} / ${scenePlans.length} 场分镜${titleSuffix}`,
      });
      const excerpt = paragraphs.slice(plan.startParagraph - 1, plan.endParagraph).join('\n');
      const allowSceneContinue = sceneIndex === 0 && allowChunkContinue && Boolean(plan.continuesPrevious);
      const previousForScene = merged.scenes.length ? summarizePreviousScene(merged.scenes[merged.scenes.length - 1]) : initialPreviousScene;
      const scenePrompt = buildScenePrompt({
        fallbackName,
        index,
        totalChunks: chunks.length,
        sceneIndex,
        totalScenes: scenePlans.length,
        plan,
        rosterNote: formatRosterNote(merged.characters),
        previousNote: formatPreviousSceneNote(previousForScene, { allowContinue: allowSceneContinue }),
        excerpt,
      });
      const sceneResult = await callWithRetry(call, config, scenePrompt, {
        shouldCancel,
        retryDelayMs,
        callOptions: { stage: 'scene', systemInstruction: DIRECTOR_SCENE_INSTRUCTION, temperature: 0.35 },
      });
      const extractedScenes = extractStageTwoScenes(sceneResult, plan, sceneIndex === 0);
      mergeAnalysis(merged, { characters: sceneResult?.characters || [], scenes: extractedScenes }, { allowContinue: allowSceneContinue });
      const finishedChunk = sceneIndex + 1 >= scenePlans.length;
      onCheckpoint?.(finishedChunk
        ? { chunksDone: index + 1, merged, activeChunk: null }
        : { chunksDone: index, merged, activeChunk: { index, scenePlans, scenesDone: sceneIndex + 1 } });
    }
  }

  onProgress?.({ current: chunks.length, total: chunks.length, progress: 94, stage: 'done', message: '整理分镜剧本与角色表' });
  return { ...normalizeResult(merged, fallbackName), breakdown: 'llm' };
}

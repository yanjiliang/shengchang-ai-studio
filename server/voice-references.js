// 角色参考音（Breeze）：锁定一段“这个角色就该是这个声音”的参考音频 + 文本，
// 注册到 Breeze /voices，之后该角色的台词都用它克隆。
//
// 存储：project.state.voiceReferences[roleId] =
//   { referenceId, audioHash, audioUrl, transcript, description, seed, version,
//     breezeVoiceId, source: 'design' | 'upload', durationMs, createdAt }
// - 音频文件：MEDIA_DIR/ref-<audioHash>.wav（单声道 24k PCM；按内容命名，同一参考
//   重复锁定不会产生新文件）。
// - audioHash = sha256(wav 字节 ‖ 0x00 ‖ transcript)：参考指纹。只在 Breeze 且该
//   角色有参考音时进入台词缓存键（referenceHash），其他引擎/角色的缓存键不变。
// - voiceReferences 由服务端持有：浏览器整份保存项目时不能覆盖它（见 database.js）。
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildGenerationRequest } from '../shared/generation-requests.mjs';
import { audioContentHash, getProject, updateProject } from './database.js';
import { runtimePaths } from './media-store.js';
import { BreezeError, listBreezeVoices, registerBreezeVoice } from './breeze.js';

// 上传参考音时长：< 5 秒拒收，> 30 秒拒收；5–10 秒收下但带 REFERENCE_SHORT 警告
// （推荐 10–30 秒）。这三个数只在这里定义，报错文案 / 警告都从这里取。
export const REFERENCE_MIN_SECONDS = 5;
export const REFERENCE_RECOMMENDED_MIN_SECONDS = 10;
export const REFERENCE_MAX_SECONDS = 30;
export const REFERENCE_MAX_BYTES = 20 * 1024 * 1024;
export const TRANSCRIPT_MAX_CHARS = 500;
const UPLOAD_EXTENSIONS = new Set(['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'webm']);

export class ReferenceError extends Error {
  constructor(message, { status = 400, code, rule } = {}) {
    super(message);
    this.name = 'ReferenceError';
    this.status = status;
    this.code = code;
    this.rule = rule;
  }
}

export function referenceFingerprint(wav, transcript) {
  return createHash('sha256').update(wav).update(Buffer.from([0])).update(String(transcript), 'utf8').digest('hex');
}

// Breeze voice id：{roleId}-{hash8}。roleId 可能来自文本模型（中文、空格……），
// 不安全的就换成稳定的短哈希，保证 id 只含 [A-Za-z0-9_-]。
export function breezeVoiceIdFor(roleId, audioHash) {
  const safe = /^[A-Za-z0-9_-]{1,48}$/.test(roleId) ? roleId : `role-${createHash('sha256').update(String(roleId)).digest('hex').slice(0, 8)}`;
  return `${safe}-${audioHash.slice(0, 8)}`;
}

export function referenceFileUrl(audioHash) {
  if (!/^[a-f0-9]{64}$/.test(audioHash)) throw new ReferenceError('参考音频指纹无效', { code: 'REFERENCE_INVALID' });
  return `/media/ref-${audioHash}.wav`;
}

function referenceFilePath(audioHash) {
  return path.join(runtimePaths.MEDIA_DIR, path.basename(referenceFileUrl(audioHash)));
}

export function findRole(project, roleId) {
  return (project?.state?.characters || []).find((character) => character?.id === roleId) || null;
}

export function requireProjectRole(projectId, roleId) {
  const project = getProject(projectId);
  if (!project) throw new ReferenceError('项目不存在', { status: 404, code: 'PROJECT_NOT_FOUND' });
  const role = findRole(project, roleId);
  if (!role) throw new ReferenceError('角色不存在', { status: 404, code: 'ROLE_NOT_FOUND' });
  return { project, role };
}

function execFileAsync(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { error.stderr = String(stderr || ''); reject(error); } else resolve(String(stdout || ''));
    });
  });
}

async function probeSeconds(file) {
  const output = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
  const seconds = Number(output.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('无法读取时长');
  return seconds;
}

// 任意常见格式 → 单声道 24kHz 16-bit wav。输入/输出都在私有临时目录里，
// 文件名由我们生成，上传方提供的文件名从不参与路径（防路径穿越）。
export async function transcodeToMonoWav(buffer, { minSeconds = REFERENCE_MIN_SECONDS, maxSeconds = REFERENCE_MAX_SECONDS, enforceDuration = true } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'shengchang-ref-'));
  try {
    const input = path.join(dir, 'input');
    const output = path.join(dir, 'reference.wav');
    await writeFile(input, buffer);
    let seconds;
    try { seconds = await probeSeconds(input); } catch {
      throw new ReferenceError('参考音频无法解码：请上传 wav / mp3 / m4a / flac / ogg 音频', { code: 'REFERENCE_UNREADABLE', rule: 'decodable' });
    }
    if (enforceDuration && seconds < minSeconds) throw new ReferenceError(`参考音频需 ${minSeconds}–${maxSeconds} 秒，当前 ${seconds.toFixed(1)} 秒，太短`, { code: 'REFERENCE_TOO_SHORT', rule: 'duration' });
    if (enforceDuration && seconds > maxSeconds) throw new ReferenceError(`参考音频需 ${minSeconds}–${maxSeconds} 秒，当前 ${seconds.toFixed(1)} 秒，太长`, { code: 'REFERENCE_TOO_LONG', rule: 'duration' });
    const warnings = enforceDuration && seconds < REFERENCE_RECOMMENDED_MIN_SECONDS
      ? [{ code: 'REFERENCE_SHORT', message: `参考音频 ${seconds.toFixed(1)} 秒，短于推荐的 ${REFERENCE_RECOMMENDED_MIN_SECONDS}–${maxSeconds} 秒，克隆效果可能不稳定`, durationMs: Math.round(seconds * 1000), recommendedMinSeconds: REFERENCE_RECOMMENDED_MIN_SECONDS, recommendedMaxSeconds: maxSeconds }]
      : [];
    try {
      await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-map', '0:a:0', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', output]);
    } catch {
      throw new ReferenceError('参考音频转码失败（ffmpeg 无法转成单声道 wav）', { code: 'REFERENCE_UNREADABLE', rule: 'decodable' });
    }
    return { wav: await readFile(output), durationMs: Math.round(seconds * 1000), warnings };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function validateTranscript(transcript) {
  const value = String(transcript ?? '').trim();
  if (!value) throw new ReferenceError('参考文本不能为空：需要和参考音频逐字一致的文本', { code: 'REFERENCE_TRANSCRIPT_REQUIRED', rule: 'transcript' });
  if (value.length > TRANSCRIPT_MAX_CHARS) throw new ReferenceError(`参考文本最长 ${TRANSCRIPT_MAX_CHARS} 字，当前 ${value.length} 字`, { code: 'REFERENCE_TRANSCRIPT_TOO_LONG', rule: 'transcript' });
  return value;
}

export function validateUploadFile(file) {
  if (!file || typeof file.arrayBuffer !== 'function' || !file.size) throw new ReferenceError('缺少参考音频文件（表单字段 file）', { code: 'REFERENCE_FILE_REQUIRED', rule: 'file' });
  if (file.size > REFERENCE_MAX_BYTES) throw new ReferenceError(`参考音频文件最大 ${REFERENCE_MAX_BYTES / 1024 / 1024}MB`, { status: 413, code: 'REFERENCE_TOO_LARGE', rule: 'size' });
  const extension = path.extname(String(file.name || '')).slice(1).toLowerCase();
  const typeOk = String(file.type || '').startsWith('audio/') || String(file.type || '') === 'video/webm';
  if (!typeOk && !UPLOAD_EXTENSIONS.has(extension)) throw new ReferenceError('参考音频类型不支持：需要 audio/* 或 wav / mp3 / m4a / flac / ogg 文件', { status: 415, code: 'REFERENCE_UNSUPPORTED_TYPE', rule: 'type' });
}

// 每个角色一把进程内锁：同一角色并发锁定时串行执行，后到的看到前一个的结果
// （同一参考 → 幂等返回，不重复加版本）。
const roleLocks = new Map();
async function withRoleLock(key, fn) {
  const previous = roleLocks.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  const settled = next.catch(() => {});
  roleLocks.set(key, settled);
  try { return await next; } finally { if (roleLocks.get(key) === settled) roleLocks.delete(key); }
}

// 进程内记录已确认注册过的 Breeze voice（endpoint + id）。Breeze 重启会丢掉
// 注册表，所以每个进程第一次用到某个参考时先对一下 GET /voices，缺了就补注册。
const registered = new Set();
export function forgetRegisteredVoices() { registered.clear(); }

async function registerReference(config, reference, wav) {
  const key = `${config.breezeEndpoint}|${reference.breezeVoiceId}`;
  await registerBreezeVoice(config, { id: reference.breezeVoiceId, transcript: reference.transcript, wavBase64: (wav || await readFile(referenceFilePath(reference.audioHash))).toString('base64') });
  registered.add(key);
}

// 合成前调用：这个参考的 voice 在 Breeze 里不在就从本地存的参考音频 + 参考文本补注册。
// 每个进程第一次用到时核对一次（声场重启 → 重新核对）；Breeze 自己重启后进程内记录会
// 过期，那种情况由 healReferenceRegistration 在 /tts 报错时兜底。
export async function ensureReferenceRegistered(config, reference, { force = false } = {}) {
  const key = `${config.breezeEndpoint}|${reference.breezeVoiceId}`;
  if (!force && registered.has(key)) return { registered: false };
  registered.delete(key);
  const voices = await listBreezeVoices(config);
  if (voices.some((voice) => voice.id === reference.breezeVoiceId)) { registered.add(key); return { registered: false }; }
  try { await access(referenceFilePath(reference.audioHash)); } catch {
    throw new ReferenceError(`角色参考音频文件丢失（${reference.audioUrl}），无法在 Breeze 重新注册，请重新锁定参考音`, { status: 409, code: 'REFERENCE_FILE_MISSING' });
  }
  try { await registerReference(config, reference); } catch (error) {
    throw new BreezeError(`Breeze 里没有这个角色的音色（${reference.breezeVoiceId}），自动重新注册失败：${error.message}`, { status: error.status || 502, code: 'BREEZE_VOICE_REGISTER_FAILED' });
  }
  return { registered: true };
}

// /tts 报 4xx 时调用：重新核对 GET /voices（不信进程内缓存），voice 确实不在才补注册。
// 返回 true = 补注册了，调用方重试一次；false = voice 在，报错另有原因，原样抛出。
export async function healReferenceRegistration(config, reference) {
  const outcome = await ensureReferenceRegistered(config, reference, { force: true });
  return outcome.registered;
}

export const isBreezeRejection = (error) => error?.code === 'BREEZE_UPSTREAM' && [400, 404, 422].includes(error.upstreamStatus);

// 锁定：wav 已经是单声道 wav。先注册到 Breeze，成功后才写项目——Breeze 不可达
// 时项目里不会留下一个“锁了但用不了”的参考。
export async function lockReference(config, { projectId, roleId, wav, transcript, description = '', seed = null, source, durationMs = null }) {
  if (config.provider !== 'breeze') throw new ReferenceError('当前语音引擎不是 Breeze：角色参考音只在 Breeze 引擎下可用', { status: 409, code: 'ENGINE_NOT_BREEZE' });
  return withRoleLock(`${projectId}|${roleId}`, async () => {
    const { project } = requireProjectRole(projectId, roleId);
    const audioHash = referenceFingerprint(wav, transcript);
    const current = project.state.voiceReferences?.[roleId];
    const breezeVoiceId = breezeVoiceIdFor(roleId, audioHash);
    const target = referenceFilePath(audioHash);
    try { await access(target); } catch { await writeFile(target, wav); }
    if (current?.audioHash === audioHash) {
      await registerReference(config, current, wav);
      return { reference: current, unchanged: true };
    }
    const reference = {
      referenceId: randomUUID(), audioHash, audioUrl: referenceFileUrl(audioHash), transcript,
      description: String(description || '').slice(0, 500), seed: Number.isSafeInteger(seed) ? seed : null,
      version: (Number(current?.version) || 0) + 1, breezeVoiceId, source, durationMs, createdAt: Date.now(),
    };
    await registerReference(config, reference, wav);
    const fresh = getProject(projectId);
    updateProject(projectId, { trustedAudio: true, state: { ...fresh.state, voiceReferences: { ...(fresh.state.voiceReferences || {}), [roleId]: reference } } });
    return { reference, unchanged: false };
  });
}

// 生成时的解析：Breeze 下有参考音的角色 → voiceId 换成注册的 Breeze voice，
// 并把参考指纹放进请求（进缓存键）。其他情况原样返回。
export function resolveReferenceRequest(config, state, request) {
  if (config.provider !== 'breeze') return request;
  const reference = state?.voiceReferences?.[request.speakerId];
  if (!reference?.breezeVoiceId) return request;
  return { ...request, voiceId: reference.breezeVoiceId, referenceHash: reference.audioHash };
}

// Breeze 下有参考音的角色视为“已绑定音色”（选角跳过、一键成片不再当作未绑定）。
export function effectiveVoiceMap(config, state) {
  const voiceMap = { ...(state?.voiceMap || {}) };
  if (config.provider !== 'breeze') return voiceMap;
  for (const [roleId, reference] of Object.entries(state?.voiceReferences || {})) if (reference?.breezeVoiceId) voiceMap[roleId] = reference.breezeVoiceId;
  return voiceMap;
}

export function applyPronunciation(text, dictionary = []) {
  return dictionary.reduce((value, entry) => {
    const term = String(entry.term || '').trim();
    const replacement = String(entry.replacement || '').trim();
    return term && replacement ? value.split(term).join(replacement) : value;
  }, text);
}

// 按当前配置 + 参考音 + 发音词典复算这句台词“现在生成会得到的”缓存键，与
// runGenerationRequests 完全同一路径；采用过单句试听的台词带上它的 seed（audioSeed）。
export function expectedAudioHash(config, state, line, voiceMap = effectiveVoiceMap(config, state)) {
  const base = buildGenerationRequest(line, voiceMap);
  const request = { ...base, text: applyPronunciation(base.text, state?.pronunciationDictionary || []), ...(Number.isSafeInteger(line.audioSeed) ? { seed: line.audioSeed } : {}) };
  const resolved = resolveReferenceRequest(config, state, request);
  return resolved.voiceId ? audioContentHash(config, resolved) : null;
}

// stale：已有音频与“现在生成会得到的”不符，纯由缓存键推导：按当前台词/参数复算的
// hash ≠ 台词上存的 audioHash 就是 stale（台词改回原文、参数改回去都会自动恢复）。
// reason 'text' = 台词与音频原文（audioText）不同；否则 'params' = 情绪/语速/音色/
// 参考音/发音词典/引擎指令版本等任一进缓存键的参数变了（或角色已解绑音色）。
// 无法复算时（旧数据没有 audioHash，或音频是别的引擎生成的——切引擎不等于参数变了）
// 才退回按文本判断：有 audioText 对照它，没有就用持久化的 audioStale。
export function lineStaleness(config, state, line, voiceMap = effectiveVoiceMap(config, state)) {
  if (line.type !== 'dialogue' || !line.audioUrl) return { stale: false, staleReason: null };
  const textChanged = typeof line.audioText === 'string' ? String(line.text ?? '') !== line.audioText : Boolean(line.audioStale);
  if (!line.audioHash || (line.audioEngine && line.audioEngine !== (config.provider || ''))) return textChanged ? { stale: true, staleReason: 'text' } : { stale: false, staleReason: null };
  const expected = expectedAudioHash(config, state, line, voiceMap);
  if (expected === line.audioHash) return { stale: false, staleReason: null };
  return { stale: true, staleReason: textChanged ? 'text' : 'params' };
}

// 给响应用：每句台词加 stale / staleReason（不落盘；浏览器回存时 updateProject 会剥掉）。
export function annotateStaleness(config, project) {
  if (!project?.state) return project;
  const voiceMap = effectiveVoiceMap(config, project.state);
  return { ...project, state: { ...project.state, scenes: (project.state.scenes || []).map((scene) => ({ ...scene, lines: (scene.lines || []).map((line) => {
    const staleness = lineStaleness(config, project.state, line, voiceMap);
    // audioStale（前端“待重生成”徽标用）跟着推导结果走：只在台词改动导致过期时为 true。
    return { ...line, ...staleness, ...(line.audioUrl ? { audioStale: staleness.staleReason === 'text' } : {}) };
  }) })) } };
}

// 过期句数（导出结果 / 时间轴用）：有音频但 stale 的对白，可限定场景。
export function staleLineCount(config, project, { sceneIds = null } = {}) {
  const state = project?.state || {};
  const voiceMap = effectiveVoiceMap(config, state);
  let count = 0;
  for (const scene of state.scenes || []) {
    if (sceneIds && !sceneIds.includes(scene.id)) continue;
    for (const line of scene.lines || []) if (lineStaleness(config, state, line, voiceMap).stale) count += 1;
  }
  return count;
}

// 导出前检查（只读，不渲染）：会进入导出的旧音频（stale）和还没有音频的对白，
// 让前端在点导出前提示。sceneId 给定时只看这一场（对应导出单场），否则整集。
export function exportPrecheck(config, project, { sceneId = null } = {}) {
  const state = project?.state || {};
  const voiceMap = effectiveVoiceMap(config, state);
  const staleLines = [];
  let dialogueLineCount = 0;
  let missingAudioLineCount = 0;
  for (const scene of state.scenes || []) {
    if (sceneId && scene.id !== sceneId) continue;
    for (const line of scene.lines || []) {
      if (line.type !== 'dialogue') continue;
      dialogueLineCount += 1;
      if (!line.audioUrl) { missingAudioLineCount += 1; continue; }
      const { stale, staleReason } = lineStaleness(config, state, line, voiceMap);
      if (stale) staleLines.push({ sceneId: scene.id, lineId: line.id, staleReason });
    }
  }
  return { projectId: project?.id ?? null, sceneId, dialogueLineCount, staleLineCount: staleLines.length, staleLines, missingAudioLineCount, ok: staleLines.length === 0 && missingAudioLineCount === 0 };
}

// 影响范围（只读）：该角色已有音频的对白里，按当前参考 + 当前引擎配置重新算出的
// 缓存键 ≠ 台词上存的 audioHash 的，就是“需要重新生成”的句子。
export function referenceImpact(config, project, roleId) {
  const state = project.state;
  const voiceMap = effectiveVoiceMap(config, state);
  const lineIds = [];
  for (const scene of state.scenes || []) {
    for (const line of scene.lines || []) {
      if (line.type !== 'dialogue' || line.speakerId !== roleId || !line.audioUrl) continue;
      if (line.audioHash !== expectedAudioHash(config, state, line, voiceMap)) lineIds.push(line.id);
    }
  }
  return { affectedLineCount: lineIds.length, lineIds };
}

export function isReferenceError(error) {
  return error instanceof ReferenceError || error instanceof BreezeError;
}

// --- 音色就绪（Breeze）-------------------------------------------------------
// Breeze 下每个有台词的角色都需要锁定的参考音才能生成（Breeze 没有可直接用的
// 预设音色，绝不拿豆包/演示音色顶替）。hasVoiceDescription 表示该角色已有可用于
// 音色设计的描述（前端可预填设计表单）；自动设计本轮不做。
const PLACEHOLDER_DESCRIPTION = /^由规则拆解推断的说话人/;
const GENDER_WORD = { 男: '男声', 女: '女声', male: '男声', female: '女声' };
const AGE_WORD = { 儿童: '童声', 少年: '少年', 青年: '青年', 中年: '中年', 老年: '老年', child: '童声', teen: '少年', young: '青年', middle: '中年', elder: '老年' };

// 音色设计用的描述：优先拆解给出的 voiceDescription；否则用 性别/年龄 + 角色描述
// 拼一句；规则拆解的占位描述不算。没有可用信息返回 ''。
export function voiceDesignDescription(character) {
  const explicit = String(character?.voiceDescription || '').trim();
  if (explicit) return explicit.slice(0, 500);
  const description = String(character?.description || '').trim();
  if (!description || PLACEHOLDER_DESCRIPTION.test(description)) return '';
  const prefix = [AGE_WORD[character?.age], GENDER_WORD[character?.gender]].filter(Boolean).join('');
  return `${prefix ? `${prefix}，` : ''}${description}`.slice(0, 500);
}

export function speakingRoles(state) {
  const counts = new Map();
  for (const scene of state?.scenes || []) for (const line of scene.lines || []) {
    if (line.type === 'dialogue' && line.speakerId && String(line.text || '').trim()) counts.set(line.speakerId, (counts.get(line.speakerId) || 0) + 1);
  }
  return counts;
}

export function voiceReadiness(config, state) {
  const engine = config.provider || 'demo';
  const characters = new Map((state?.characters || []).map((character) => [character.id, character]));
  const missingRoles = [];
  for (const [roleId, lineCount] of speakingRoles(state)) {
    const character = characters.get(roleId);
    const bound = engine === 'breeze' ? Boolean(state?.voiceReferences?.[roleId]?.breezeVoiceId) : Boolean(state?.voiceMap?.[roleId]);
    if (bound) continue;
    const designDescription = engine === 'breeze' ? voiceDesignDescription(character) : '';
    missingRoles.push({ roleId, name: character?.name || roleId, lineCount, hasVoiceDescription: Boolean(designDescription), voiceDescription: designDescription });
  }
  return { engine, ready: missingRoles.length === 0, requirement: engine === 'breeze' ? 'locked-reference' : 'voice-map', missingRoles };
}

// 一键成片用的“可生成音色表”：Breeze 下只认锁定的参考音（voiceMap 里可能残留豆包 /
// 演示音色 id，发给 Breeze 必然 400，整批失败）；其他引擎就是 voiceMap。
export function generationVoiceMap(config, state) {
  if (config.provider !== 'breeze') return { ...(state?.voiceMap || {}) };
  return Object.fromEntries(Object.entries(state?.voiceReferences || {}).filter(([, reference]) => reference?.breezeVoiceId).map(([roleId, reference]) => [roleId, reference.breezeVoiceId]));
}

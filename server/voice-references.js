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

export const REFERENCE_MIN_SECONDS = 10;
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
    try {
      await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-map', '0:a:0', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', output]);
    } catch {
      throw new ReferenceError('参考音频转码失败（ffmpeg 无法转成单声道 wav）', { code: 'REFERENCE_UNREADABLE', rule: 'decodable' });
    }
    return { wav: await readFile(output), durationMs: Math.round(seconds * 1000) };
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

export async function ensureReferenceRegistered(config, reference) {
  const key = `${config.breezeEndpoint}|${reference.breezeVoiceId}`;
  if (registered.has(key)) return;
  const voices = await listBreezeVoices(config);
  if (voices.some((voice) => (typeof voice === 'string' ? voice : voice?.id) === reference.breezeVoiceId)) { registered.add(key); return; }
  try { await access(referenceFilePath(reference.audioHash)); } catch {
    throw new ReferenceError(`角色参考音频文件丢失（${reference.audioUrl}），请重新锁定参考音`, { status: 409, code: 'REFERENCE_FILE_MISSING' });
  }
  await registerReference(config, reference);
}

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

// 影响范围（只读）：该角色已有音频的对白里，按当前参考 + 当前引擎配置重新算出的
// 缓存键 ≠ 台词上存的 audioHash 的，就是“需要重新生成”的句子。
// 注意：这里不加发音词典替换——与 runGenerationRequests 一致需要同样的替换。
export function referenceImpact(config, project, roleId, { applyPronunciation = (text) => text } = {}) {
  const state = project.state;
  const voiceMap = effectiveVoiceMap(config, state);
  const lineIds = [];
  for (const scene of state.scenes || []) {
    for (const line of scene.lines || []) {
      if (line.type !== 'dialogue' || line.speakerId !== roleId || !line.audioUrl) continue;
      const request = resolveReferenceRequest(config, state, buildGenerationRequest(line, voiceMap));
      const expected = audioContentHash(config, { ...request, text: applyPronunciation(request.text) });
      if (line.audioHash !== expected) lineIds.push(line.id);
    }
  }
  return { affectedLineCount: lineIds.length, lineIds };
}

export function isReferenceError(error) {
  return error instanceof ReferenceError || error instanceof BreezeError;
}

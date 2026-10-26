import { BREEZE_INSTRUCTION_VERSION, TTS_INSTRUCTION_VERSION } from './model-adapters.js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runtimePaths } from './media-store.js';
import { sanitizeCharacters } from './character-meta.js';

const DATABASE_PATH = path.join(path.dirname(runtimePaths.MEDIA_DIR), 'shengchang.sqlite');
mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });

export const database = new DatabaseSync(DATABASE_PATH);
database.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    genre TEXT NOT NULL DEFAULT '',
    source_filename TEXT NOT NULL DEFAULT '',
    source_text TEXT NOT NULL DEFAULT '',
    state_json TEXT NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    project_id TEXT,
    scene_id TEXT,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT '',
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status_created ON tasks(status, created_at);
  CREATE TABLE IF NOT EXISTS audio_cache (
    content_hash TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    mime TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    voice_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
// 0005：created_at 只表示“这条缓存何时生成”；命中时只更新 last_used_at（LRU 用）。
if (!database.prepare('PRAGMA table_info(audio_cache)').all().some((column) => column.name === 'last_used_at')) {
  database.exec('ALTER TABLE audio_cache ADD COLUMN last_used_at INTEGER');
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function projectRow(row) {
  if (!row) return null;
  const state = parseJson(row.state_json, { scenes: [], assets: [], characters: [] });
  if (!Array.isArray(state.characters) || state.characters.length === 0) {
    const derived = new Map();
    for (const scene of state.scenes || []) for (const line of scene.lines || []) {
      if (line.type !== 'dialogue' || !line.speakerId) continue;
      derived.set(line.speakerId, { id: line.speakerId, name: line.speaker || line.speakerId, role: line.speakerId === 'narrator' ? '叙事者' : '角色', description: line.speakerId === 'narrator' ? '保持叙述口吻稳定，避免改变基础发声特征。' : '声音设定待完善。' });
    }
    state.characters = [...derived.values()];
  }
  state.assets ||= [];
  state.voiceMap ||= {};
  state.pronunciationDictionary ||= [];
  state.voiceReferences ||= {};
  state.lineTakes ||= {};
  return { id: row.id, name: row.name, genre: row.genre, sourceFilename: row.source_filename, sourceText: row.source_text, state, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function listProjects() {
  return database.prepare('SELECT id,name,genre,state_json,source_filename,created_at,updated_at FROM projects WHERE archived=0 ORDER BY updated_at DESC').all().map((row) => {
    const project = projectRow(row);
    return { ...project, state: undefined, sceneCount: project.state.scenes?.length || 0 };
  });
}

// Counts every row including archived ones — the sample seeder treats ANY
// row as "this install is not fresh".
export function countProjects() {
  return database.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
}

export function getProject(id) {
  return projectRow(database.prepare('SELECT * FROM projects WHERE id=?').get(id));
}

export function createProject({ name = '未命名作品', genre = '', state = { scenes: [], assets: [], characters: [] }, sourceFilename = '', sourceText = '' }) {
  const id = randomUUID();
  const now = Date.now();
  database.prepare('INSERT INTO projects(id,name,genre,source_filename,source_text,state_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, name.trim() || '未命名作品', genre, sourceFilename, sourceText, JSON.stringify(Array.isArray(state?.characters) ? { ...state, characters: sanitizeCharacters(state.characters, [], { trusted: true }) } : state), now, now);
  return getProject(id);
}

// Audio fields belong to the task layer, not the browser. The editor holds a
// whole-project snapshot and autosaves it back, so a generation finishing
// between load and save would otherwise be erased by a stale snapshot. Keep
// whatever the server already has, and mark a clip stale (instead of deleting
// it) when the text it was synthesized from has changed.
const AUDIO_FIELDS = ['audioUrl', 'audioMime', 'audioHash', 'generatedAt', 'synthesizedText', 'audioEngine', 'audioSeed', 'audioText', 'renderSeed'];

function mergeServerOwnedAudio(incomingState, currentState) {
  const currentLines = new Map();
  for (const scene of currentState.scenes || []) for (const line of scene.lines || []) currentLines.set(line.id, line);
  return {
    ...incomingState,
    scenes: (incomingState.scenes || []).map((scene) => ({
      ...scene,
      lines: (scene.lines || []).map((line) => {
        const current = currentLines.get(line.id);
        // stale / staleReason 是响应里算出来的，不落盘。
        const { stale: _stale, staleReason: _staleReason, ...clean } = line;
        if (!current?.audioUrl) return clean;
        const merged = { ...clean };
        for (const field of AUDIO_FIELDS) if (current[field] !== undefined) merged[field] = current[field];
        // 对照音频生成时的原文（audioText）：改回原文就不再过期。旧数据没有 audioText 时，
        // 未过期的音频以当前文本为原文；已过期的不知道原文，保持过期直到重新生成。
        const sourceText = current.audioText ?? (current.audioStale ? null : current.text);
        merged.audioStale = sourceText === null ? true : String(line.text ?? '') !== String(sourceText ?? '');
        return merged;
      }),
    })),
  };
}

export function updateProject(id, patch) {
  const current = database.prepare('SELECT * FROM projects WHERE id=?').get(id);
  if (!current) throw new Error('项目不存在');
  const currentState = parseJson(current.state_json, {});
  let state = patch.state ?? currentState;
  if (patch.state && !patch.trustedAudio) state = mergeServerOwnedAudio(patch.state, currentState);
  // 角色参考音（voiceReferences）只由服务端锁定接口写入；浏览器保存的旧快照不能覆盖。
  // 单句试听（lineTakes）同理，只由服务端生成/采用接口写入。
  if (patch.state && !patch.trustedAudio) state = { ...state, voiceReferences: currentState.voiceReferences || {}, lineTakes: currentState.lineTakes || {} };
  // 角色性别/年龄：校验枚举；浏览器保存时来源由服务端推断（见 character-meta.js）。
  if (patch.state && Array.isArray(state.characters)) state = { ...state, characters: sanitizeCharacters(state.characters, currentState.characters, { trusted: Boolean(patch.trustedAudio) }) };
  database.prepare('UPDATE projects SET name=?,genre=?,source_filename=?,source_text=?,state_json=?,updated_at=? WHERE id=?').run(
    patch.name ?? current.name,
    patch.genre ?? current.genre,
    patch.sourceFilename ?? current.source_filename,
    patch.sourceText ?? current.source_text,
    JSON.stringify(state),
    Date.now(), id,
  );
  return getProject(id);
}

export function archiveProject(id) {
  const result = database.prepare('UPDATE projects SET archived=1,updated_at=? WHERE id=?').run(Date.now(), id);
  if (!result.changes) throw new Error('项目不存在');
}

export function createPersistentTask({ kind, projectId, sceneId = '', payload }) {
  const id = randomUUID();
  database.prepare('INSERT INTO tasks(id,kind,project_id,scene_id,status,progress,message,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, kind, projectId || null, sceneId, 'queued', 0, '任务已进入本地队列', JSON.stringify(payload), Date.now());
  return getPersistentTask(id);
}

export function getPersistentTask(id) {
  const row = database.prepare('SELECT * FROM tasks WHERE id=?').get(id);
  if (!row) return null;
  return { id: row.id, kind: row.kind, projectId: row.project_id, sceneId: row.scene_id, status: row.status, progress: row.progress, message: row.message, payload: parseJson(row.payload_json, {}), result: parseJson(row.result_json, {}), error: row.error, cancelRequested: Boolean(row.cancel_requested), createdAt: row.created_at, startedAt: row.started_at, completedAt: row.completed_at };
}

export function listPersistentTasks(projectId, limit = 30) {
  return database.prepare('SELECT id FROM tasks WHERE project_id=? ORDER BY created_at DESC LIMIT ?').all(projectId, Math.min(100, Math.max(1, Number(limit) || 30))).map((row) => {
    const { payload: _payload, ...summary } = getPersistentTask(row.id);
    return summary;
  });
}

export function updatePersistentTask(id, patch) {
  const task = getPersistentTask(id);
  if (!task) throw new Error('任务不存在');
  // payload merges shallowly (design T2): the one-click orchestrator persists
  // completedStages checkpoints here - the one home that survives both crash
  // recovery and retryTask (which copies only payload).
  const payload = patch.payload ? { ...task.payload, ...patch.payload } : task.payload;
  database.prepare('UPDATE tasks SET status=?,progress=?,message=?,payload_json=?,result_json=?,error=?,cancel_requested=?,started_at=?,completed_at=? WHERE id=?').run(
    patch.status ?? task.status, patch.progress ?? task.progress, patch.message ?? task.message,
    JSON.stringify(payload), JSON.stringify(patch.result ?? task.result), patch.error ?? task.error,
    patch.cancelRequested === undefined ? Number(task.cancelRequested) : Number(patch.cancelRequested),
    patch.startedAt ?? task.startedAt, patch.completedAt ?? task.completedAt, id,
  );
  return getPersistentTask(id);
}

// kinds：只在这些 kind 里挑（交互槽用）；不传 = 任意 kind。同一条件下按创建时间先来先领。
export function nextQueuedTask({ kinds } = {}) {
  const list = Array.isArray(kinds) && kinds.length ? kinds : null;
  const row = list
    ? database.prepare(`SELECT id FROM tasks WHERE status='queued' AND kind IN (${list.map(() => '?').join(',')}) ORDER BY created_at ASC LIMIT 1`).get(...list)
    : database.prepare("SELECT id FROM tasks WHERE status='queued' ORDER BY created_at ASC LIMIT 1").get();
  return row ? getPersistentTask(row.id) : null;
}

export function recoverInterruptedTasks() {
  database.prepare("UPDATE tasks SET status='queued',message='本地服务重启，任务等待恢复',started_at=NULL WHERE status='running'").run();
}

export function requestTaskCancellation(id) {
  const task = getPersistentTask(id);
  if (!task) throw new Error('任务不存在');
  if (task.status === 'queued') return updatePersistentTask(id, { status: 'cancelled', message: '任务已取消', completedAt: Date.now(), cancelRequested: true });
  return updatePersistentTask(id, { cancelRequested: true, message: '正在停止任务' });
}

export function findCachedAudio(contentHash) {
  return database.prepare('SELECT * FROM audio_cache WHERE content_hash=?').get(contentHash) || null;
}

export function cacheAudio({ contentHash, url, mime, provider, model, voiceId }) {
  database.prepare('INSERT OR REPLACE INTO audio_cache(content_hash,url,mime,provider,model,voice_id,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(contentHash, url, mime, provider, model, voiceId, Date.now());
}

// 命中缓存：只记录使用时间，不改 created_at（否则看起来像这次新生成的）。
export function touchCachedAudio(contentHash) {
  database.prepare('UPDATE audio_cache SET last_used_at=? WHERE content_hash=?').run(Date.now(), contentHash);
}

export function listAudioCache() {
  return database.prepare('SELECT * FROM audio_cache ORDER BY COALESCE(last_used_at, created_at) ASC').all();
}

export function deleteAudioCache(contentHash) {
  database.prepare('DELETE FROM audio_cache WHERE content_hash=?').run(contentHash);
}

// Every field that can change the synthesized audio must participate here;
// missing fields cause stale cache hits, extra fields cause paid re-synthesis.
// 生成逻辑进缓存键：豆包 seed-tts-2.0 的实际指令由 TTS_INSTRUCTION_VERSION 版本的
// 拼装规则 + 稳定说话人开关决定，任一变化都必须重新合成，不能复用旧音频。
// 其他提供方不发指令，键保持原样（它们的缓存不受影响）。
function ttsGeneratorKey(config) {
  // Breeze /tts 的指令由 breezeInstruction 生成（声场为准），它的版本进键：措辞一改旧缓存
  // 要失效。instructionVersion 固定写 2（当年的豆包版本号）只为不挪动现有 Breeze 缓存键；
  // 以后豆包升 TTS_INSTRUCTION_VERSION（例如清理停顿措辞）不再连带让 Breeze 缓存失效。
  if (config.provider === 'breeze') return { instructionVersion: 2, breezeInstructionVersion: BREEZE_INSTRUCTION_VERSION };
  if (config.provider !== 'volcengine-api-key' || config.resourceId !== 'seed-tts-2.0') return {};
  return { instructionVersion: TTS_INSTRUCTION_VERSION, stableSpeaker: config.ttsStableSpeaker !== false };
}

export function audioContentHash(config, request) {
  return createHash('sha256').update(JSON.stringify({ ...ttsGeneratorKey(config), provider: config.provider, endpoint: config.provider === 'breeze' ? config.breezeEndpoint : config.endpoint, model: config.model, resourceId: config.resourceId, voiceId: request.voiceId, text: request.text, subtext: request.subtext, emotion: request.emotion, emotionScale: request.emotionScale, speed: request.speed, distance: request.distance, format: config.audioFormat, sampleRate: config.sampleRate,
    // 只在出现时才加入：既有台词（无参考音、无显式 seed）的缓存键保持不变。
    // referenceHash = 角色参考音指纹（Breeze 参考音角色）；seed = 显式指定的生成种子。
    ...(request.referenceHash ? { referenceHash: request.referenceHash } : {}),
    ...(Number.isSafeInteger(request.seed) ? { seed: request.seed } : {}),
    // 强度恰好 0 = 不要情绪：只改 Breeze 指令，所以只进 Breeze 的键；豆包 / 自定义的键与 0036 逐字相同。
    ...(config.provider === 'breeze' && request.emotionOff === true ? { emotionOff: true } : {}) })).digest('hex');
}

// Generated sound effects / beds: same content-addressed cache, different key
// inputs (prompt instead of text + direction params).
export function soundContentHash(config, sound) {
  return createHash('sha256').update(JSON.stringify({ provider: config.sfxProvider, endpoint: config.sfxEndpoint, model: config.sfxModel, prompt: sound.prompt, durationMs: sound.durationMs || 0, type: sound.type })).digest('hex');
}

// Imports a pre-sqlite project-state.json once. A genuinely fresh install
// creates nothing here — the sample seeder (sample-project.js, called from
// index.js) owns the first-run experience.
export function migrateLegacyProject() {
  if (countProjects()) return;
  const legacyPath = path.join(path.dirname(runtimePaths.MEDIA_DIR), 'project-state.json');
  let state = null;
  try { state = JSON.parse(readFileSync(legacyPath, 'utf8')); } catch { /* No legacy file: fresh install, nothing to do. */ }
  if (state) createProject({ name: state.scenes?.length ? '雾港来信' : '我的第一部广播剧', genre: state.scenes?.length ? '悬疑' : '', state });
}

recoverInterruptedTasks();
migrateLegacyProject();

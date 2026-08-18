import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { runtimePaths } from './media-store.js';

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
  return { id: row.id, name: row.name, genre: row.genre, sourceFilename: row.source_filename, sourceText: row.source_text, state, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function listProjects() {
  return database.prepare('SELECT id,name,genre,state_json,source_filename,created_at,updated_at FROM projects WHERE archived=0 ORDER BY updated_at DESC').all().map((row) => {
    const project = projectRow(row);
    return { ...project, state: undefined, sceneCount: project.state.scenes?.length || 0 };
  });
}

export function getProject(id) {
  return projectRow(database.prepare('SELECT * FROM projects WHERE id=?').get(id));
}

export function createProject({ name = '未命名作品', genre = '', state = { scenes: [], assets: [], characters: [] }, sourceFilename = '', sourceText = '' }) {
  const id = randomUUID();
  const now = Date.now();
  database.prepare('INSERT INTO projects(id,name,genre,source_filename,source_text,state_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, name.trim() || '未命名作品', genre, sourceFilename, sourceText, JSON.stringify(state), now, now);
  return getProject(id);
}

// Audio fields belong to the task layer, not the browser. The editor holds a
// whole-project snapshot and autosaves it back, so a generation finishing
// between load and save would otherwise be erased by a stale snapshot. Keep
// whatever the server already has, and mark a clip stale (instead of deleting
// it) when the text it was synthesized from has changed.
const AUDIO_FIELDS = ['audioUrl', 'audioMime', 'audioHash', 'generatedAt', 'synthesizedText'];

function mergeServerOwnedAudio(incomingState, currentState) {
  const currentLines = new Map();
  for (const scene of currentState.scenes || []) for (const line of scene.lines || []) currentLines.set(line.id, line);
  return {
    ...incomingState,
    scenes: (incomingState.scenes || []).map((scene) => ({
      ...scene,
      lines: (scene.lines || []).map((line) => {
        const current = currentLines.get(line.id);
        if (!current?.audioUrl) return line;
        const merged = { ...line };
        for (const field of AUDIO_FIELDS) if (current[field] !== undefined) merged[field] = current[field];
        merged.audioStale = String(line.text ?? '') !== String(current.text ?? '');
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
    .run(id, kind, projectId || null, sceneId, 'queued', 1, '任务已进入本地队列', JSON.stringify(payload), Date.now());
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
  database.prepare('UPDATE tasks SET status=?,progress=?,message=?,result_json=?,error=?,cancel_requested=?,started_at=?,completed_at=? WHERE id=?').run(
    patch.status ?? task.status, patch.progress ?? task.progress, patch.message ?? task.message,
    JSON.stringify(patch.result ?? task.result), patch.error ?? task.error,
    patch.cancelRequested === undefined ? Number(task.cancelRequested) : Number(patch.cancelRequested),
    patch.startedAt ?? task.startedAt, patch.completedAt ?? task.completedAt, id,
  );
  return getPersistentTask(id);
}

export function nextQueuedTask() {
  const row = database.prepare("SELECT id FROM tasks WHERE status='queued' ORDER BY created_at ASC LIMIT 1").get();
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

export function listAudioCache() {
  return database.prepare('SELECT * FROM audio_cache ORDER BY created_at ASC').all();
}

export function deleteAudioCache(contentHash) {
  database.prepare('DELETE FROM audio_cache WHERE content_hash=?').run(contentHash);
}

// Every field that can change the synthesized audio must participate here;
// missing fields cause stale cache hits, extra fields cause paid re-synthesis.
export function audioContentHash(config, request) {
  return createHash('sha256').update(JSON.stringify({ provider: config.provider, endpoint: config.endpoint, model: config.model, resourceId: config.resourceId, voiceId: request.voiceId, text: request.text, subtext: request.subtext, emotion: request.emotion, emotionScale: request.emotionScale, speed: request.speed, distance: request.distance, format: config.audioFormat, sampleRate: config.sampleRate })).digest('hex');
}

export function migrateLegacyProject() {
  const count = database.prepare('SELECT COUNT(*) AS count FROM projects').get().count;
  if (count) return;
  const legacyPath = path.join(path.dirname(runtimePaths.MEDIA_DIR), 'project-state.json');
  let state = { scenes: [], assets: [], characters: [] };
  try { state = JSON.parse(readFileSync(legacyPath, 'utf8')); } catch { /* First run. */ }
  createProject({ name: state.scenes?.length ? '雾港来信' : '我的第一部广播剧', genre: state.scenes?.length ? '悬疑' : '', state });
}

recoverInterruptedTasks();
migrateLegacyProject();

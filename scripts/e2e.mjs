// E2E smoke test against a scratch server. Spawns server/index.js with a
// sandboxed HOME and runtime dir, so the real ~/.shengchang credentials and the
// repo's .runtime/ data are never touched. Usage: npm run test:e2e
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 4198;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchHome = mkdtempSync(path.join(tmpdir(), 'shengchang-e2e-home-'));
const scratchRuntime = mkdtempSync(path.join(tmpdir(), 'shengchang-e2e-runtime-'));

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, HOME: scratchHome, SHENGCHANG_RUNTIME_DIR: scratchRuntime, SHENGCHANG_API_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (chunk) => { serverLog += chunk; });
server.stderr.on('data', (chunk) => { serverLog += chunk; });

const cleanup = () => {
  server.kill('SIGKILL');
  rmSync(scratchHome, { recursive: true, force: true });
  rmSync(scratchRuntime, { recursive: true, force: true });
};
process.on('exit', cleanup);

const call = async (route, options = {}) => {
  const response = await fetch(`${BASE}${route}`, { ...options, headers: options.body ? { 'Content-Type': 'application/json' } : undefined });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, payload };
};
const check = (name, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!condition) process.exitCode = 1;
};
const waitForTask = async (id) => {
  let task = (await call(`/api/tasks/${id}`)).payload;
  for (let i = 0; i < 40 && !['completed', 'failed', 'cancelled'].includes(task.status); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    task = (await call(`/api/tasks/${id}`)).payload;
  }
  return task;
};

// 0. wait for the scratch server to boot
let up = false;
for (let i = 0; i < 60 && !up; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  up = await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false);
}
if (!up) {
  console.error(`scratch server failed to boot:\n${serverLog}`);
  process.exit(1);
}

// 1. health with real ffmpeg probe
const health = await call('/api/health');
check('health ok + real ffmpeg probe', health.payload.ok === true && health.payload.ffmpeg === true, JSON.stringify(health.payload));

// 2. unknown API route returns JSON 404, not the SPA shell
const nope = await call('/api/definitely-not-a-route');
check('unknown /api route is 404 JSON', nope.status === 404 && typeof nope.payload.error === 'string');

// 3. switch to demo provider (writes scratch HOME config only)
const saved = await call('/api/config', { method: 'PUT', body: JSON.stringify({ provider: 'demo' }) });
check('config saved with demo provider', saved.status === 200 && saved.payload.provider === 'demo');

// 4. create project with one dialogue line + voice mapping
const created = await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'E2E 验证' }) });
const projectId = created.payload.id;
const state = {
  scenes: [{ id: 'scene-1', number: '01', title: '验证场景', status: 'pending', lines: [
    { id: 'line-1', type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text: '第一句验证台词', subtext: '试探对方', emotion: '克制', intensity: 40, pace: 90, distance: '近讲' },
  ] }],
  assets: [], characters: [{ id: 'narrator', name: '旁白', role: '叙事者', description: '' }],
  voiceMap: { narrator: 'demo_voice' }, pronunciationDictionary: [],
};
await call(`/api/projects/${projectId}`, { method: 'PUT', body: JSON.stringify({ state }) });

// 5. generate, then poll the persistent task
const gen = await call('/api/generate', { method: 'POST', body: JSON.stringify({ projectId, sceneId: 'scene-1', kind: 'scene', requests: [{ lineId: 'line-1', speakerId: 'narrator', voiceId: 'demo_voice', text: '第一句验证台词', subtext: '试探对方', emotion: '克制', emotionScale: 0.4, speed: 0.9, distance: '近讲' }] }) });
check('generation task accepted', gen.status === 202 && Boolean(gen.payload.id), gen.payload.error || '');
let task = await waitForTask(gen.payload.id);
check('generation completed', task.status === 'completed', task.error || task.message);

// 6. line now has audio and is NOT stale
let project = (await call(`/api/projects/${projectId}`)).payload;
let line = project.state.scenes[0].lines[0];
check('audio written to line', Boolean(line.audioUrl), line.audioUrl || '');
check('fresh audio not marked stale', line.audioStale === false, `audioStale=${line.audioStale}`);
check('synthesizedText recorded', line.synthesizedText === '第一句验证台词');

// 7. audio file is served
const audio = await fetch(`${BASE}${line.audioUrl}`);
check('generated audio served over /media', audio.status === 200 && Number(audio.headers.get('content-length')) > 100, `HTTP ${audio.status}`);

// 8. browser edit marks it stale (the pre-existing merge path)
const edited = { ...project.state, scenes: project.state.scenes.map((scene) => ({ ...scene, lines: scene.lines.map((l) => ({ ...l, text: '改过的台词' })) })) };
await call(`/api/projects/${projectId}`, { method: 'PUT', body: JSON.stringify({ state: edited }) });
project = (await call(`/api/projects/${projectId}`)).payload;
check('edit marks audio stale', project.state.scenes[0].lines[0].audioStale === true);

// 9. regenerate → the headline bug fix: badge must clear
const regen = await call('/api/generate', { method: 'POST', body: JSON.stringify({ projectId, sceneId: 'scene-1', kind: 'line', requests: [{ lineId: 'line-1', speakerId: 'narrator', voiceId: 'demo_voice', text: '改过的台词', subtext: '试探对方', emotion: '克制', emotionScale: 0.4, speed: 0.9, distance: '近讲' }] }) });
task = await waitForTask(regen.payload.id);
project = (await call(`/api/projects/${projectId}`)).payload;
line = project.state.scenes[0].lines[0];
check('regeneration clears stale badge (bug #1)', task.status === 'completed' && line.audioStale === false, `status=${task.status} audioStale=${line.audioStale}`);

// 10. second identical request must be a cache hit (LRU path exercised)
const again = await call('/api/generate', { method: 'POST', body: JSON.stringify({ projectId, sceneId: 'scene-1', kind: 'line', requests: [{ lineId: 'line-1', speakerId: 'narrator', voiceId: 'demo_voice', text: '改过的台词', subtext: '试探对方', emotion: '克制', emotionScale: 0.4, speed: 0.9, distance: '近讲' }] }) });
task = await waitForTask(again.payload.id);
check('identical request served from cache', task.status === 'completed' && task.result?.cacheHits === 1, `cacheHits=${task.result?.cacheHits}`);

console.log(process.exitCode ? 'E2E FAILED' : 'E2E GREEN');
// The spawned server would keep the event loop alive forever; tear down
// explicitly instead of relying on the exit handler.
cleanup();
process.exit(process.exitCode ?? 0);

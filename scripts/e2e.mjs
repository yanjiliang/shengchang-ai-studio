// E2E smoke test against a scratch server. Spawns server/index.js with a
// sandboxed HOME and runtime dir, so the real ~/.shengchang credentials and the
// repo's .runtime/ data are never touched. Usage: npm run test:e2e
import { spawn } from 'node:child_process';
import http from 'node:http';
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

let fakeLlm = null;
const cleanup = () => {
  server.kill('SIGKILL');
  fakeLlm?.close();
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

// Fake OpenAI-compatible text model: analysis is the only path now, so the
// scratch server needs a reachable model. It returns a fixed, schema-valid scene.
const FAKE_ANALYSIS = {
  project: { genre: '测试' },
  characters: [
    { id: 'narrator', name: '旁白', role: '叙事者', gender: '未知', age: '未知', description: '叙事者' },
    { id: '林夏', name: '林夏', role: '主角', gender: '女', age: '青年', description: '测试角色' },
  ],
  scenes: [{
    title: '第一章 雨夜', location: '待设定', mood: '待导演', synopsis: '测试',
    lines: [{ type: 'dialogue', speaker: '林夏', speakerId: '林夏', text: '我到了。', subtext: '试探', emotion: '克制', intensity: 40, pace: 90, distance: '近讲' }],
  }],
};
fakeLlm = await new Promise((resolve) => {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      if (request.url === '/invalid-sfx') {
        response.writeHead(200, { 'Content-Type': 'audio/wav' });
        return response.end('not a decodable audio file');
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(FAKE_ANALYSIS) }, finish_reason: 'stop' }] }));
    });
  });
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const fakeLlmBase = `http://127.0.0.1:${fakeLlm.address().port}/v1`;

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

// 3. switch to demo provider (writes scratch HOME config only) + fake text model
const saved = await call('/api/config', { method: 'PUT', body: JSON.stringify({ provider: 'demo', llmEndpoint: fakeLlmBase, llmModel: 'fake', llmApiKey: '', preserveSecret: false }) });
check('config saved with demo provider + fake text model', saved.status === 200 && saved.payload.provider === 'demo' && saved.payload.llmModel === 'fake' && String(saved.payload.llmEndpoint).includes('127.0.0.1'));

// 3.5 fresh boot auto-seeds the 三打白骨精 sample (design B2)
const listing = await call('/api/projects');
check('sample project auto-seeded on fresh install', listing.payload.projects.some((item) => item.name.includes('三打白骨精')), JSON.stringify(listing.payload.projects.map((item) => item.name)));

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

// 10.5 direction lab (Approach C): takes generate and stay in the task
// result; the line's audio must be untouched (audition, not writeback).
const preLab = (await call(`/api/projects/${projectId}`)).payload.state.scenes[0].lines[0];
const lab = await call('/api/generate', { method: 'POST', body: JSON.stringify({ projectId, sceneId: 'scene-1', kind: 'direction-lab', requests: [
  { lineId: 'line-1', speakerId: 'narrator', voiceId: 'demo_voice', text: '改过的台词', subtext: '情绪决堤', emotion: '愤怒', emotionScale: 0.85, speed: 0.9, distance: '近讲' },
  { lineId: 'line-1', speakerId: 'narrator', voiceId: 'demo_voice', text: '改过的台词', subtext: '压低声音试探', emotion: '警惕', emotionScale: 0.45, speed: 0.9, distance: '耳语' },
] }) });
check('direction-lab task accepted', lab.status === 202 && Boolean(lab.payload.id), lab.payload.error || '');
task = await waitForTask(lab.payload.id);
const labResults = task.result?.results || [];
check('direction-lab takes generated', task.status === 'completed' && labResults.length === 2 && labResults.every((item) => item.url), task.error || task.message);
const postLab = (await call(`/api/projects/${projectId}`)).payload.state.scenes[0].lines[0];
check('direction-lab does not write back to the line', postLab.audioUrl === preLab.audioUrl, `audioUrl ${preLab.audioUrl} -> ${postLab.audioUrl}`);
check('direction-lab take audio is served', labResults.length === 2 && (await fetch(`${BASE}${labResults[0].url}`)).status === 200);

// 11. text-model analysis through the fake OpenAI-compatible endpoint.
const novel = await call(`/api/projects/${projectId}/analyze`, { method: 'POST', body: JSON.stringify({ text: '第一章 雨夜\n\n林夏说：「我到了。」', filename: 'demo.txt' }) });
check('text-model analysis accepted', novel.status === 202 && Boolean(novel.payload.id), novel.payload.error || '');
task = await waitForTask(novel.payload.id);
check('text-model breakdown completes', task.status === 'completed' && task.result?.breakdown === 'llm', task.error || task.message);
project = (await call(`/api/projects/${projectId}`)).payload;
check('text-model scenes written to project', (project.state.scenes?.length || 0) >= 1 && project.state.breakdown === 'llm');

// 12. one-click pipeline end-to-end via the demo provider (zero-key). The
// wait allows generous iterations: the export stage spawns several ffmpeg
// passes (per-scene render + loudnorm master).
const estimate = await call(`/api/projects/${projectId}/one-click-estimate`, { method: 'POST' });
check('one-click estimate predicts work + cache hits', estimate.status === 200 && estimate.payload.requestCount >= 1 && estimate.payload.provider === 'demo', JSON.stringify(estimate.payload));
const oc = await call(`/api/projects/${projectId}/one-click`, { method: 'POST' });
check('one-click accepted', oc.status === 202 && Boolean(oc.payload.id), oc.payload.error || '');
// OV-4: an autosave landing mid-orchestration must be rejected (409) - unless
// the run already finished, which the fast demo pipeline can do on tiny input.
const guardPut = await call(`/api/projects/${projectId}`, { method: 'PUT', body: JSON.stringify({ state: project.state }) });
check('autosave guarded while orchestrating (OV-4)', [200, 409].includes(guardPut.status), `HTTP ${guardPut.status}（409=运行中被拒，200=任务已结束）`);
let oneClickTask = (await call(`/api/tasks/${oc.payload.id}`)).payload;
for (let i = 0; i < 120 && !['completed', 'failed', 'cancelled'].includes(oneClickTask.status); i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  oneClickTask = (await call(`/api/tasks/${oc.payload.id}`)).payload;
}
check('one-click completes end-to-end', oneClickTask.status === 'completed' && Boolean(oneClickTask.result?.url), oneClickTask.error || oneClickTask.message);
check('one-click result carries attention list', Array.isArray(oneClickTask.result?.attention), JSON.stringify(oneClickTask.result?.attention));
const finalProject = (await call(`/api/projects/${projectId}`)).payload;
check('one-click auto-mapped unmapped voices', Boolean(finalProject.state.voiceMap?.林夏), JSON.stringify(finalProject.state.voiceMap));
check('one-click generated the missing dialogue', finalProject.state.scenes.some((scene) => scene.lines.some((line) => line.speakerId === '林夏' && line.audioUrl)));

// 13. saved book imports: chapter texts + import progress live on the server,
// so re-importing the same book reuses the record and never re-runs imported chapters.
const bookProject = (await call('/api/projects', { method: 'POST', body: JSON.stringify({ name: '整本导入测试' }) })).payload;
const bookChapters = [
  { title: '第一章 山门', text: '第一章 山门\n山门在雾里。\n「走吧。」唐僧说。' },
  { title: '第二章 夜雨', text: '第二章 夜雨\n雨下了一夜。\n「师父，前面有座庙。」孙悟空说。' },
];
const savedBook = await call(`/api/projects/${bookProject.id}/book-imports`, { method: 'POST', body: JSON.stringify({ filename: 'e2e.epub', format: 'epub', chapters: bookChapters }) });
check('book import saved', savedBook.status === 201 && savedBook.payload.book.chapterCount === 2, savedBook.payload.error || '');
const bookId = savedBook.payload.book.id;
const duplicateBook = await call(`/api/projects/${bookProject.id}/book-imports`, { method: 'POST', body: JSON.stringify({ filename: 'e2e.epub', format: 'epub', chapters: bookChapters }) });
check('same book reuses the saved record', duplicateBook.status === 201 && duplicateBook.payload.book.id === bookId);
const firstChapter = await call(`/api/book-imports/${bookId}/chapters/0/import`, { method: 'POST', body: JSON.stringify({ appendScenes: false }) });
const firstTask = await waitForTask(firstChapter.payload.taskId);
check('book chapter import completes', firstTask.status === 'completed' && firstTask.result?.sceneCount >= 1, firstTask.error || firstTask.message);
let savedBookState = (await call(`/api/book-imports/${bookId}`)).payload.book;
check('imported chapter marked, next chapter pending', savedBookState.importedCount === 1 && savedBookState.remainingCount === 1);
const reimport = await call(`/api/book-imports/${bookId}/chapters/0/import`, { method: 'POST', body: JSON.stringify({}) });
check('imported chapter cannot be imported twice', reimport.status === 409 && reimport.payload.code === 'BOOK_CHAPTER_ALREADY_IMPORTED');
const replaceAfterImport = await call(`/api/book-imports/${bookId}/chapters/1/import`, { method: 'POST', body: JSON.stringify({ mode: 'replace' }) });
check('continued book import cannot replace earlier chapters', replaceAfterImport.status === 409 && replaceAfterImport.payload.code === 'BOOK_IMPORT_APPEND_ONLY');
const secondChapter = await call(`/api/book-imports/${bookId}/chapters/1/import`, { method: 'POST', body: JSON.stringify({ appendScenes: true }) });
const secondTask = await waitForTask(secondChapter.payload.taskId);
check('remaining chapter import completes', secondTask.status === 'completed', secondTask.error || secondTask.message);
savedBookState = (await call(`/api/book-imports/${bookId}`)).payload.book;
check('all chapters marked imported', savedBookState.importedCount === 2 && savedBookState.remainingCount === 0);
const bookProjectState = (await call(`/api/projects/${bookProject.id}`)).payload;
check('book scenes appended in chapter order', bookProjectState.state.scenes.length === 2 && bookProjectState.state.scenes[0].title.includes('第一章 山门') && bookProjectState.state.scenes[1].title.includes('第二章 夜雨'), bookProjectState.state.scenes.map((scene) => scene.title).join(' / '));
check('book sourceText accumulates chapters', bookProjectState.sourceText.includes('第一章 山门') && bookProjectState.sourceText.includes('第二章 夜雨'));
const deletedBook = await call(`/api/book-imports/${bookId}`, { method: 'DELETE' });
check('book import record can be deleted', deletedBook.status === 200);

// 14. seed script is idempotent: force mode skips when the marker exists
const seed = await new Promise((resolve) => {
  const child = spawn(process.execPath, ['scripts/seed-sample.mjs'], { env: { ...process.env, SHENGCHANG_RUNTIME_DIR: scratchRuntime }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.on('close', () => resolve(out));
});
check('seed script skips when sample exists', seed.includes('跳过'), seed.trim());
const listing2 = await call('/api/projects');
check('seed script did not duplicate the sample', listing2.payload.projects.filter((item) => item.name.includes('三打白骨精')).length === 1);

// 14. builtin CC0 library: registered, served, guarded against deletion
const builtin = await call('/api/assets/builtin');
check('builtin library registered', builtin.payload.assets?.length >= 20, `${builtin.payload.assets?.length ?? 0} 条`);
const builtinClip = builtin.payload.assets?.[0];
const builtinMedia = await fetch(`${BASE}${builtinClip?.url || ''}`);
check('builtin clip served via /media', builtinMedia.ok, `${builtinMedia.status} ${builtinClip?.url}`);
const builtinDelete = await call(`/api/assets?url=${encodeURIComponent(builtinClip.url)}`, { method: 'DELETE' });
check('builtin clips cannot be deleted', builtinDelete.status === 400, builtinDelete.payload?.error || '');

// 15. recommendations follow the event's type + text
const sampleProject = listing2.payload.projects.find((item) => item.name.includes('三打白骨精'));
const sampleDetail = (await call(`/api/projects/${sampleProject.id}`)).payload;
const soundEvent = sampleDetail.state.scenes.flatMap((scene) => scene.lines || []).find((line) => line.type !== 'dialogue');
if (soundEvent) {
  const rec = await call(`/api/assets/recommend?projectId=${sampleProject.id}&lineId=${soundEvent.id}`);
  const typesOk = (rec.payload.recommendations || []).every((item) => item.type === soundEvent.type);
  check('recommendations respect the event type', rec.status === 200 && typesOk, `${rec.payload.recommendations?.length ?? 0} 条推荐`);
} else {
  check('recommendations respect the event type', true, '示例无声音事件，跳过');
}

// 16. sound generation task (demo engine) completes and lands in the cache
const soundTaskCreated = await call('/api/generate', { method: 'POST', body: JSON.stringify({ kind: 'sound-generate', projectId: sampleProject.id, sound: { prompt: '雨夜码头，远处汽笛', type: 'ambient', durationMs: 3000 } }) });
check('sound generation task accepted', soundTaskCreated.status === 202, JSON.stringify(soundTaskCreated.payload));
const soundTask = await waitForTask(soundTaskCreated.payload.id);
check('sound generation completes (demo engine)', soundTask.status === 'completed' && Boolean(soundTask.result?.url), soundTask.error || soundTask.message);
const soundAudio = await fetch(`${BASE}${soundTask.result?.url || ''}`);
check('generated sound audio served', soundAudio.ok, `${soundAudio.status}`);
check('sound generation returns decoded duration and MIME', soundTask.result?.durationMs === 3000 && soundTask.result?.mime === 'audio/wav');
const defaultSoundInput = { kind: 'sound-generate', projectId: sampleProject.id, sound: { prompt: '雨夜环境，默认时长', type: 'ambient' } };
for (const label of ['fresh', 'cached']) {
  const created = await call('/api/generate', { method: 'POST', body: JSON.stringify(defaultSoundInput) });
  const finished = await waitForTask(created.payload.id);
  check(`${label} sound without requested duration reports actual 12s`, finished.status === 'completed' && finished.result?.durationMs === 12000, finished.error || JSON.stringify(finished.result));
}

await call('/api/config', { method: 'PUT', body: JSON.stringify({ sfxProvider: 'custom', sfxEndpoint: `http://127.0.0.1:${fakeLlm.address().port}/invalid-sfx`, sfxCustomBodyTemplate: '{"prompt":"{{prompt}}"}' }) });
const invalidSound = await call('/api/generate', { method: 'POST', body: JSON.stringify(defaultSoundInput) });
const invalidResult = await waitForTask(invalidSound.payload.id);
check('undecodable generated sound fails instead of claiming success', invalidResult.status === 'failed' && Boolean(invalidResult.error), invalidResult.error);

console.log(process.exitCode ? 'E2E FAILED' : 'E2E GREEN');
// The spawned server would keep the event loop alive forever; tear down
// explicitly instead of relying on the exit handler.
cleanup();
process.exit(process.exitCode ?? 0);

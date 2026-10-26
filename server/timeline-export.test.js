import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';

// 导出结果 / 整集时间轴：segments[]（每句起止 ms）和成片响度 lufs。
const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-timeline-test-'));
process.env.HOME = scratch;
process.env.SHENGCHANG_RUNTIME_DIR = path.join(scratch, 'runtime');
const { createProject, getProject, createPersistentTask, updatePersistentTask } = await import('./database.js');
const { ensureRuntime, exportProjectTimeline, exportSceneTimeline, measureLoudness, probeFfmpeg, resolveProjectTimeline, runtimePaths, timelineSegments } = await import('./media-store.js');
const { registerProductionRoutes } = await import('./production-routes.js');
const express = (await import('express')).default;

const hasFfmpeg = await probeFfmpeg();
const needsFfmpeg = { skip: hasFfmpeg ? false : '需要 ffmpeg/ffprobe' };

function writeSineWav(name, seconds, frequency = 220) {
  const sampleRate = 24000;
  const samples = Math.floor(seconds * sampleRate);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.2 * 32767), index * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  writeFileSync(path.join(runtimePaths.MEDIA_DIR, name), Buffer.concat([header, pcm]));
  return `/media/${name}`;
}

const dialogue = (id, url, mix = {}) => ({ id, type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text: id, audioUrl: url, mix });
let server; let base; let project;

before(async () => {
  await ensureRuntime();
  if (!hasFfmpeg) return;
  const a = writeSineWav('t-a.wav', 1.0); const b = writeSineWav('t-b.wav', 2.0, 330); const c = writeSineWav('t-c.wav', 0.5, 440);
  const scenes = [
    { id: 's1', title: '第一场', lines: [dialogue('l1', a, { gapAfterMs: 500 }), dialogue('l2', b)] },
    { id: 's-empty', title: '没音频', lines: [{ id: 'l-x', type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text: 'x' }] },
    { id: 's2', title: '第二场', lines: [dialogue('l3', c, { gapAfterMs: 0 })] },
  ];
  project = createProject({ name: '时间轴', state: { scenes, characters: [], assets: [], voiceMap: {} } });
  const app = express(); app.use(express.json()); registerProductionRoutes(app);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
  rmSync(scratch, { recursive: true, force: true });
});

// s1: l1 0–1000，句后 500 → l2 1500–3500，默认 320 → 场景 3820 + 尾垫 900 = 4720。
// s2 从 4720 开始：l3 4720–5220，0 间隔 → 500 + 900 = 1400，总 6120。
const EXPECTED = [
  { lineId: 'l1', sceneId: 's1', type: 'dialogue', startMs: 0, endMs: 1000 },
  { lineId: 'l2', sceneId: 's1', type: 'dialogue', startMs: 1500, endMs: 3500 },
  { lineId: 'l3', sceneId: 's2', type: 'dialogue', startMs: 4720, endMs: 5220 },
];

test('timelineSegments 按句后停顿顺排并加场景偏移', () => {
  const resolved = { tracks: [{ lineId: 'b', type: 'sfx', start: 0.2, duration: 1 }, { lineId: 'a', type: 'dialogue', start: 0.2, duration: 0.5 }] };
  assert.deepEqual(timelineSegments(resolved, { sceneId: 's', offsetMs: 1000 }), [
    { lineId: 'a', sceneId: 's', type: 'dialogue', startMs: 1200, endMs: 1700 },
    { lineId: 'b', sceneId: 's', type: 'sfx', startMs: 1200, endMs: 2200 },
  ]);
});

test('measureLoudness：没有 ffmpeg 时返回 null 和原因，不抛错', async () => {
  const savedPath = process.env.PATH;
  process.env.PATH = path.join(scratch, 'no-bin');
  try { assert.deepEqual(await measureLoudness(path.join(scratch, 'none.mp3')), { lufs: null, lufsReason: 'FFMPEG_UNAVAILABLE' }); } finally { process.env.PATH = savedPath; }
});

test('measureLoudness：文件坏了返回 LOUDNESS_MEASURE_FAILED', needsFfmpeg, async () => {
  const broken = path.join(scratch, 'broken.mp3'); writeFileSync(broken, 'not audio');
  assert.deepEqual(await measureLoudness(broken), { lufs: null, lufsReason: 'LOUDNESS_MEASURE_FAILED' });
});

test('整集时间轴（不渲染）：segments / scenes 与导出布局一致，跳过没音频的场景', needsFfmpeg, async () => {
  const timeline = await resolveProjectTimeline(getProject(project.id));
  assert.deepEqual(timeline.segments, EXPECTED);
  assert.deepEqual(timeline.scenes.map(({ sceneId, startMs, endMs }) => ({ sceneId, startMs, endMs })), [{ sceneId: 's1', startMs: 0, endMs: 4720 }, { sceneId: 's2', startMs: 4720, endMs: 6120 }]);
  assert.equal(timeline.durationMs, 6120);
  assert.deepEqual(timeline.skippedScenes, [{ sceneId: 's-empty', reason: 'NO_DIALOGUE_AUDIO' }]);
});

test('整集导出结果带 segments 和测得的 lufs（接近目标 -16）', needsFfmpeg, async () => {
  const result = await exportProjectTimeline({ project: getProject(project.id), targetLufs: -16 });
  assert.deepEqual(result.segments, EXPECTED);
  assert.equal(result.durationMs, 6120);
  assert.equal(result.targetLufs, -16);
  assert.equal(result.lufsReason, null);
  assert.equal(typeof result.lufs, 'number');
  assert.ok(Math.abs(result.lufs - -16) < 2, `成片响度应接近 -16 LUFS: ${result.lufs}`);
});

test('单场景导出结果带本场 segments 和 lufs', needsFfmpeg, async () => {
  const scene = getProject(project.id).state.scenes[0];
  const result = await exportSceneTimeline({ projectId: project.id, scene, targetLufs: -18 });
  assert.deepEqual(result.segments, EXPECTED.slice(0, 2));
  assert.ok(Math.abs(result.lufs - -18) < 2, `场景响度应接近 -18 LUFS: ${result.lufs}`);
});

test('GET /api/projects/:id/timeline：未导出时 lufs=null(NOT_EXPORTED)，导出后取最近一次的 lufs', needsFfmpeg, async () => {
  let body = await (await fetch(`${base}/api/projects/${project.id}/timeline`)).json();
  assert.equal(body.projectId, project.id);
  assert.deepEqual(body.segments, EXPECTED);
  assert.equal(body.lufs, null);
  assert.equal(body.lufsReason, 'NOT_EXPORTED');
  assert.equal(body.lastExport, null);

  const old = createPersistentTask({ kind: 'export-project', projectId: project.id, payload: {} });
  updatePersistentTask(old.id, { status: 'completed', result: { url: '/media/exports/old.mp3', name: 'old.mp3', durationMs: 1 } });
  body = await (await fetch(`${base}/api/projects/${project.id}/timeline`)).json();
  assert.equal(body.lufs, null);
  assert.equal(body.lufsReason, 'NOT_MEASURED', '改动前的导出没有测响度');

  await new Promise((resolve) => setTimeout(resolve, 5));
  const task = createPersistentTask({ kind: 'one-click', projectId: project.id, payload: {} });
  updatePersistentTask(task.id, { status: 'completed', result: { url: '/media/exports/x.mp3', name: 'x.mp3', durationMs: 6120, lufs: -16.2, lufsReason: null, targetLufs: -16 } });
  body = await (await fetch(`${base}/api/projects/${project.id}/timeline`)).json();
  assert.equal(body.lufs, -16.2);
  assert.equal(body.lufsReason, null);
  assert.equal(body.lastExport.taskId, task.id);
  assert.equal(body.lastExport.kind, 'one-click');

  const missing = await fetch(`${base}/api/projects/nope/timeline`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'PROJECT_NOT_FOUND');
});

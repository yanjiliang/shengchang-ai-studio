// e2e6 B4：台词有 audioUrl 但文件丢了，导出不能悄悄少一句；预检要报出来。

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-missing-file-'));
process.env.SHENGCHANG_RUNTIME_DIR = scratch;
process.env.HOME = scratch;
const media = path.join(scratch, 'media');
mkdirSync(media, { recursive: true });
const { createProject, createPersistentTask, updatePersistentTask } = await import('./database.js');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
let server;

const tone = (name) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=440:d=0.6', '-ar', '24000', path.join(media, name)]);
const line = (id, file) => ({ id, type: 'dialogue', speaker: '悟空', speakerId: 'wukong', text: `台词${id}`, audioUrl: `/media/${file}` });
const makeProject = (prefix) => {
  for (const n of [1, 2, 3]) tone(`${prefix}-${n}.wav`);
  return createProject({ name: prefix, state: { characters: [{ id: 'wukong', name: '悟空' }], assets: [], scenes: [{ id: 's1', title: '第一场', lines: [1, 2, 3].map((n) => line(`${prefix}-l${n}`, `${prefix}-${n}.wav`)) }] } });
};

before(async () => {
  if (!hasFfmpeg) return;
  server = spawn(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js')], {
    env: { ...process.env, SHENGCHANG_RUNTIME_DIR: scratch, HOME: scratch, SHENGCHANG_API_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (chunk) => { log += chunk; });
  server.stderr.on('data', (chunk) => { log += chunk; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/api/projects`)).ok) return; } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`服务没起来：${log}`);
});
after(() => { server?.kill(); rmSync(scratch, { recursive: true, force: true }); });

const post = (url, body = {}) => fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function settle(taskId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const task = await (await fetch(`${base}/api/tasks/${taskId}`)).json();
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('导出任务没结束');
}

test('B4: a dialogue line whose file is gone fails the export loudly and shows up in precheck', { skip: !hasFfmpeg }, async () => {
  const project = makeProject('b4');
  const okCheck = await (await fetch(`${base}/api/projects/${project.id}/export-precheck`)).json();
  assert.equal(okCheck.ok, true);
  assert.equal(okCheck.missingFileLineCount, 0);
  const full = await settle((await (await post(`/api/projects/${project.id}/export-episode`)).json()).id);
  assert.equal(full.status, 'completed', JSON.stringify(full));

  unlinkSync(path.join(media, 'b4-2.wav'));
  const check = await (await fetch(`${base}/api/projects/${project.id}/export-precheck`)).json();
  assert.equal(check.ok, false);
  assert.equal(check.missingFileLineCount, 1);
  assert.deepEqual(check.missingFileLines, [{ sceneId: 's1', lineId: 'b4-l2' }]);
  assert.equal(check.missingAudioLineCount, 0, 'audioUrl 还在，不算“没有音频”');
  assert.equal(check.pendingLineCount, 1);

  const scene = await post(`/api/projects/${project.id}/export-scene`, { sceneId: 's1' });
  assert.equal(scene.status, 409);
  const sceneBody = await scene.json();
  assert.equal(sceneBody.code, 'AUDIO_FILE_MISSING');
  assert.match(sceneBody.error, /有 1 句台词的音频文件不见了/);
  assert.equal(sceneBody.details.missingFileLines[0].lineId, 'b4-l2');

  const episode = await settle((await (await post(`/api/projects/${project.id}/export-episode`)).json()).id);
  assert.equal(episode.status, 'failed', '不能悄悄少一句还报完成');
  assert.match(episode.error, /音频文件不见了/);
});

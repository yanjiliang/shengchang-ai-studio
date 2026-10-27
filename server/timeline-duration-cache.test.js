import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const runtime = mkdtempSync(path.join(tmpdir(), 'sc-duration-'));
process.env.SHENGCHANG_RUNTIME_DIR = runtime;
mkdirSync(path.join(runtime, 'media'), { recursive: true });
const { probeDuration, resolveSceneTimeline } = await import('./media-store.js');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const tone = (file, seconds) => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=f=440:d=${seconds}`, '-ar', '24000', file]);
test.after(() => rmSync(runtime, { recursive: true, force: true }));

test('duration cache is invalidated when the file is replaced', { skip: !hasFfmpeg }, async () => {
  const file = path.join(runtime, 'media', 'swap.wav');
  tone(file, 1);
  assert.ok(Math.abs(await probeDuration(file) - 1) < 0.05);
  tone(file, 3);
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.ok(Math.abs(await probeDuration(file) - 3) < 0.05, 'replaced file must be re-probed');
});

test('timeline over many lines keeps order and durations; second read is cached', { skip: !hasFfmpeg }, async () => {
  for (let i = 0; i < 40; i += 1) tone(path.join(runtime, 'media', `t${i}.wav`), 0.5 + (i % 3) * 0.25);
  const scene = { id: 's', title: 't', lines: Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, type: 'dialogue', speaker: 'a', audioUrl: `/media/t${i}.wav` })) };
  const first = await resolveSceneTimeline(scene);
  assert.deepEqual(first.tracks.map((track) => track.lineId), scene.lines.map((line) => line.id));
  first.tracks.forEach((track, i) => assert.ok(Math.abs(track.sourceDuration - (0.5 + (i % 3) * 0.25)) < 0.05));
  const t = performance.now();
  const second = await resolveSceneTimeline(scene);
  assert.ok(performance.now() - t < 500);
  assert.deepEqual(second.tracks.map((track) => track.start), first.tracks.map((track) => track.start));
});

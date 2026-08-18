import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// Structural tests for the mix math (§8 media-store follow-up): rendered MP3
// output is not byte-deterministic, so instead of golden bytes we render real
// timelines through ffmpeg and assert structure - duration, sample rate,
// channel count, track count - with ffprobe.
const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-media-test-'));
process.env.SHENGCHANG_RUNTIME_DIR = scratch;
const { ensureRuntime, probeFfmpeg, renderScenePreview, runtimePaths } = await import('./media-store.js');

const hasFfmpeg = await probeFfmpeg();
const needsFfmpeg = { skip: hasFfmpeg ? false : '需要 ffmpeg/ffprobe' };

after(() => rmSync(scratch, { recursive: true, force: true }));

function writeSineWav(name, seconds, frequency = 220) {
  const sampleRate = 24000;
  const samples = Math.floor(seconds * sampleRate);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0.2 * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  writeFileSync(path.join(runtimePaths.MEDIA_DIR, name), Buffer.concat([header, pcm]));
  return `/media/${name}`;
}

function probeOutput(url) {
  const source = path.join(runtimePaths.EXPORT_DIR, path.basename(url));
  const output = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=sample_rate,channels', '-of', 'json', source], { encoding: 'utf8' });
  const payload = JSON.parse(output);
  return { durationSeconds: Number(payload.format?.duration) || 0, sampleRate: Number(payload.streams?.[0]?.sample_rate) || 0, channels: Number(payload.streams?.[0]?.channels) || 0 };
}

const dialogue = (id, url, mix = {}) => ({ id, type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text: id, audioUrl: url, mix });

test('混音：未填写入点的对白按默认间隔顺排', needsFfmpeg, async () => {
  await ensureRuntime();
  const first = writeSineWav('seq-1.wav', 1.0);
  const second = writeSineWav('seq-2.wav', 2.0);
  const scene = { id: 'scene-seq', title: '顺排', lines: [dialogue('l1', first), dialogue('l2', second)] };

  const result = await renderScenePreview({ projectId: 'proj', scene });

  // 1.0s + 0.32s 间隔 + 2.0s + 末句 0.32s 间隔 + 0.18s 预混尾垫 = 3.82s。
  assert.equal(result.durationMs, 3820);
  assert.equal(result.trackCount, 2);
  const probed = probeOutput(result.url);
  assert.equal(probed.sampleRate, 48000);
  assert.equal(probed.channels, 2);
  assert.ok(Math.abs(probed.durationSeconds - 3.82) < 0.2, `实际时长应接近 3.82s: ${probed.durationSeconds}`);
});

test('混音：裁切参数决定对白实际时长', needsFfmpeg, async () => {
  await ensureRuntime();
  const source = writeSineWav('trim-1.wav', 2.0);
  const scene = { id: 'scene-trim', title: '裁切', lines: [dialogue('l1', source, { trimStartMs: 500, trimEndMs: 1500 })] };

  const result = await renderScenePreview({ projectId: 'proj', scene });

  // 裁出 1.0s + 0.32s 间隔 + 0.18s 尾垫 = 1.5s。
  assert.equal(result.durationMs, 1500);
  const probed = probeOutput(result.url);
  assert.ok(Math.abs(probed.durationSeconds - 1.5) < 0.2, `实际时长应接近 1.5s: ${probed.durationSeconds}`);
});

test('混音：裁切结束早于开始时拒绝渲染', needsFfmpeg, async () => {
  await ensureRuntime();
  const source = writeSineWav('trim-bad.wav', 2.0);
  const scene = { id: 'scene-trim-bad', title: '坏裁切', lines: [dialogue('l1', source, { trimStartMs: 1500, trimEndMs: 500 })] };

  await assert.rejects(() => renderScenePreview({ projectId: 'proj', scene }), /裁切结束必须晚于裁切开始/);
});

test('混音：循环环境声自动铺满对白区间', needsFfmpeg, async () => {
  await ensureRuntime();
  const voice = writeSineWav('loop-voice.wav', 2.0);
  const bed = writeSineWav('loop-bed.wav', 0.6, 440);
  const scene = { id: 'scene-loop', title: '循环', lines: [dialogue('l1', voice), { id: 'e1', type: 'ambient', label: '环境声', text: '雨声', assetUrl: bed, mix: {} }] };

  const result = await renderScenePreview({ projectId: 'proj', scene });

  // 对白 2.0s + 0.32s 间隔决定总时长；0.6s 环境声循环铺满 = 2.32s + 0.18s 尾垫。
  assert.equal(result.durationMs, 2500);
  assert.equal(result.trackCount, 2);
  const probed = probeOutput(result.url);
  assert.ok(Math.abs(probed.durationSeconds - 2.5) < 0.2, `实际时长应接近 2.5s: ${probed.durationSeconds}`);
});

test('混音：场景没有可用对白音频时拒绝渲染', needsFfmpeg, async () => {
  await ensureRuntime();
  const scene = { id: 'scene-empty', title: '空白', lines: [{ id: 'l1', type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text: '没有音频' }] };

  await assert.rejects(() => renderScenePreview({ projectId: 'proj', scene }), /没有可用对白音频/);
});

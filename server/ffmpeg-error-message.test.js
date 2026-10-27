import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ffmpegFailureMessage, probeDuration } from './media-store.js';

const BANNER = [
  'ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers',
  '  built with Apple clang version 16.0.0',
  '  configuration: --prefix=/opt/homebrew --enable-libdrm --enable-gpl --enable-libmp3lame',
  '  libavutil      59. 39.100 / 59. 39.100',
  '  libavcodec     61. 19.100 / 61. 19.100',
  '  libavformat    61.  7.100 / 61.  7.100',
].join('\n');

test('export failure message drops the build banner and keeps the stderr tail', () => {
  const message = ffmpegFailureMessage('ffmpeg', `${BANNER}\n[in#0 @ 0x1] Error opening input: No such file or directory\nError opening input file /tmp/missing.wav.\nError opening input files: No such file or directory\n`);
  assert.doesNotMatch(message, /configuration:|--enable-libdrm|ffmpeg version|libavutil/);
  assert.match(message, /Error opening input files: No such file or directory$/);
});

test('only the last few lines are kept', () => {
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
  assert.equal(ffmpegFailureMessage('ffmpeg', lines), ['line 15', 'line 16', 'line 17', 'line 18', 'line 19'].join('\n'));
});

test('banner-only or empty stderr falls back to a generic message', () => {
  assert.equal(ffmpegFailureMessage('ffmpeg', BANNER), 'ffmpeg执行失败');
  assert.equal(ffmpegFailureMessage('ffprobe', ''), 'ffprobe执行失败');
});

const hasFfprobe = spawnSync('ffprobe', ['-version']).status === 0;
test('real ffprobe failure surfaces the actual error', { skip: !hasFfprobe }, async () => {
  await assert.rejects(probeDuration('/tmp/shengchang-definitely-missing.wav'), (error) => {
    assert.doesNotMatch(error.message, /configuration:/);
    assert.match(error.message, /No such file or directory/);
    return true;
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('real ffmpeg stderr (with banner) reduces to the real error', { skip: !hasFfmpeg }, () => {
  const { stderr } = spawnSync('ffmpeg', ['-y', '-i', '/tmp/shengchang-definitely-missing.wav', '/tmp/shengchang-out.mp3'], { encoding: 'utf8' });
  assert.match(stderr, /configuration:/);
  const message = ffmpegFailureMessage('ffmpeg', stderr);
  assert.doesNotMatch(message, /configuration:|ffmpeg version|libavutil/);
  assert.match(message, /No such file or directory/);
});

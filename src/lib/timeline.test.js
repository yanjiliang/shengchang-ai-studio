import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultMix, rulerTicks, timelinePreview } from './timeline.js';

test('对白按句后停顿自动顺排', () => {
  const scene = { lines: [
    { id: 'a', type: 'dialogue', audioUrl: '/media/a.wav' },
    { id: 'b', type: 'dialogue', audioUrl: '/media/b.wav' },
  ] };
  const durations = new Map([['a', 3000], ['b', 2000]]);
  const { tracks, totalMs } = timelinePreview(scene, durations);
  assert.equal(tracks[0].startMs, 0);
  assert.equal(tracks[0].durationMs, 3000);
  // 第二句入点 = 3000 + 默认句后停顿 320
  assert.equal(tracks[1].startMs, 3320);
  // 总长含末句句尾停顿（服务端 dialogueCursor 语义）
  assert.equal(totalMs, 5640);
});

test('显式入点与显式时长覆盖顺排与素材原长', () => {
  const scene = { lines: [
    { id: 'a', type: 'dialogue', audioUrl: '/media/a.wav', mix: { startMs: 8000, durationMs: 1500 } },
  ] };
  const { tracks, totalMs } = timelinePreview(scene, new Map([['a', 9000]]));
  assert.equal(tracks[0].startMs, 8000);
  assert.equal(tracks[0].durationMs, 1500);
  // 总长含句尾停顿（与服务端 resolveSceneTimeline 的 dialogueCursor 一致）
  assert.equal(totalMs, 9820);
});

test('裁切区间压缩声床时长', () => {
  const scene = { lines: [
    { id: 'bed', type: 'music', assetUrl: '/media/bed.mp3', mix: { trimStartMs: 2000, trimEndMs: 5000 } },
  ] };
  const { tracks } = timelinePreview(scene, new Map([['bed', 10000]]));
  assert.equal(tracks[0].durationMs, 3000);
});

test('循环声床拉伸至场景结束', () => {
  const scene = { lines: [
    { id: 'a', type: 'dialogue', audioUrl: '/media/a.wav' },
    { id: 'bed', type: 'ambient', assetUrl: '/media/bed.mp3' },
  ] };
  const durations = new Map([['a', 10000], ['bed', 4000]]);
  const { tracks, totalMs } = timelinePreview(scene, durations);
  const bed = tracks.find((track) => track.line.id === 'bed');
  assert.equal(bed.loop, true);
  assert.equal(bed.durationMs, totalMs);
  assert.equal(totalMs, 10320);
});

test('defaultMix 按轨道类型给出默认混音参数', () => {
  assert.equal(defaultMix({ type: 'dialogue' }).startMs, '');
  assert.equal(defaultMix({ type: 'music' }).startMs, 0);
  assert.equal(defaultMix({ type: 'ambient' }).loop, true);
  assert.equal(defaultMix({ type: 'dialogue' }).loop, false);
  assert.equal(defaultMix({ type: 'music', mix: { gainDb: -3 } }).gainDb, -3);
});

test('rulerTicks 按总时长取档且不超过约 6 个刻度', () => {
  assert.deepEqual(rulerTicks(0), [0]);
  assert.ok(rulerTicks(60_000).length <= 8);
  assert.ok(rulerTicks(600_000).length <= 8);
  const hour = rulerTicks(3_600_000);
  assert.equal(hour[hour.length - 1], 3600);
  assert.ok(hour.length <= 8);
});

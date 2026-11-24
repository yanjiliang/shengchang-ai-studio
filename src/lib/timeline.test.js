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
  assert.equal(defaultMix({ type: 'sfx' }).startMs, '');
  assert.equal(defaultMix({ type: 'sfx' }).fadeInMs, 0);
  assert.equal(defaultMix({ type: 'sfx' }).fadeOutMs, 100);
  assert.equal(defaultMix({ type: 'sfx' }).loop, false);
  assert.equal(defaultMix({ type: 'music' }).startMs, 0);
  assert.equal(defaultMix({ type: 'ambient' }).loop, true);
  assert.equal(defaultMix({ type: 'dialogue' }).loop, false);
  assert.equal(defaultMix({ type: 'music', mix: { gainDb: -3 } }).gainDb, -3);
});

test('动作音效未设入点时锚定脚本位置并受限于 1800ms 推进，未绑定或手定入点不推动对白', () => {
  const scene = { lines: [
    { id: 'd1', type: 'dialogue', audioUrl: '/media/d1.wav' },
    { id: 's-unbound', type: 'sfx' },
    { id: 's-short', type: 'sfx', assetUrl: '/media/s1.wav' },
    { id: 'd2', type: 'dialogue', audioUrl: '/media/d2.wav' },
    { id: 's-long', type: 'sfx', assetUrl: '/media/s2.wav' },
    { id: 's-pin', type: 'sfx', assetUrl: '/media/s3.wav', mix: { startMs: 400 } },
    { id: 'd3', type: 'dialogue', audioUrl: '/media/d3.wav' },
  ] };
  const durations = new Map([['d1', 1000], ['s-short', 800], ['d2', 1000], ['s-long', 4000], ['s-pin', 600], ['d3', 1000]]);
  const { tracks, totalMs } = timelinePreview(scene, durations);
  const byId = new Map(tracks.map((track) => [track.line.id, track]));
  assert.equal(byId.get('d1').startMs, 0);
  // 未绑定音效锚在当前游标处，但不推进游标
  assert.equal(byId.get('s-unbound').startMs, 1320);
  assert.equal(byId.get('s-short').startMs, 1320);
  // 短音效 800ms + 200ms 气口 → d2 从 2320ms 进入
  assert.equal(byId.get('d2').startMs, 2320);
  // 长音效 4000ms 从 3640ms 进入，推进封顶 1800ms → d3 从 5440ms 进入
  assert.equal(byId.get('s-long').startMs, 3640);
  assert.equal(byId.get('s-pin').startMs, 400);
  assert.equal(byId.get('d3').startMs, 5440);
  // 总长被 4000ms 长音效尾端（3640 + 4000 = 7640ms）撑满
  assert.equal(totalMs, 7640);
});

test('rulerTicks 按总时长取档且不超过约 6 个刻度', () => {
  assert.deepEqual(rulerTicks(0), [0]);
  assert.ok(rulerTicks(60_000).length <= 8);
  assert.ok(rulerTicks(600_000).length <= 8);
  const hour = rulerTicks(3_600_000);
  assert.equal(hour[hour.length - 1], 3600);
  assert.ok(hour.length <= 8);
});

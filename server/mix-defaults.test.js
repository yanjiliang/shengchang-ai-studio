// 0010：Breeze 的语音指令不写停顿，Breeze 渲染的慢速台词改由混音层加长句后停顿；豆包不变。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { defaultGapAfterMs, distanceFilters, normalizeDistance, resolveGapAfterMs, sfxCursorAdvanceMs } from '../shared/mix-defaults.mjs';
import { timelinePreview } from '../src/lib/timeline.js';
import { toneWav } from './test-support/mock-breeze.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-gap-test-'));
process.env.SHENGCHANG_RUNTIME_DIR = scratch;
const { resolveSceneTimeline, runtimePaths } = await import('./media-store.js');
const { voiceInstructions, TTS_INSTRUCTION_VERSION } = await import('./model-adapters.js');
const B = { audioEngine: 'breeze' };
after(() => rmSync(scratch, { recursive: true, force: true }));

test('默认句后停顿：pace ≥ 90 不变（320），越慢越长，封顶 560', () => {
  assert.equal(defaultGapAfterMs({ ...B, pace: 100 }), 320);
  assert.equal(defaultGapAfterMs({ ...B, pace: 90 }), 320, '默认 pace 90 保持原样');
  assert.equal(defaultGapAfterMs(B), 320, '没有 pace 视同默认');
  assert.equal(defaultGapAfterMs({ ...B, pace: 85 }), 395);
  assert.equal(defaultGapAfterMs({ ...B, pace: 78 }), 500);
  assert.equal(defaultGapAfterMs({ ...B, pace: 70 }), 560);
  assert.equal(defaultGapAfterMs({ ...B, pace: 10 }), 560);
});

test('非 Breeze 渲染的台词（豆包 / demo / 未生成）句后停顿保持 320', () => {
  assert.equal(defaultGapAfterMs({ pace: 70 }), 320);
  assert.equal(defaultGapAfterMs({ pace: 70, audioEngine: 'volcengine-api-key' }), 320);
});

test('手动设置的停顿（包括 0）永远优先', () => {
  assert.equal(resolveGapAfterMs({ ...B, pace: 78, mix: { gapAfterMs: 0 } }), 0);
  assert.equal(resolveGapAfterMs({ ...B, pace: 78, mix: { gapAfterMs: 1200 } }), 1200);
  assert.equal(resolveGapAfterMs({ ...B, pace: 78, mix: {} }), 500);
  assert.equal(resolveGapAfterMs({ ...B, pace: 78, mix: { gapAfterMs: null } }), 500);
});

test('Breeze 慢速指令只写程度、不写停顿；豆包措辞与指令版本不变（缓存不失效）', () => {
  const [breeze] = voiceInstructions({ emotion: '悲伤', emotionScale: 0.6, speed: 0.78 }, { stableSpeaker: false, pauseWording: false });
  assert.match(breeze, /语速稍慢、从容/);
  assert.doesNotMatch(breeze, /停顿|停一下|停一停/);
  const [doubao] = voiceInstructions({ emotion: '悲伤', emotionScale: 0.6, speed: 0.78 });
  assert.match(doubao, /语速放慢，句间多停顿一下/);
  assert.equal(TTS_INSTRUCTION_VERSION, 2);
});

test('前端预览与服务端混音的停顿一致', async () => {
  mkdirSync(runtimePaths.MEDIA_DIR, { recursive: true });
  writeFileSync(path.join(runtimePaths.MEDIA_DIR, 'one.wav'), toneWav(1));
  const scene = { id: 's', title: '测试', lines: [
    { id: 'a', type: 'dialogue', ...B, pace: 78, audioUrl: '/media/one.wav' },
    { id: 'b', type: 'dialogue', ...B, pace: 100, audioUrl: '/media/one.wav' },
    { id: 'c', type: 'dialogue', ...B, pace: 78, mix: { gapAfterMs: 0 }, audioUrl: '/media/one.wav' },
  ] };
  const server = await resolveSceneTimeline(scene);
  assert.deepEqual(server.tracks.map((track) => Math.round(track.start * 1000)), [0, 1500, 2820]);
  const preview = timelinePreview(scene, new Map([['a', 1000], ['b', 1000], ['c', 1000]]));
  assert.deepEqual(preview.tracks.map((track) => track.startMs), [0, 1500, 2820]);
  assert.equal(Math.round(server.totalDuration * 1000), preview.totalMs);
});

test('动作音效推进规则与说话距离归一化', () => {
  assert.equal(sfxCursorAdvanceMs(0), 0);
  assert.equal(sfxCursorAdvanceMs(600), 800, '短音效完整播完 + 200ms 气口');
  assert.equal(sfxCursorAdvanceMs(1600), 1800);
  assert.equal(sfxCursorAdvanceMs(5000), 1800, '长音效最多推进 1800ms，后半尾音搭在下句下');

  assert.equal(normalizeDistance(''), '近讲');
  assert.equal(normalizeDistance('近讲'), '近讲');
  assert.equal(normalizeDistance('耳语'), '耳语');
  assert.equal(normalizeDistance('贴耳低语'), '耳语');
  assert.equal(normalizeDistance('中距'), '中距');
  assert.equal(normalizeDistance('远距'), '远距');
  assert.equal(normalizeDistance('远处'), '远距');
  assert.equal(normalizeDistance('门外喊话'), '远距');
  assert.deepEqual(distanceFilters('近讲'), []);
  assert.ok(distanceFilters('远距').some((item) => item.startsWith('aecho=')));
});

test('前端预览与服务端混音在含动作音效与声床时完全对齐', async () => {
  mkdirSync(runtimePaths.MEDIA_DIR, { recursive: true });
  writeFileSync(path.join(runtimePaths.MEDIA_DIR, 'one.wav'), toneWav(1));
  writeFileSync(path.join(runtimePaths.MEDIA_DIR, 'three.wav'), toneWav(3));
  const scene = { id: 's-sfx', title: '混合对齐', lines: [
    { id: 'd1', type: 'dialogue', audioUrl: '/media/one.wav' },
    { id: 's1', type: 'sfx', assetUrl: '/media/one.wav' },
    { id: 'd2', type: 'dialogue', audioUrl: '/media/one.wav' },
    { id: 's2', type: 'sfx', assetUrl: '/media/three.wav' },
    { id: 'd3', type: 'dialogue', audioUrl: '/media/one.wav' },
    { id: 's3', type: 'sfx', assetUrl: '/media/one.wav', mix: { startMs: 500 } },
    { id: 'amb', type: 'ambient', assetUrl: '/media/one.wav' },
  ] };
  const server = await resolveSceneTimeline(scene);
  const preview = timelinePreview(scene, new Map([['d1', 1000], ['s1', 1000], ['d2', 1000], ['s2', 3000], ['d3', 1000], ['s3', 1000], ['amb', 1000]]));
  assert.deepEqual(
    server.tracks.map((track) => [track.lineId, Math.round(track.start * 1000), Math.round(track.duration * 1000)]),
    preview.tracks.map((track) => [track.line.id, track.startMs, track.durationMs]),
  );
  assert.equal(Math.round(server.totalDuration * 1000), preview.totalMs);
});

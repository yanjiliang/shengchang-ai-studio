// 0010：Breeze 的语音指令不写停顿，Breeze 渲染的慢速台词改由混音层加长句后停顿；豆包不变。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { defaultGapAfterMs, resolveGapAfterMs } from '../shared/mix-defaults.mjs';
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

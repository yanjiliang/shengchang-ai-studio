import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
const { buildRenderFilterGraph, ensureRuntime, probeFfmpeg, renderScenePreview, resolveSceneTimeline, runtimePaths } = await import('./media-store.js');

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

// 合成包含低/中/高三段频谱成分的测试 WAV，便于真实校验距离滤镜的衰减与高频滚降。
function writeMultiToneWav(name, seconds, freqs = [180, 1000, 5500], amplitude = 0.15) {
  const sampleRate = 24000;
  const samples = Math.floor(seconds * sampleRate);
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    let sum = 0;
    for (const freq of freqs) sum += Math.sin((2 * Math.PI * freq * index) / sampleRate);
    pcm.writeInt16LE(Math.round((sum / freqs.length) * amplitude * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  writeFileSync(path.join(runtimePaths.MEDIA_DIR, name), Buffer.concat([header, pcm]));
  return `/media/${name}`;
}

function measureBandDb(exportUrl, filter = 'anull') {
  const source = path.join(runtimePaths.EXPORT_DIR, path.basename(exportUrl));
  const res = spawnSync('ffmpeg', ['-hide_banner', '-i', source, '-af', `${filter},volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const match = res.stderr.match(/mean_volume:\s*([-\d.]+)\s*dB/);
  assert.ok(match, `无法解析 mean_volume: ${res.stderr}`);
  return Number(match[1]);
}

test('混音：动作音效（sfx）默认锚定脚本位置并留节奏气口，不再堆在 0 秒', needsFfmpeg, async () => {
  await ensureRuntime();
  const l1 = writeSineWav('sfx-d1.wav', 1.0);
  const sfxShort = writeSineWav('sfx-short.wav', 0.8, 880);
  const l2 = writeSineWav('sfx-d2.wav', 1.0);
  const sfxLong = writeSineWav('sfx-long.wav', 3.0, 660);
  const l3 = writeSineWav('sfx-d3.wav', 1.0);
  const sfxPinned = writeSineWav('sfx-pinned.wav', 0.5, 990);
  const sfxLegacy = writeSineWav('sfx-legacy.wav', 0.5, 770);

  const scene = {
    id: 'scene-sfx-anchor',
    title: '音效锚定',
    lines: [
      dialogue('l1', l1),
      { id: 's1', type: 'sfx', label: '动作音效', text: '纸页撕裂', assetUrl: sfxShort },
      dialogue('l2', l2),
      { id: 's2', type: 'sfx', label: '动作音效', text: '远雷轰鸣', assetUrl: sfxLong },
      dialogue('l3', l3),
      { id: 's3', type: 'sfx', label: '动作音效', text: '手定入点', assetUrl: sfxPinned, mix: { startMs: 200 } },
      { id: 's4', type: 'sfx', label: '动作音效', text: '旧版时间', assetUrl: sfxLegacy, time: '00:02' },
    ],
  };

  const resolved = await resolveSceneTimeline(scene);
  const byId = new Map(resolved.tracks.map((track) => [track.lineId, track]));
  // l1: 0..1.0 + 0.32 = 1.32s
  assert.equal(Math.round(byId.get('l1').start * 1000), 0);
  // s1（0.8s）锚定到 1.32s，推进 0.8 + 0.2 = 1.0s → cursor = 2.32s；淡入默认 0、淡出 0.1s
  assert.equal(Math.round(byId.get('s1').start * 1000), 1320);
  assert.equal(byId.get('s1').fadeIn, 0);
  assert.equal(byId.get('s1').fadeOut, 0.1);
  // l2: 2.32..3.32 + 0.32 = 3.64s
  assert.equal(Math.round(byId.get('l2').start * 1000), 2320);
  // s2（3.0s 长音效）锚定到 3.64s，推进封顶 1.8s → cursor = 5.44s（后半尾音自然搭在 l3 下方）
  assert.equal(Math.round(byId.get('s2').start * 1000), 3640);
  assert.equal(Math.round(byId.get('l3').start * 1000), 5440);
  // 手定入点与旧版 mm:ss 照旧精准落点
  assert.equal(Math.round(byId.get('s3').start * 1000), 200);
  assert.equal(Math.round(byId.get('s4').start * 1000), 2000);
  // 总长：max(l3 5.44 + 1.0 + 0.32 = 6.76s, s2 3.64 + 3.0 = 6.64s) = 6.76s
  assert.equal(Math.round(resolved.totalDuration * 1000), 6760);
});

test('混音：分轨闪避只压声床（ambient/music），动作音效（sfx）独立总线保留瞬态', needsFfmpeg, async () => {
  await ensureRuntime();
  // 220Hz 强对白 + 同时播放的 1200Hz 探针音（增益 0dB、零淡入淡出）
  const loudVoice = writeMultiToneWav('duck-voice.wav', 1.5, [220], 0.6);
  const probeTone = writeMultiToneWav('duck-probe.wav', 1.5, [1200], 0.25);

  const bedScene = {
    id: 'scene-duck-bed', title: '声床闪避',
    lines: [
      dialogue('d1', loudVoice),
      { id: 'b1', type: 'ambient', label: '环境声', text: '声床', assetUrl: probeTone, mix: { startMs: 0, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 } },
    ],
  };
  const sfxScene = {
    id: 'scene-duck-sfx', title: '音效不闪避',
    lines: [
      dialogue('d1', loudVoice),
      { id: 's1', type: 'sfx', label: '动作音效', text: '撞击', assetUrl: probeTone, mix: { startMs: 0, gainDb: 0, fadeInMs: 0, fadeOutMs: 0 } },
    ],
  };
  const bothScene = {
    id: 'scene-duck-both', title: '三总线共存',
    lines: [
      dialogue('d1', loudVoice),
      { id: 'b1', type: 'ambient', label: '环境声', text: '风声', assetUrl: probeTone },
      { id: 's1', type: 'sfx', label: '动作音效', text: '敲门', assetUrl: probeTone },
    ],
  };

  // 验证滤镜图拓扑：beds 进 sidechaincompress，sfx 绕过 sidechain 直接混入 [mixed]
  const graph = buildRenderFilterGraph(await resolveSceneTimeline(bothScene), { normalize: false, tailPadMs: 180 });
  const graphText = graph.filters.join(';');
  assert.match(graphText, /\[beds\]\[dialogue_side_pad\]sidechaincompress/);
  assert.match(graphText, /\[dialogue_mix\]\[ducked\]\[sfx\]amix=inputs=3/);

  // 真实 FFmpeg 声学验证：同样参数下 sfx 的 1200Hz 能量应显著高于被闪避的 ambient
  const bedResult = await renderScenePreview({ projectId: 'proj', scene: bedScene });
  const sfxResult = await renderScenePreview({ projectId: 'proj', scene: sfxScene });
  const bed1200 = measureBandDb(bedResult.url, 'bandpass=f=1200:width_type=h:w=200');
  const sfx1200 = measureBandDb(sfxResult.url, 'bandpass=f=1200:width_type=h:w=200');
  assert.ok(sfx1200 - bed1200 > 6, `sfx 不应被对白闪避压扁（sfx=${sfx1200} dB, ambient=${bed1200} dB）`);
});

test('混音：说话距离（耳语/近讲/中距/远距）真实生效且不破坏时长', needsFfmpeg, async () => {
  await ensureRuntime();
  const voice = writeMultiToneWav('dist-voice.wav', 1.2, [180, 1000, 5500], 0.35);

  // 近讲保持直通，不注入任何额外距离滤镜
  const closeResolved = await resolveSceneTimeline({ id: 'dist-close', title: '近讲', lines: [{ ...dialogue('d1', voice), distance: '近讲' }] });
  const closeGraph = buildRenderFilterGraph(closeResolved, { normalize: false, tailPadMs: 180 }).filters.join(';');
  assert.doesNotMatch(closeGraph, /aecho|lowpass|highpass/);

  const renderFor = (id, distance) => renderScenePreview({
    projectId: 'proj',
    scene: { id, title: id, lines: [{ ...dialogue('d1', voice), distance }] },
  });

  const closeRes = await renderFor('dist-close', '近讲');
  const whisperRes = await renderFor('dist-whisper', '耳语');
  const midRes = await renderFor('dist-mid', '中距');
  const farRes = await renderFor('dist-far', '远距');
  const farAliasRes = await renderFor('dist-alias', '远处');

  // 所有距离档位（含带 aecho 尾音的中距/远距）输出时长都必须严格对齐 1.2 + 0.32 + 0.18 = 1.70s
  for (const [label, res] of [['近讲', closeRes], ['耳语', whisperRes], ['中距', midRes], ['远距', farRes], ['远处别名', farAliasRes]]) {
    assert.equal(res.durationMs, 1700, `${label} 报告时长应一致`);
    const probed = probeOutput(res.url);
    assert.ok(Math.abs(probed.durationSeconds - 1.7) < 0.2, `${label} 实际时长应接近 1.7s: ${probed.durationSeconds}`);
  }

  const totalDb = (res) => measureBandDb(res.url);
  const highDb = (res) => measureBandDb(res.url, 'highpass=f=4500');
  const midDb = (res) => measureBandDb(res.url, 'bandpass=f=1000:width_type=h:w=300');

  // 整体响度层次：近讲 > 中距 > 远距；耳语也比近讲轻
  assert.ok(totalDb(closeRes) > totalDb(midRes) + 1.5, `中距应比近讲更轻（近讲=${totalDb(closeRes)}, 中距=${totalDb(midRes)}）`);
  assert.ok(totalDb(midRes) > totalDb(farRes) + 2.0, `远距应比中距更轻（中距=${totalDb(midRes)}, 远距=${totalDb(farRes)}）`);
  assert.ok(totalDb(closeRes) > totalDb(whisperRes) + 1.5, `耳语整体音量应低于近讲（近讲=${totalDb(closeRes)}, 耳语=${totalDb(whisperRes)}）`);
  // 空气吸收：远距的高频相对中频衰减显著大于近讲
  const closeTilt = highDb(closeRes) - midDb(closeRes);
  const farTilt = highDb(farRes) - midDb(farRes);
  assert.ok(closeTilt - farTilt > 5, `远距高频空气吸收应明显（近讲高低比=${closeTilt.toFixed(1)}, 远距=${farTilt.toFixed(1)}）`);
  // 耳语保留近场气声高频：耳语的高频相对中频高于近讲
  const whisperTilt = highDb(whisperRes) - midDb(whisperRes);
  assert.ok(whisperTilt > closeTilt + 0.5, `耳语应相对突出近场高频气声（近讲=${closeTilt.toFixed(1)}, 耳语=${whisperTilt.toFixed(1)}）`);
  // 别名“远处”归入“远距”
  assert.ok(Math.abs(totalDb(farRes) - totalDb(farAliasRes)) < 0.2);
});

test('混音：三总线混合（多距离对白 + 循环环境/音乐 + 自动锚定音效）完整渲染通过', needsFfmpeg, async () => {
  await ensureRuntime();
  const v1 = writeMultiToneWav('full-v1.wav', 1.0, [220, 1000, 5000]);
  const v2 = writeMultiToneWav('full-v2.wav', 1.0, [260, 1100, 4800]);
  const sfx = writeSineWav('full-sfx.wav', 0.6, 800);
  const amb = writeSineWav('full-amb.wav', 0.5, 160);
  const mus = writeSineWav('full-mus.wav', 0.7, 330);

  const scene = {
    id: 'scene-full-mix', title: '完整三总线',
    lines: [
      { ...dialogue('d1', v1), distance: '耳语' },
      { id: 'e1', type: 'ambient', label: '环境声', text: '山风', assetUrl: amb },
      { id: 'm1', type: 'music', label: '背景音乐', text: '弦乐', assetUrl: mus },
      { id: 's1', type: 'sfx', label: '动作音效', text: '撕纸', assetUrl: sfx },
      { ...dialogue('d2', v2), distance: '远距' },
    ],
  };

  const result = await renderScenePreview({ projectId: 'proj', scene });
  // d1: 0..1.0 + 0.32 = 1.32 → s1: 1.32..1.92 (+0.2 = 2.12) → d2: 2.12..3.12 + 0.32 = 3.44 + 0.18 = 3.62s
  assert.equal(result.durationMs, 3620);
  assert.equal(result.trackCount, 5);
  const probed = probeOutput(result.url);
  assert.equal(probed.sampleRate, 48000);
  assert.equal(probed.channels, 2);
  assert.ok(Math.abs(probed.durationSeconds - 3.62) < 0.2, `实际时长应接近 3.62s: ${probed.durationSeconds}`);
});

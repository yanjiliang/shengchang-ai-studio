import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
// Overridable so tests can point the database and media tree at a scratch
// directory instead of the real .runtime.
const RUNTIME_DIR = process.env.SHENGCHANG_RUNTIME_DIR || path.resolve(SERVER_DIR, '..', '.runtime');
const MEDIA_DIR = path.join(RUNTIME_DIR, 'media');
const EXPORT_DIR = path.join(RUNTIME_DIR, 'exports');

export async function ensureRuntime() {
  await Promise.all([mkdir(MEDIA_DIR, { recursive: true }), mkdir(EXPORT_DIR, { recursive: true })]);
}

export async function saveMedia(id, extension, buffer) {
  await ensureRuntime();
  const target = path.join(MEDIA_DIR, `${id}.${extension}`);
  await writeFile(target, buffer);
  return { target, url: `/media/${path.basename(target)}` };
}

export async function saveUploadedAsset(id, extension, buffer) {
  const safeExtension = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac'].includes(extension.toLowerCase()) ? extension.toLowerCase() : 'bin';
  return saveMedia(`asset-${id}`, safeExtension, buffer);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-1200) || `${command}执行失败`))));
  });
}

function runWithOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr.slice(-1200) || `${command}执行失败`))));
  });
}

// Binary stdout variant, for piping raw PCM out of ffmpeg.
function runBinary(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(stderr.slice(-1200) || `${command}执行失败`))));
  });
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

let ffmpegProbe = null;
// Cached: whether ffmpeg is on PATH cannot change during the server's lifetime.
export function probeFfmpeg() {
  ffmpegProbe ||= runWithOutput('ffmpeg', ['-version']).then(() => true, () => false);
  return ffmpegProbe;
}

// Project/scene ids come from project state, which the browser can write;
// strip anything path-unsafe before using them in output filenames.
const safeId = (value) => String(value || '').replace(/[^A-Za-z0-9_-]/g, '-') || 'item';

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

function legacyStartMs(value) {
  const match = String(value || '').match(/^(\d+):(\d{2})$/);
  return match ? (Number(match[1]) * 60 + Number(match[2])) * 1000 : 0;
}

function mediaPath(url) {
  if (!url) return null;
  return path.join(MEDIA_DIR, path.basename(url));
}

// Real waveform peaks for the UI: decode to mono 8 kHz PCM and keep the max
// amplitude per bucket, so what the browser draws is the actual file — never
// a decorative canned shape. Cached by url + size + mtime: generated clips
// are content-addressed (new file per change), but preview renders overwrite
// in place and must not serve a stale shape.
const PEAKS_CACHE_LIMIT = 400;
const peaksCache = new Map();

export async function extractPeaks(url, buckets = 48) {
  const source = mediaPath(url);
  if (!source || !path.basename(url).includes('.')) throw new Error('无效的音频地址');
  const info = await stat(source);
  const cached = peaksCache.get(url);
  if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached.peaks;
  const pcm = await runBinary('ffmpeg', ['-i', source, '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length >> 1);
  const perBucket = Math.max(1, Math.ceil(samples.length / buckets));
  const peaks = new Array(buckets).fill(0);
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const end = Math.min(samples.length, (bucket + 1) * perBucket);
    for (let index = bucket * perBucket; index < end; index += 1) {
      const magnitude = Math.abs(samples[index]);
      if (magnitude > peaks[bucket]) peaks[bucket] = magnitude;
    }
  }
  const loudest = Math.max(...peaks);
  const normalized = loudest > 0 ? peaks.map((peak) => peak / loudest) : peaks;
  if (peaksCache.size >= PEAKS_CACHE_LIMIT) peaksCache.delete(peaksCache.keys().next().value);
  peaksCache.set(url, { size: info.size, mtimeMs: info.mtimeMs, peaks: normalized });
  return normalized;
}

export async function probeDuration(source) {
  const output = await runWithOutput('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', source]);
  const seconds = Number(output.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`无法读取音频时长：${path.basename(source)}`);
  return seconds;
}

async function probeMedia(source) {
  const output = await runWithOutput('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,sample_rate,channels', '-of', 'json', source]);
  const payload = JSON.parse(output);
  const stream = payload.streams?.find((item) => item.sample_rate || item.channels) || payload.streams?.[0] || {};
  return {
    durationMs: Math.round((Number(payload.format?.duration) || 0) * 1000),
    size: Number(payload.format?.size) || 0,
    codec: stream.codec_name || '', sampleRate: Number(stream.sample_rate) || 0, channels: Number(stream.channels) || 0,
  };
}

export async function inspectProjectMedia(project) {
  const scenes = [];
  for (const scene of project.state.scenes || []) {
    const targets = (scene.lines || [])
      .map((line) => ({ line, url: line.type === 'dialogue' ? line.audioUrl : line.assetUrl }))
      .filter((target) => target.url);
    // One ffprobe spawn per file; a full scene of these adds up, so probe a few
    // at a time instead of strictly sequentially.
    const files = await mapWithConcurrency(targets, 4, async ({ line, url }) => {
      const source = mediaPath(url);
      try {
        const info = await probeMedia(source);
        return { lineId: line.id, type: line.type, url, ok: info.durationMs > 0 && info.sampleRate > 0 && info.channels > 0, ...info };
      } catch (error) {
        return { lineId: line.id, type: line.type, url, ok: false, error: error.message };
      }
    });
    const dialogue = (scene.lines || []).filter((line) => line.type === 'dialogue');
    const dialogueFiles = files.filter((item) => item.type === 'dialogue');
    scenes.push({
      sceneId: scene.id, title: scene.title, files,
      dialogueCount: dialogue.length, healthyDialogueCount: dialogueFiles.filter((item) => item.ok).length,
      missingDialogueCount: dialogue.filter((line) => !line.audioUrl).length,
      invalidFileCount: files.filter((item) => !item.ok).length,
      durationMs: dialogueFiles.filter((item) => item.ok).reduce((sum, item) => sum + item.durationMs, 0),
    });
  }
  const files = scenes.flatMap((scene) => scene.files);
  return {
    checkedAt: Date.now(), scenes,
    summary: {
      fileCount: files.length,
      healthyCount: files.filter((item) => item.ok).length,
      invalidCount: files.filter((item) => !item.ok).length,
      missingDialogueCount: scenes.reduce((sum, scene) => sum + scene.missingDialogueCount, 0),
      totalDurationMs: files.filter((item) => item.ok).reduce((sum, item) => sum + item.durationMs, 0),
    },
  };
}

async function resolveSceneTimeline(scene) {
  const tracks = [];
  const missing = [];
  let dialogueCursor = 0;
  for (const line of scene.lines || []) {
    const url = line.type === 'dialogue' ? line.audioUrl : line.assetUrl;
    if (!url) { if (line.type === 'dialogue') missing.push(line.id); continue; }
    const source = mediaPath(url);
    try { await stat(source); } catch { missing.push(line.id); continue; }
    const sourceDuration = await probeDuration(source);
    const mix = line.mix || {};
    const isDialogue = line.type === 'dialogue';
    const defaultLoop = line.type === 'ambient' || line.type === 'music';
    const explicitStart = mix.startMs !== '' && mix.startMs !== null && mix.startMs !== undefined && Number.isFinite(Number(mix.startMs)) ? Math.max(0, Number(mix.startMs)) / 1000 : null;
    const start = explicitStart ?? (isDialogue ? dialogueCursor : legacyStartMs(line.time) / 1000);
    const trimStart = clamp(Number(mix.trimStartMs) / 1000, 0, Math.max(0, sourceDuration - 0.02), 0);
    const hasTrimEnd = mix.trimEndMs !== '' && mix.trimEndMs !== null && mix.trimEndMs !== undefined;
    const requestedTrimEnd = hasTrimEnd ? Number(mix.trimEndMs) / 1000 : sourceDuration;
    if (hasTrimEnd && (!Number.isFinite(requestedTrimEnd) || requestedTrimEnd <= trimStart)) throw new Error(`轨道「${line.speaker || line.label || line.id}」的裁切结束必须晚于裁切开始`);
    const trimEndSetting = hasTrimEnd ? clamp(requestedTrimEnd, trimStart + 0.02, sourceDuration, sourceDuration) : sourceDuration;
    const trimmedSourceDuration = Math.max(0.02, trimEndSetting - trimStart);
    const requestedDuration = mix.durationMs !== '' && mix.durationMs !== null && mix.durationMs !== undefined ? clamp(Number(mix.durationMs) / 1000, 0.05, 21_600, 0) : 0;
    const loop = !isDialogue && (mix.loop ?? defaultLoop);
    const duration = requestedDuration || trimmedSourceDuration;
    const gapAfter = isDialogue ? clamp(Number(mix.gapAfterMs) / 1000, 0, 10, 0.32) : 0;
    tracks.push({ lineId: line.id, type: line.type, source, sourceDuration, trimmedSourceDuration, trimStart, trimEnd: trimEndSetting, start, duration, loop, gainDb: clamp(mix.gainDb, -60, 12, isDialogue ? 0 : line.type === 'music' ? -18 : line.type === 'ambient' ? -14 : -6), fadeIn: clamp(Number(mix.fadeInMs) / 1000, 0, 30, isDialogue ? 0 : 0.4), fadeOut: clamp(Number(mix.fadeOutMs) / 1000, 0, 30, isDialogue ? 0 : 0.7), pan: clamp(mix.pan, -1, 1, 0) });
    if (isDialogue) dialogueCursor = Math.max(dialogueCursor, start + duration + gapAfter);
  }
  if (!tracks.some((track) => track.type === 'dialogue')) throw new Error(`场景「${scene.title}」没有可用对白音频`);
  let totalDuration = Math.max(dialogueCursor, ...tracks.map((track) => track.start + track.duration));
  for (const track of tracks) {
    if (track.loop && !(Number(track.duration) > track.trimmedSourceDuration)) track.duration = Math.max(0.1, totalDuration - track.start);
    totalDuration = Math.max(totalDuration, track.start + track.duration);
  }
  return { tracks, missing, totalDuration };
}

function busFilter(labels, name, filters) {
  if (labels.length === 1) filters.push(`${labels[0]}anull[${name}]`);
  else filters.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0[${name}]`);
}

async function renderTimeline(scene, output, { targetLufs = -16, normalize = true, tailPadMs = 350 } = {}) {
  const resolved = await resolveSceneTimeline(scene);
  const inputs = [];
  const filters = [];
  const dialogueLabels = [];
  const bedLabels = [];
  resolved.tracks.forEach((track, index) => {
    inputs.push('-i', track.source);
    const label = track.type === 'dialogue' ? `[d${index}]` : `[b${index}]`;
    const chain = [`[${index}:a]aresample=48000`, 'aformat=sample_fmts=fltp:channel_layouts=stereo', `atrim=start=${track.trimStart.toFixed(3)}:end=${track.trimEnd.toFixed(3)}`, 'asetpts=PTS-STARTPTS'];
    if (track.loop && track.duration > track.trimmedSourceDuration) chain.push(`aloop=loop=-1:size=${Math.max(1, Math.round(track.trimmedSourceDuration * 48000))}`);
    else if (track.duration > track.trimmedSourceDuration) chain.push('apad');
    chain.push(`atrim=duration=${track.duration.toFixed(3)}`, 'asetpts=PTS-STARTPTS', `volume=${Math.pow(10, track.gainDb / 20).toFixed(6)}`);
    if (track.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${Math.min(track.fadeIn, track.duration).toFixed(3)}`);
    if (track.fadeOut > 0) chain.push(`afade=t=out:st=${Math.max(0, track.duration - track.fadeOut).toFixed(3)}:d=${Math.min(track.fadeOut, track.duration).toFixed(3)}`);
    if (track.pan !== 0) chain.push(`stereotools=balance_out=${track.pan.toFixed(3)}`);
    chain.push(`adelay=${Math.round(track.start * 1000)}:all=1`);
    filters.push(`${chain.join(',')}${label}`);
    (track.type === 'dialogue' ? dialogueLabels : bedLabels).push(label);
  });
  busFilter(dialogueLabels, 'dialogue', filters);
  let mixedLabel = '[dialogue]';
  if (bedLabels.length) {
    busFilter(bedLabels, 'beds', filters);
    filters.push('[dialogue]asplit=2[dialogue_mix][dialogue_side]');
    // Pad the sidechain copy of the dialogue bus: sidechaincompress stops
    // when EITHER input ends, so an unpadded sidechain would cut looped beds
    // off at the end of the last dialogue line (caught by structural test).
    // The pad is bounded (not infinite apad) or the filter graph never sees
    // EOF and the render hangs.
    filters.push(`[dialogue_side]apad=pad_dur=${resolved.totalDuration.toFixed(3)}[dialogue_side_pad]`);
    filters.push(`[beds][dialogue_side_pad]sidechaincompress=threshold=0.025:ratio=8:attack=20:release=450[ducked]`);
    filters.push('[dialogue_mix][ducked]amix=inputs=2:duration=longest:normalize=0[mixed]');
    mixedLabel = '[mixed]';
  }
  const finalDuration = resolved.totalDuration + tailPadMs / 1000;
  // Pad past the end and cut at finalDuration: totalDuration can run longer
  // than any track's actual content (e.g. the trailing gap after the last
  // dialogue line), which would leave the rendered file shorter than the
  // duration we report. pad_dur=finalDuration is a guaranteed-sufficient
  // bound; an unbounded apad can hang downstream filters waiting for EOF.
  const finalChain = [`apad=pad_dur=${finalDuration.toFixed(3)}`, `atrim=0:${finalDuration.toFixed(3)}`];
  if (normalize) finalChain.push(`loudnorm=I=${targetLufs}:TP=-1:LRA=11`);
  finalChain.push('alimiter=limit=0.95');
  filters.push(`${mixedLabel}${finalChain.join(',')}[out]`);
  const codec = output.endsWith('.wav') ? ['-codec:a', 'pcm_s24le'] : ['-codec:a', 'libmp3lame', '-b:a', '192k'];
  await run('ffmpeg', ['-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-ar', '48000', '-ac', '2', ...codec, output]);
  return { ...resolved, durationMs: Math.round(finalDuration * 1000) };
}

export async function exportSceneTimeline({ projectId, scene, targetLufs = -16 }) {
  await ensureRuntime();
  const safeTitle = String(scene.title || '未命名场景').replace(/[\\/:*?"<>|]/g, '-');
  const output = path.join(EXPORT_DIR, `${safeId(projectId)}-${safeId(scene.id)}-${safeTitle}.mp3`);
  const rendered = await renderTimeline(scene, output, { targetLufs, normalize: true, tailPadMs: 350 });
  return { url: `/media/exports/${path.basename(output)}`, name: path.basename(output), durationMs: rendered.durationMs, trackCount: rendered.tracks.length, missingLineIds: rendered.missing };
}

export async function renderScenePreview({ projectId, scene }) {
  await ensureRuntime();
  const safeTitle = String(scene.title || '未命名场景').replace(/[\\/:*?"<>|]/g, '-');
  // Fixed name per scene: previews are disposable, so overwrite instead of
  // accumulating a new file on every render.
  const output = path.join(EXPORT_DIR, `${safeId(projectId)}-${safeId(scene.id)}-${safeTitle}-预混.mp3`);
  const rendered = await renderTimeline(scene, output, { normalize: false, tailPadMs: 180 });
  return { url: `/media/exports/${path.basename(output)}`, name: path.basename(output), durationMs: rendered.durationMs, trackCount: rendered.tracks.length, missingLineIds: rendered.missing };
}

export async function exportProjectTimeline({ project, targetLufs = -16, onProgress, shouldCancel }) {
  await ensureRuntime();
  const renderedScenes = [];
  const eligible = (project.state.scenes || []).filter((scene) => scene.lines?.some((line) => line.type === 'dialogue' && line.audioUrl));
  if (!eligible.length) throw new Error('整部作品没有可导出的对白音频');
  const manifest = path.join(EXPORT_DIR, `${safeId(project.id)}-episode-concat.txt`);
  try {
    for (let index = 0; index < eligible.length; index += 1) {
      if (shouldCancel?.()) { const error = new Error('整集导出已取消'); error.code = 'TASK_CANCELLED'; throw error; }
      const scene = eligible[index];
      onProgress?.({ current: index + 1, total: eligible.length, progress: 8 + Math.round(index / eligible.length * 72), message: `正在混音场景 ${index + 1} / ${eligible.length}` });
      const output = path.join(EXPORT_DIR, `${safeId(project.id)}-${safeId(scene.id)}-episode.wav`);
      const rendered = await renderTimeline(scene, output, { normalize: false, tailPadMs: 900 });
      renderedScenes.push({ scene, output, rendered });
    }
    await writeFile(manifest, renderedScenes.map(({ output }) => `file '${output.replaceAll("'", "'\\''")}'`).join('\n'));
    onProgress?.({ current: eligible.length, total: eligible.length, progress: 88, message: '正在统一整集响度与峰值' });
    const safeName = String(project.name || '未命名作品').replace(/[\\/:*?"<>|]/g, '-');
    const output = path.join(EXPORT_DIR, `${safeId(project.id)}-${safeName}-整集.mp3`);
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', manifest, '-af', `loudnorm=I=${targetLufs}:TP=-1:LRA=11,alimiter=limit=0.95`, '-ar', '48000', '-ac', '2', '-codec:a', 'libmp3lame', '-b:a', '192k', output]);
    const durationMs = renderedScenes.reduce((sum, item) => sum + item.rendered.durationMs, 0);
    return { url: `/media/exports/${path.basename(output)}`, name: path.basename(output), durationMs, sceneCount: renderedScenes.length, trackCount: renderedScenes.reduce((sum, item) => sum + item.rendered.tracks.length, 0) };
  } finally {
    // Per-scene intermediate WAVs and the concat manifest are only inputs to
    // the final encode; never leave them behind.
    await unlink(manifest).catch(() => {});
    await Promise.all(renderedScenes.map(({ output }) => unlink(output).catch(() => {})));
  }
}

export const runtimePaths = { MEDIA_DIR, EXPORT_DIR };

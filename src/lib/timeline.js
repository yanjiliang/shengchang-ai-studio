// Pure mix-timeline math shared by the ProductionView preview. Kept free of
// JSX so node:test can cover it directly — it is a display-only twin of the
// server's resolveSceneTimeline (media-store.js), which stays the render
// source of truth.
import { defaultFadeInMs, defaultFadeOutMs, defaultGainDb, defaultLoop, parseLegacyStartMs, resolveGapAfterMs, sfxCursorAdvanceMs } from '../../shared/mix-defaults.mjs';

function numberValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function defaultMix(line) {
  return {
    startMs: line.mix?.startMs ?? (line.type === 'dialogue' || line.type === 'sfx' ? '' : 0),
    durationMs: line.mix?.durationMs ?? '',
    trimStartMs: line.mix?.trimStartMs ?? 0,
    trimEndMs: line.mix?.trimEndMs ?? '',
    gainDb: line.mix?.gainDb ?? defaultGainDb(line.type),
    fadeInMs: line.mix?.fadeInMs ?? defaultFadeInMs(line.type),
    fadeOutMs: line.mix?.fadeOutMs ?? defaultFadeOutMs(line.type),
    pan: line.mix?.pan ?? 0,
    gapAfterMs: resolveGapAfterMs(line),
    loop: line.mix?.loop ?? defaultLoop(line.type),
  };
}

// Dialogue auto-sequences with its gap; unpinned sfx anchors to the current
// script cursor and advances a bounded beat; ambient/music beds enter at their
// explicit start (else 0); explicit duration/trim win over the probed length;
// looped beds stretch to the scene end. durationByLine carries ffprobe lengths
// by lineId.
export function timelinePreview(scene, durationByLine) {
  if (!scene) return { tracks: [], totalMs: 0 };
  const tracks = [];
  let cursorMs = 0;
  for (const line of scene.lines || []) {
    const mix = defaultMix(line);
    const isDialogue = line.type === 'dialogue';
    const isSfx = line.type === 'sfx';
    const hasAudio = Boolean(line.audioUrl || line.assetUrl);
    const probeMs = (durationByLine && durationByLine.get(line.id)) || 0;
    const trimStartMs = Math.max(0, Math.min(numberValue(mix.trimStartMs, 0), Math.max(0, probeMs - 20)));
    const trimEndMs = mix.trimEndMs === '' ? probeMs : Math.min(Math.max(numberValue(mix.trimEndMs, probeMs), trimStartMs + 20), Math.max(trimStartMs + 20, probeMs));
    const trimmedMs = Math.max(50, trimEndMs - trimStartMs);
    const explicitDurationMs = mix.durationMs === '' ? null : Math.max(50, numberValue(mix.durationMs, 50));
    const durationMs = hasAudio ? (explicitDurationMs ?? trimmedMs) : (explicitDurationMs ?? 0);
    const explicitStartMs = mix.startMs === '' || mix.startMs === null || mix.startMs === undefined ? null : Math.max(0, numberValue(mix.startMs, 0));
    const legacyStartMs = !isDialogue ? parseLegacyStartMs(line.time) : null;
    const autoAnchorSfx = isSfx && explicitStartMs === null && legacyStartMs === null;
    const startMs = explicitStartMs ?? (isDialogue ? cursorMs : autoAnchorSfx ? cursorMs : (legacyStartMs ?? 0));
    if (isDialogue) cursorMs = Math.max(cursorMs, startMs + durationMs + Math.max(0, Math.min(10_000, numberValue(mix.gapAfterMs, 320))));
    else if (autoAnchorSfx && hasAudio) cursorMs = Math.max(cursorMs, startMs + sfxCursorAdvanceMs(durationMs));
    tracks.push({ line, startMs, durationMs, loop: !isDialogue && mix.loop, hasAudio, explicitDuration: explicitDurationMs !== null });
  }
  let totalMs = Math.max(cursorMs, ...tracks.map((track) => track.startMs + track.durationMs), 0);
  for (const track of tracks) if (track.loop && track.hasAudio && !track.explicitDuration) track.durationMs = Math.max(100, totalMs - track.startMs);
  totalMs = Math.max(cursorMs, ...tracks.map((track) => track.startMs + track.durationMs), 0);
  return { tracks, totalMs };
}

const RULER_STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 1200];

// Tick seconds scaled to the real total, capped at ~6 labels.
export function rulerTicks(totalMs) {
  const totalSeconds = totalMs / 1000;
  const step = RULER_STEPS.find((candidate) => totalSeconds / candidate <= 6) || 2400;
  const ticks = [];
  for (let second = 0; second <= totalSeconds + 0.001; second += step) ticks.push(second);
  return ticks;
}

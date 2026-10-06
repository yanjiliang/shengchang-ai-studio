// Pure mix-timeline math shared by the ProductionView preview. Kept free of
// JSX so node:test can cover it directly — it is a display-only twin of the
// server's resolveSceneTimeline (media-store.js), which stays the render
// source of truth.

function numberValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function defaultMix(line) {
  return {
    startMs: line.mix?.startMs ?? (line.type === 'dialogue' ? '' : 0),
    durationMs: line.mix?.durationMs ?? '',
    trimStartMs: line.mix?.trimStartMs ?? 0,
    trimEndMs: line.mix?.trimEndMs ?? '',
    gainDb: line.mix?.gainDb ?? (line.type === 'dialogue' ? 0 : line.type === 'music' ? -18 : line.type === 'ambient' ? -14 : -6),
    fadeInMs: line.mix?.fadeInMs ?? (line.type === 'dialogue' ? 0 : 400),
    fadeOutMs: line.mix?.fadeOutMs ?? (line.type === 'dialogue' ? 0 : 700),
    pan: line.mix?.pan ?? 0,
    gapAfterMs: line.mix?.gapAfterMs ?? 320,
    loop: line.mix?.loop ?? (line.type === 'ambient' || line.type === 'music'),
  };
}

// Dialogue auto-sequences with its gap; beds enter at their explicit start
// (else 0); explicit duration/trim win over the probed length; looped beds
// stretch to the scene end. durationByLine carries ffprobe lengths by lineId.
export function timelinePreview(scene, durationByLine) {
  if (!scene) return { tracks: [], totalMs: 0 };
  const tracks = [];
  let cursorMs = 0;
  for (const line of scene.lines || []) {
    const mix = defaultMix(line);
    const isDialogue = line.type === 'dialogue';
    const hasAudio = Boolean(line.audioUrl || line.assetUrl);
    const probeMs = (durationByLine && durationByLine.get(line.id)) || 0;
    const trimStartMs = Math.max(0, Math.min(numberValue(mix.trimStartMs, 0), Math.max(0, probeMs - 20)));
    const trimEndMs = mix.trimEndMs === '' ? probeMs : Math.min(Math.max(numberValue(mix.trimEndMs, probeMs), trimStartMs + 20), Math.max(trimStartMs + 20, probeMs));
    const trimmedMs = Math.max(50, trimEndMs - trimStartMs);
    const explicitDurationMs = mix.durationMs === '' ? null : Math.max(50, numberValue(mix.durationMs, 50));
    const durationMs = hasAudio ? (explicitDurationMs ?? trimmedMs) : (explicitDurationMs ?? 0);
    const explicitStartMs = mix.startMs === '' ? null : Math.max(0, numberValue(mix.startMs, 0));
    const startMs = explicitStartMs ?? (isDialogue ? cursorMs : 0);
    if (isDialogue) cursorMs = Math.max(cursorMs, startMs + durationMs + Math.max(0, Math.min(10_000, numberValue(mix.gapAfterMs, 320))));
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

// Request-shape contract shared by the browser workbench (App.jsx) and the
// server-side one-click orchestrator (OV-7): one copy of the math means the
// manual flows and the orchestrated flow can never drift apart.

// 数值缺省：只有“没填”（undefined / null / '' / 非数字）才用缺省值；0 是合法值
// （情绪强度 0 = 最弱，之前 `|| 40` 把它变成了 0.4）。
export function numberOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

// 情绪强度 → emotionScale：恰好 0 = “不要情绪”（emotionScale 0，指令里不写情绪那句）；
// 1–100 → 0.01–1 再夹到 [0.1, 1]；没填（undefined / null / '' / 非数字）按 40。
export function emotionScaleFor(intensity) {
  const value = numberOr(intensity, 40);
  if (value === 0) return 0;
  return Math.min(1, Math.max(0.1, value / 100));
}

export function buildGenerationRequest(line, voiceMap) {
  return {
    lineId: line.id,
    speakerId: line.speakerId,
    voiceId: voiceMap?.[line.speakerId] || '',
    text: line.text,
    subtext: line.subtext || '',
    emotion: line.emotion,
    emotionScale: emotionScaleFor(line.intensity),
    // 语速 0 不是合法值（界面 70–120%），0 / 缺省都按 90%。
    speed: (numberOr(line.pace, 90) || 90) / 100,
    distance: line.distance || '',
  };
}

// Collect the dialogue lines that need (re)generation across scenes. The
// default predicate is the one-click definition of "missing": no audio yet,
// or audio that no longer matches the current text.
export function buildGenerationRequests(state, { sceneIds, needGeneration } = {}) {
  const shouldGenerate = needGeneration || ((line) => !line.audioUrl || line.audioStale);
  const requests = [];
  for (const scene of state.scenes || []) {
    if (sceneIds?.length && !sceneIds.includes(scene.id)) continue;
    for (const line of scene.lines || []) {
      if (line.type !== 'dialogue' || !shouldGenerate(line)) continue;
      requests.push({ ...buildGenerationRequest(line, state.voiceMap), sceneId: scene.id });
    }
  }
  return requests;
}

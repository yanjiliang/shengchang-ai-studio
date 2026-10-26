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

// 情绪强度 → emotionScale：与 0036（a936049）逐字相同——没填（undefined / null / '' / 非数字）按 40，
// 再除以 100 夹到 [0.1, 1]，所以强度 0 → 0.1。豆包的指令和缓存键都靠它，不能动。
export function emotionScaleFor(intensity) {
  return Math.min(1, Math.max(0.1, numberOr(intensity, 40) / 100));
}

// 强度恰好 0 = “不要情绪”：只有 Breeze 用（breezeInstruction 只留语速那句；缓存键只在 Breeze 下带上它）。
// 豆包 / 自定义引擎完全忽略这个标记。
export const isEmotionOff = (intensity) => numberOr(intensity, 40) === 0;

export function buildGenerationRequest(line, voiceMap) {
  return {
    lineId: line.id,
    speakerId: line.speakerId,
    voiceId: voiceMap?.[line.speakerId] || '',
    text: line.text,
    subtext: line.subtext || '',
    emotion: line.emotion,
    emotionScale: emotionScaleFor(line.intensity),
    ...(isEmotionOff(line.intensity) ? { emotionOff: true } : {}),
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

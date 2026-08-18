// Request-shape contract shared by the browser workbench (App.jsx) and the
// server-side one-click orchestrator (OV-7): one copy of the math means the
// manual flows and the orchestrated flow can never drift apart.

export function buildGenerationRequest(line, voiceMap) {
  return {
    lineId: line.id,
    speakerId: line.speakerId,
    voiceId: voiceMap?.[line.speakerId] || '',
    text: line.text,
    subtext: line.subtext || '',
    emotion: line.emotion,
    emotionScale: Math.max(0.1, (line.intensity || 40) / 100),
    speed: (line.pace || 90) / 100,
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

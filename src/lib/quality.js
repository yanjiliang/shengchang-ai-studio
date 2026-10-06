// Pure quality-reporting math extracted from App.jsx so node:test can pin
// the weighting, issue enumeration, and stage gating.

export function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round((milliseconds || 0) / 1000));
  return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`;
}

// §8 stage-checklist: project-wide readiness stages, each deep-linking to the
// surface where it gets fixed.
export function stageProgress(scenes, voiceMap) {
  const dialogue = scenes.flatMap((scene) => (scene.lines || []).filter((line) => line.type === 'dialogue'));
  const voiced = dialogue.filter((line) => line.audioUrl);
  const speakers = [...new Set(dialogue.map((line) => line.speakerId))];
  const mapped = speakers.filter((id) => voiceMap?.[id]);
  const sounds = scenes.flatMap((scene) => (scene.lines || []).filter((line) => line.type !== 'dialogue'));
  const bound = sounds.filter((line) => line.assetUrl);
  const pct = (done, total) => total ? Math.round((done / total) * 100) : 100;
  return [
    { id: 'breakdown', label: '剧本拆解', detail: `${scenes.length} 个场景`, progress: scenes.length ? 100 : 0, view: 'studio' },
    { id: 'voices', label: '角色音色', detail: `${mapped.length} / ${speakers.length} 个角色已绑定`, progress: pct(mapped.length, speakers.length), view: 'voices' },
    { id: 'dialogue', label: '对白生成', detail: `${voiced.length} / ${dialogue.length} 句已生成`, progress: pct(voiced.length, dialogue.length), view: 'studio' },
    { id: 'sounds', label: '声音世界', detail: `${bound.length} / ${sounds.length} 个事件已绑定`, progress: pct(bound.length, sounds.length), view: 'sounds' },
    { id: 'mix', label: '混音导出', detail: voiced.length ? '可进入制作中心导出' : '还没有可导出的对白', progress: voiced.length ? 100 : 0, view: 'production' },
  ];
}

// §8 attention list: issues (deep-linkable to the offending line) plus passed
// checks, weighted into the scene score. mediaReport is the ffprobe report;
// without it (report still loading) media defaults are optimistic.
export function qualityReport(currentScene, voiceMap, mediaReport) {
  if (!currentScene) return { score: 0, metrics: { coverage: 0, voices: 0, soundWorld: 0, text: 0 }, issues: [], passed: [], canExport: false };
  const dialogue = currentScene.lines.filter((line) => line.type === 'dialogue'); const voiced = dialogue.filter((line) => line.audioUrl); const speakers = [...new Set(dialogue.map((line) => line.speakerId))]; const mapped = speakers.filter((id) => voiceMap?.[id]); const sounds = currentScene.lines.filter((line) => line.type !== 'dialogue'); const bound = sounds.filter((line) => line.assetUrl);
  const sceneMedia = mediaReport?.scenes?.find((item) => item.sceneId === currentScene.id);
  const stale = voiced.filter((line) => line.audioStale);
  const healthy = sceneMedia?.healthyDialogueCount ?? voiced.length;
  const invalid = sceneMedia?.invalidFileCount ?? 0;
  const metrics = { coverage: dialogue.length ? Math.round(voiced.length / dialogue.length * 100) : 0, voices: speakers.length ? Math.round(mapped.length / speakers.length * 100) : 100, soundWorld: sounds.length ? Math.round(bound.length / sounds.length * 100) : 100, text: dialogue.every((line) => line.text?.trim()) ? 100 : 0, media: voiced.length ? Math.min(100, Math.max(0, Math.round((healthy - stale.length) / voiced.length * 100))) : 100 };
  const issues = []; if (metrics.coverage < 100) issues.push({ id: 'coverage', level: 'warning', title: '存在未生成的对白', scope: `${voiced.length} / ${dialogue.length} 句`, detail: '未生成的对白不会进入成片。', action: '返回生成', actionMessage: '请在场景导演生成对白', locate: dialogue.find((line) => !line.audioUrl)?.id }); if (metrics.voices < 100) issues.push({ id: 'voices', level: 'warning', title: '角色未绑定真实音色', scope: `${mapped.length} / ${speakers.length} 个角色`, detail: '缺少 voice_id 会破坏人物一致性。', action: '配置音色', actionMessage: '请到角色音色页配置' }); if (metrics.soundWorld < 100) issues.push({ id: 'sounds', level: 'info', title: '声音事件尚未绑定素材', scope: `${bound.length} / ${sounds.length} 个事件`, detail: '未绑定的声音事件不会进入混音。', action: '绑定素材', actionMessage: '请到声音素材页处理' });
  if (invalid) issues.push({ id: 'media', level: 'warning', title: '存在无法解码的音频文件', scope: `${invalid} 个文件`, detail: '请重新生成对白或重新导入声音素材后再导出。', action: '查看制作', actionMessage: '制作中心已标出异常文件', locate: sceneMedia?.files?.find((file) => !file.ok)?.lineId });
  if (stale.length) issues.push({ id: 'stale', level: 'warning', title: '台词改动后音频未重新生成', scope: `${stale.length} 句`, detail: '这些句子会用旧音频进入成片，与当前台词不一致。', action: '重新生成', actionMessage: '请重新生成这些对白', locate: stale[0]?.id });
  const passed = []; if (metrics.coverage === 100 && !stale.length) passed.push({ id: 'coverage-ok', level: 'passed', title: '对白音频覆盖完整', scope: `${dialogue.length} 句`, detail: '每条对白均已关联与当前台词一致的音频。', action: '查看场景', actionMessage: '检查通过' }); if (metrics.text === 100) passed.push({ id: 'text-ok', level: 'passed', title: '文本可合成性通过', scope: '当前场景', detail: '没有空白台词。', action: '查看报告', actionMessage: '检查通过' }); if (metrics.media === 100 && voiced.length) passed.push({ id: 'media-ok', level: 'passed', title: '音频文件健康', scope: `${healthy} 个文件`, detail: sceneMedia ? `可解码，合计 ${formatDuration(sceneMedia.durationMs)}。` : '音频文件可正常读取。', action: '查看制作', actionMessage: '检查通过' });
  return { metrics, issues, passed, score: Math.round(metrics.coverage * .35 + metrics.voices * .22 + metrics.soundWorld * .18 + metrics.text * .1 + metrics.media * .15), canExport: voiced.length > 0 && invalid === 0 };
}

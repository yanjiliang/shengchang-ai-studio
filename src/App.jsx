import { useEffect, useMemo, useRef, useState } from 'react';
import { AppRail } from './components/AppRail';
import { PlayerBar } from './components/PlayerBar';
import { Toast } from './components/Toast';
import { TopBar } from './components/TopBar';
import { Inspector } from './components/studio/Inspector';
import { SceneCanvas } from './components/studio/SceneCanvas';
import { SceneSidebar } from './components/studio/SceneSidebar';
import { QualityView } from './components/views/QualityView';
import { SettingsView } from './components/views/SettingsView';
import { SoundsView } from './components/views/SoundsView';
import { VoicesView } from './components/views/VoicesView';
import { ProductionView } from './components/views/ProductionView';
import { api, waitForTask } from './lib/api';

const EMPTY_STATE = { scenes: [], assets: [], characters: [], voiceMap: {} };

function downloadMedia(url, name) {
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; document.body.appendChild(anchor); anchor.click(); anchor.remove();
}

function App() {
  const [view, setView] = useState('studio');
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState(null);
  const [currentSceneId, setCurrentSceneId] = useState(null);
  const [selectedLineId, setSelectedLineId] = useState(null);
  const [requestedLineId, setRequestedLineId] = useState(null);
  const [reviewToken, setReviewToken] = useState(0);
  const [toast, setToast] = useState('');
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [taskRefreshToken, setTaskRefreshToken] = useState(0);
  const [mediaReport, setMediaReport] = useState(null);
  const saveTimer = useRef(null);
  const pendingSave = useRef(null);

  const commitPendingSave = async () => {
    window.clearTimeout(saveTimer.current);
    const pending = pendingSave.current;
    if (!pending) return null;
    pendingSave.current = null;
    const saved = await api.saveProject(pending.projectId, { state: pending.state });
    setProject((current) => current?.id === saved.id ? saved : current);
    return saved;
  };

  const state = project?.state || EMPTY_STATE;
  const scenes = state.scenes || [];
  const currentScene = useMemo(() => scenes.find((scene) => scene.id === currentSceneId) || scenes[0] || null, [scenes, currentSceneId]);
  const selectedLine = useMemo(() => currentScene?.lines.find((line) => line.id === selectedLineId) || currentScene?.lines[0] || null, [currentScene, selectedLineId]);
  const generatedClips = useMemo(() => currentScene?.lines.filter((line) => line.audioUrl) || [], [currentScene]);

  const refreshProjects = async (preferredId) => {
    await commitPendingSave();
    const listing = await api.listProjects();
    setProjects(listing.projects);
    const targetId = preferredId || project?.id || listing.projects[0]?.id;
    if (!targetId) return null;
    const loaded = await api.getProject(targetId);
    setProject(loaded);
    const firstScene = loaded.state.scenes?.[0];
    setCurrentSceneId((current) => loaded.state.scenes?.some((scene) => scene.id === current) ? current : firstScene?.id || null);
    setSelectedLineId((current) => firstScene?.lines.some((line) => line.id === current) ? current : firstScene?.lines.find((line) => line.type === 'dialogue')?.id || firstScene?.lines[0]?.id || null);
    return loaded;
  };

  useEffect(() => {
    Promise.all([api.getConfig(), api.listProjects()]).then(async ([savedConfig, listing]) => {
      setConfig(savedConfig); setProjects(listing.projects);
      if (listing.projects[0]) await refreshProjects(listing.projects[0].id);
    }).catch((error) => setToast(error.message)).finally(() => setLoading(false));
  }, []);
  // Probing every file with ffprobe is expensive, so only re-run the report
  // when the set of audio files actually changes — not on every autosave.
  const audioSignature = useMemo(() => (state.scenes || [])
    .map((scene) => (scene.lines || []).map((line) => line.audioUrl || line.assetUrl || '').join(','))
    .join('|'), [state.scenes]);
  useEffect(() => {
    if (!project?.id) { setMediaReport(null); return undefined; }
    let active = true;
    api.getMediaReport(project.id).then((report) => { if (active) setMediaReport(report); }).catch((error) => { if (active) setToast(error.message); });
    return () => { active = false; };
  }, [project?.id, audioSignature]);
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(''), 3800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const persistState = (nextState) => {
    if (!project) return;
    // Only novel analysis rewrites the whole scene tree, so only it has to block
    // editing. Generation writes audio fields the server now owns, so editing
    // during a generation is safe.
    if (analysis) { setToast('小说拆解完成或取消后再修改项目'); return; }
    const optimistic = { ...project, state: nextState };
    setProject(optimistic);
    pendingSave.current = { projectId: project.id, state: nextState };
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => commitPendingSave().catch((error) => setToast(error.message)), 450);
  };
  // Changing the text does not delete the clip; the server flags it stale so the
  // old audio stays auditionable until it is regenerated.
  const updateLine = (lineId, patch) => persistState({ ...state, scenes: scenes.map((scene) => scene.id !== currentScene.id ? scene : { ...scene, status: 'draft', lines: scene.lines.map((line) => line.id === lineId ? { ...line, ...patch } : line) }) });
  const changeScene = (sceneId) => { const scene = scenes.find((item) => item.id === sceneId); setCurrentSceneId(sceneId); setSelectedLineId(scene.lines.find((line) => line.type === 'dialogue')?.id || scene.lines[0]?.id || null); };
  const selectProject = async (projectId) => { setLoading(true); try { await refreshProjects(projectId); setView('studio'); } catch (error) { setToast(error.message); } finally { setLoading(false); } };
  const createProject = async () => {
    const name = window.prompt('作品名称');
    if (!name?.trim()) return;
    try { const created = await api.createProject({ name: name.trim() }); await refreshProjects(created.id); setView('studio'); setToast(`已创建作品：${created.name}`); }
    catch (error) { setToast(error.message); }
  };

  const ensureVoiceConfigured = () => {
    if (!config || config.provider === 'unavailable') { setToast('本地模型服务未启动'); return false; }
    if (config.provider !== 'demo' && !config.hasAccessKey) { setView('settings'); setToast('请先配置真实语音模型凭证'); return false; }
    return true;
  };
  const generationRequest = (line) => ({ lineId: line.id, speakerId: line.speakerId, voiceId: state.voiceMap?.[line.speakerId] || '', text: line.text, subtext: line.subtext || '', emotion: line.emotion, emotionScale: Math.max(0.1, (line.intensity || 40) / 100), speed: (line.pace || 90) / 100, distance: line.distance || '' });
  const runGeneration = async (requests, kind = 'scene') => {
    if (!project || !currentScene || !ensureVoiceConfigured() || generation) return;
    if (!requests.length) { setToast('当前场景没有可生成的对白'); return; }
    const missingVoices = [...new Set(requests.filter((request) => !request.voiceId).map((request) => request.speakerId))];
    if (missingVoices.length) { setView('voices'); setToast(`有 ${missingVoices.length} 个角色尚未绑定 voice_id`); return; }
    try {
      setGeneration({ progress: 1, message: '正在创建持久任务' });
      await commitPendingSave();
      const task = await api.generate({ projectId: project.id, sceneId: currentScene.id, kind, requests });
      setGeneration({ progress: task.progress || 1, message: task.message, taskId: task.id });
      const completed = await waitForTask(task.id, (taskState) => setGeneration({ progress: taskState.progress, message: taskState.message, taskId: task.id }));
      await refreshProjects(project.id);
      setToast(`${completed.message}，${completed.result?.results?.length || 0} 句可用`);
      if (kind === 'line') setRequestedLineId(requests[0].lineId);
    } catch (error) { setToast(error.message); }
    finally { setGeneration(null); }
  };
  const generateScene = () => runGeneration(currentScene?.lines.filter((line) => line.type === 'dialogue').map(generationRequest) || []);
  const regenerateLine = (line) => runGeneration([generationRequest(line)], 'line');
  // Shared by "fill in missing" and "regenerate stale": same batch pipeline, only
  // the line predicate and the wording differ.
  const generateBatch = async ({ sceneIds = [], selects, kind, emptyMessage, doneMessage }) => {
    if (!project || generation || !ensureVoiceConfigured()) return;
    const targets = scenes.filter((scene) => !sceneIds.length || sceneIds.includes(scene.id));
    const requests = targets.flatMap((scene) => scene.lines
      .filter((line) => line.type === 'dialogue' && selects(line))
      .map((line) => ({ ...generationRequest(line), sceneId: scene.id })));
    if (!requests.length) { setToast(emptyMessage); return; }
    const missingVoices = [...new Set(requests.filter((request) => !request.voiceId).map((request) => request.speakerId))];
    if (missingVoices.length) { setView('voices'); setToast(`有 ${missingVoices.length} 个角色尚未绑定 voice_id`); return; }
    try {
      setGeneration({ progress: 1, message: `正在创建 ${requests.length} 句生成任务` });
      await commitPendingSave();
      const task = await api.generate({ projectId: project.id, kind, requests });
      setGeneration({ progress: task.progress || 1, message: task.message, taskId: task.id });
      const completed = await waitForTask(task.id, (taskState) => setGeneration({ progress: taskState.progress, message: taskState.message, taskId: task.id }));
      await refreshProjects(project.id);
      setTaskRefreshToken(Date.now());
      setToast(doneMessage(completed.result?.results?.length || 0));
    } catch (error) { setToast(error.message); }
    finally { setGeneration(null); }
  };
  const generateMissingDialogue = (sceneIds = []) => generateBatch({ sceneIds, selects: (line) => !line.audioUrl, kind: 'batch-missing', emptyMessage: '没有需要生成的缺失对白', doneMessage: (count) => `已补全 ${count} 句对白` });
  const regenerateStaleDialogue = (sceneIds = []) => generateBatch({ sceneIds, selects: (line) => line.audioUrl && line.audioStale, kind: 'batch-stale', emptyMessage: '没有需要重新生成的过期对白', doneMessage: (count) => `已重新生成 ${count} 句对白` });
  const playLine = (line) => { const url = line.audioUrl || line.assetUrl; if (!url) setToast('请先生成或绑定实际音频'); else if (line.type === 'dialogue') { setRequestedLineId(null); window.setTimeout(() => setRequestedLineId(line.id), 0); } else new Audio(url).play().catch(() => setToast('素材无法播放')); };

  const importNovel = () => {
    if (!project) return;
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.txt,text/plain';
    input.onchange = async () => {
      const file = input.files?.[0]; if (!file) return;
      try {
        const text = await file.text();
        setAnalysis({ progress: 1, message: '正在上传小说原文' });
        await commitPendingSave();
        const task = await api.analyzeNovel(project.id, { text, filename: file.name, name: project.name });
        setAnalysis({ progress: task.progress || 1, message: task.message, taskId: task.id });
        // The server chunks at 24k chars with up to 3 minutes per chunk; a
        // 2M-character import needs far more than the default 30-minute wait.
        const chunkCount = Math.max(1, Math.ceil(text.length / 24000));
        const completed = await waitForTask(task.id, (taskState) => setAnalysis({ progress: taskState.progress, message: taskState.message, taskId: task.id }), { timeoutMs: chunkCount * 3.5 * 60 * 1000 });
        await refreshProjects(project.id);
        setToast(`小说拆解完成：${completed.result.sceneCount} 个场景，${completed.result.characterCount} 个角色`);
      } catch (error) { setToast(error.message); }
      finally { setAnalysis(null); }
    };
    input.click();
  };
  const saveConfig = async (draft) => { const saved = await api.saveConfig(draft); setConfig(saved); return saved; };
  const designVoice = async (input) => {
    const result = await api.designVoice(input);
    persistState({ ...state, voiceMap: { ...(state.voiceMap || {}), [input.characterId]: result.voiceId } });
    return result;
  };
  const setVoice = (characterId, voiceId) => persistState({ ...state, voiceMap: { ...(state.voiceMap || {}), [characterId]: voiceId } });
  const saveVoiceDesignConfig = async (patch) => {
    const saved = await api.saveConfig({ ...config, ...patch });
    setConfig(saved);
    return saved;
  };
  const updateDictionary = (pronunciationDictionary) => persistState({ ...state, pronunciationDictionary });
  const uploadAsset = async (file) => { const uploaded = await api.uploadAsset(file); const asset = { ...uploaded, category: '音乐', tags: ['本地导入'], color: '#7ed6b2', duration: '—' }; persistState({ ...state, assets: [asset, ...(state.assets || [])] }); return asset; };
  const SOUND_EVENT_LABELS = { music: '背景音乐', ambient: '环境声', sfx: '动作音效' };
  const SOUND_EVENT_PLACEHOLDERS = { music: '描述需要的音乐氛围', ambient: '描述需要的环境声音', sfx: '描述需要的动作音效' };
  const addLine = (type) => {
    if (!currentScene) return;
    const id = crypto.randomUUID();
    const line = type === 'dialogue'
      ? { id, type, speaker: '旁白', speakerId: 'narrator', text: '输入新的旁白或对白', subtext: '按当前剧情上下文表达。', emotion: '克制', intensity: 40, pace: 90, distance: '近讲', delivery: '克制 40% · 语速 0.90' }
      : { id, type, label: SOUND_EVENT_LABELS[type] || '声音事件', text: SOUND_EVENT_PLACEHOLDERS[type] || '描述需要的声音', time: '待编排' };
    persistState({ ...state, scenes: scenes.map((scene) => scene.id === currentScene.id ? { ...scene, status: 'draft', lines: [...scene.lines, line] } : scene) });
    setSelectedLineId(id);
  };
  const deleteLine = (lineId) => {
    if (!currentScene) return;
    const line = currentScene.lines.find((item) => item.id === lineId);
    if (!line) return;
    // Losing generated audio is the expensive part, so only confirm when there is
    // some. Plain text lines delete immediately and stay undoable by re-adding.
    if ((line.audioUrl || line.assetUrl) && !window.confirm(`删除「${line.speaker || line.label || '这条事件'}」？已生成的音频会一并移除。`)) return;
    const remaining = currentScene.lines.filter((item) => item.id !== lineId);
    persistState({ ...state, scenes: scenes.map((scene) => scene.id === currentScene.id ? { ...scene, status: 'draft', lines: remaining } : scene) });
    if (selectedLineId === lineId) setSelectedLineId(remaining.find((item) => item.type === 'dialogue')?.id || remaining[0]?.id || null);
  };
  const addScene = () => {
    const title = window.prompt('新场景标题');
    if (!title?.trim()) return;
    const id = crypto.randomUUID();
    const scene = { id, number: String(scenes.length + 1).padStart(2, '0'), title: title.trim(), duration: '待生成', cast: '旁白', status: 'pending', location: '待设定', mood: '待导演', synopsis: '', arc: [12, 18, 24, 31, 38, 44, 36, 29], lines: [] };
    persistState({ ...state, scenes: [...scenes, scene] });
    setCurrentSceneId(id);
    setSelectedLineId(null);
  };
  const deleteScene = (sceneId) => {
    const scene = scenes.find((item) => item.id === sceneId);
    if (!scene) return;
    const voiced = scene.lines.filter((line) => line.audioUrl).length;
    if (!window.confirm(`删除场景「${scene.title}」？${voiced ? `其中 ${voiced} 句已生成的音频会一并移除。` : ''}此操作不可撤销。`)) return;
    const remaining = scenes.filter((item) => item.id !== sceneId).map((item, index) => ({ ...item, number: String(index + 1).padStart(2, '0') }));
    persistState({ ...state, scenes: remaining });
    if (currentSceneId === sceneId) { setCurrentSceneId(remaining[0]?.id || null); setSelectedLineId(null); }
  };
  const deleteAsset = (asset) => {
    const usedBy = scenes.flatMap((scene) => scene.lines.filter((line) => line.assetId === asset.id).map((line) => scene.title));
    if (!window.confirm(usedBy.length ? `「${asset.name}」正被 ${usedBy.length} 个声音事件使用，删除后这些事件会失去绑定。继续？` : `删除素材「${asset.name}」？`)) return;
    persistState({
      ...state,
      assets: (state.assets || []).filter((item) => item.id !== asset.id),
      scenes: scenes.map((scene) => ({ ...scene, lines: scene.lines.map((line) => line.assetId === asset.id ? { ...line, assetUrl: undefined, assetName: undefined, assetId: undefined } : line) })),
    });
  };
  const updateAsset = (assetId, patch) => persistState({ ...state, assets: (state.assets || []).map((item) => (item.id === assetId ? { ...item, ...patch } : item)) });
  const assetUsage = useMemo(() => {
    const counts = {};
    for (const scene of scenes) for (const line of scene.lines || []) if (line.assetId) counts[line.assetId] = (counts[line.assetId] || 0) + 1;
    return counts;
  }, [scenes]);
  const cancelActiveTask = async () => {
    const active = analysis || generation;
    if (!active?.taskId) return;
    // No confirmation toast here: the task watcher surfaces "任务已取消" once
    // the server actually stops it.
    try { await api.cancelTask(active.taskId); }
    catch (error) { setToast(error.message); }
  };
  const bindAsset = (asset, line) => { updateLine(line.id, { assetUrl: asset.url, assetName: asset.name, assetId: asset.id }); setToast(`已将「${asset.name}」绑定到「${line.text?.slice(0, 18) || line.label}」`); };
  const exportSceneById = async (sceneId = currentScene?.id) => {
    const scene = scenes.find((item) => item.id === sceneId);
    if (!scene?.lines.some((line) => line.type === 'dialogue' && line.audioUrl)) { setToast('当前场景没有已生成的对白'); return; }
    setExporting(true);
    try { await commitPendingSave(); const result = await api.exportScene(project.id, scene.id); downloadMedia(result.url, result.name); setToast(`本场已渲染：${formatDuration(result.durationMs)} · ${result.trackCount} 条轨道`); }
    catch (error) { setToast(error.message); } finally { setExporting(false); }
  };
  const exportEpisode = async () => {
    if (!scenes.some((scene) => scene.lines.some((line) => line.type === 'dialogue' && line.audioUrl))) { setToast('整部作品还没有可导出的对白音频'); return; }
    setExporting(true);
    try {
      await commitPendingSave();
      const task = await api.exportEpisode(project.id);
      setTaskRefreshToken(Date.now());
      let lastShown = -1;
      const completed = await waitForTask(task.id, (taskState) => { if (taskState.progress !== lastShown) { lastShown = taskState.progress; setToast(`${taskState.message} · ${taskState.progress}%`); } setTaskRefreshToken(taskState.progress); });
      downloadMedia(completed.result.url, completed.result.name);
      setToast(`整集已导出：${completed.result.sceneCount} 场 · ${formatDuration(completed.result.durationMs)}`);
    } catch (error) { setToast(error.message); }
    finally { setExporting(false); setTaskRefreshToken(Date.now()); }
  };

  const qualityReport = useMemo(() => {
    if (!currentScene) return { score: 0, metrics: { coverage: 0, voices: 0, soundWorld: 0, text: 0 }, issues: [], passed: [], canExport: false };
    const dialogue = currentScene.lines.filter((line) => line.type === 'dialogue'); const voiced = dialogue.filter((line) => line.audioUrl); const speakers = [...new Set(dialogue.map((line) => line.speakerId))]; const mapped = speakers.filter((id) => state.voiceMap?.[id]); const sounds = currentScene.lines.filter((line) => line.type !== 'dialogue'); const bound = sounds.filter((line) => line.assetUrl);
    const sceneMedia = mediaReport?.scenes?.find((item) => item.sceneId === currentScene.id);
    const stale = voiced.filter((line) => line.audioStale);
    const healthy = sceneMedia?.healthyDialogueCount ?? voiced.length;
    const invalid = sceneMedia?.invalidFileCount ?? 0;
    const metrics = { coverage: dialogue.length ? Math.round(voiced.length / dialogue.length * 100) : 0, voices: speakers.length ? Math.round(mapped.length / speakers.length * 100) : 100, soundWorld: sounds.length ? Math.round(bound.length / sounds.length * 100) : 100, text: dialogue.every((line) => line.text?.trim()) ? 100 : 0, media: voiced.length ? Math.min(100, Math.max(0, Math.round((healthy - stale.length) / voiced.length * 100))) : 100 };
    const issues = []; if (metrics.coverage < 100) issues.push({ id: 'coverage', level: 'warning', title: '存在未生成的对白', scope: `${voiced.length} / ${dialogue.length} 句`, detail: '未生成的对白不会进入成片。', action: '返回生成', actionMessage: '请在场景导演生成对白' }); if (metrics.voices < 100) issues.push({ id: 'voices', level: 'warning', title: '角色未绑定真实音色', scope: `${mapped.length} / ${speakers.length} 个角色`, detail: '缺少 voice_id 会破坏人物一致性。', action: '配置音色', actionMessage: '请到角色音色页配置' }); if (metrics.soundWorld < 100) issues.push({ id: 'sounds', level: 'info', title: '声音事件尚未绑定素材', scope: `${bound.length} / ${sounds.length} 个事件`, detail: '未绑定的声音事件不会进入混音。', action: '绑定素材', actionMessage: '请到声音素材页处理' });
    if (invalid) issues.push({ id: 'media', level: 'warning', title: '存在无法解码的音频文件', scope: `${invalid} 个文件`, detail: '请重新生成对白或重新导入声音素材后再导出。', action: '查看制作', actionMessage: '制作中心已标出异常文件' });
    if (stale.length) issues.push({ id: 'stale', level: 'warning', title: '台词改动后音频未重新生成', scope: `${stale.length} 句`, detail: '这些句子会用旧音频进入成片，与当前台词不一致。', action: '重新生成', actionMessage: '请重新生成这些对白' });
    const passed = []; if (metrics.coverage === 100 && !stale.length) passed.push({ id: 'coverage-ok', level: 'passed', title: '对白音频覆盖完整', scope: `${dialogue.length} 句`, detail: '每条对白均已关联与当前台词一致的音频。', action: '查看场景', actionMessage: '检查通过' }); if (metrics.text === 100) passed.push({ id: 'text-ok', level: 'passed', title: '文本可合成性通过', scope: '当前场景', detail: '没有空白台词。', action: '查看报告', actionMessage: '检查通过' }); if (metrics.media === 100 && voiced.length) passed.push({ id: 'media-ok', level: 'passed', title: '音频文件健康', scope: `${healthy} 个文件`, detail: sceneMedia ? `可解码，合计 ${formatDuration(sceneMedia.durationMs)}。` : '音频文件可正常读取。', action: '查看制作', actionMessage: '检查通过' });
    return { metrics, issues, passed, score: Math.round(metrics.coverage * .35 + metrics.voices * .22 + metrics.soundWorld * .18 + metrics.text * .1 + metrics.media * .15), canExport: voiced.length > 0 && invalid === 0 };
  }, [currentScene, state.voiceMap, config, mediaReport]);

  if (loading || !project) return <div className="app-shell"><AppRail view={view} onViewChange={setView} /><div className="app-loading">正在打开本地项目数据库</div><Toast message={toast} /></div>;
  const activeProgress = analysis || generation;
  let content;
  if (view === 'studio') content = currentScene ? <div className="studio-layout"><SceneSidebar project={project} scenes={scenes} currentSceneId={currentSceneId} mediaReport={mediaReport} onSceneChange={changeScene} onImportNovel={importNovel} onAddScene={addScene} onDeleteScene={deleteScene} /><SceneCanvas scene={currentScene} durationMs={mediaReport?.scenes?.find((item) => item.sceneId === currentScene.id)?.durationMs} sourceText={project.sourceText} characters={state.characters || []} selectedLineId={selectedLineId} onSelectLine={setSelectedLineId} onUpdateLine={updateLine} onRegenerate={regenerateLine} onPlayLine={playLine} onAddLine={addLine} onDeleteLine={deleteLine} generationProgress={activeProgress?.progress ?? null} generationMessage={activeProgress?.message} onCancelTask={cancelActiveTask} /><Inspector line={selectedLine} characters={state.characters || []} voiceMap={state.voiceMap || {}} provider={config?.provider} onUpdate={(patch) => updateLine(selectedLine.id, patch)} onOpenVoices={() => setView('voices')} /></div> : <div className="empty-project"><h2>{project.name}</h2><p>{analysis ? `${analysis.message} · ${analysis.progress}%` : '还没有场景。导入 TXT 小说后，文本模型会识别角色、对白、旁白、声音事件和场景结构。'}</p>{analysis ? <button className="button secondary-button" type="button" onClick={cancelActiveTask}>取消拆解</button> : <><button className="button primary-button" type="button" onClick={importNovel}>导入小说并拆解</button><button className="button secondary-button" type="button" onClick={addScene}>手动新建场景</button></>}</div>;
  else if (view === 'voices') content = <VoicesView characters={state.characters || []} voiceMap={state.voiceMap || {}} voiceDesignConfig={config} onDesignVoice={designVoice} onSetVoice={setVoice} onToast={setToast} />;
  else if (view === 'sounds') content = <SoundsView assets={state.assets || []} sceneUsage={assetUsage} sceneEvents={(currentScene?.lines || []).filter((line) => line.type !== 'dialogue')} sceneTitle={currentScene?.title || ''} onUpload={uploadAsset} onBindAsset={bindAsset} onDeleteAsset={deleteAsset} onUpdateAsset={updateAsset} onToast={setToast} />;
  else if (view === 'production') content = <ProductionView project={project} mediaReport={mediaReport} currentSceneId={currentSceneId} onSceneChange={changeScene} onUpdateLine={updateLine} onUpdateDictionary={updateDictionary} onExportScene={exportSceneById} onExportEpisode={exportEpisode} onGenerateMissing={generateMissingDialogue} generating={Boolean(generation)} exporting={exporting} taskRefreshToken={taskRefreshToken} onToast={setToast} />;
  else if (view === 'quality') content = <QualityView report={qualityReport} onToast={setToast} onExport={() => exportSceneById(currentScene?.id)} onOpenProduction={() => setView('production')} onGenerateMissing={() => generateMissingDialogue([currentScene?.id])} onRegenerateStale={() => regenerateStaleDialogue([currentScene?.id])} generating={Boolean(generation)} exporting={exporting} />;
  else content = <SettingsView config={config} loading={false} onSave={saveConfig} onTestLlm={api.testLlm} onToast={setToast} />;

  return <div className="app-shell"><AppRail view={view} onViewChange={setView} /><TopBar view={view} project={project} currentScene={currentScene} projects={projects} onSelectProject={selectProject} onCreateProject={createProject} onGenerate={generateScene} onReview={() => setReviewToken(Date.now())} onImportNovel={importNovel} generating={Boolean(activeProgress)} canReview={generatedClips.length > 0} /><div className="app-content">{content}</div>{view === 'studio' && currentScene ? <PlayerBar scene={currentScene} requestedLineId={requestedLineId} reviewToken={reviewToken} onOpenMix={() => setView('production')} onExport={() => exportSceneById(currentScene.id)} exporting={exporting} /> : null}<Toast message={toast} /></div>;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round((milliseconds || 0) / 1000));
  return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`;
}

export default App;

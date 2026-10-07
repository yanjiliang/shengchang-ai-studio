import { useEffect, useMemo, useRef, useState } from 'react';
import { AppRail } from './components/AppRail';
import { BrandSignature } from './components/BrandSignature';
import { Dialog } from './components/Dialog';
import { PlayerBar } from './components/PlayerBar';
import { Toast } from './components/Toast';
import { TopBar } from './components/TopBar';
import { Inspector } from './components/studio/Inspector';
import { SceneCanvas } from './components/studio/SceneCanvas';
import { SceneSidebar } from './components/studio/SceneSidebar';
import { SoundPicker } from './components/studio/SoundPicker';
import { QualityView } from './components/views/QualityView';
import { SettingsView } from './components/views/SettingsView';
import { SoundsView } from './components/views/SoundsView';
import { VoicesView } from './components/views/VoicesView';
import { ProductionView } from './components/views/ProductionView';
import { api, waitForTask } from './lib/api';
import { formatDuration, qualityReport as buildQualityReport, stageProgress as buildStageProgress } from './lib/quality';
import { buildGenerationRequest } from '../shared/generation-requests.mjs';

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
  // Built-in CC0 library (shared, read-only) + the sound-event picker state:
  // one entry point for recommendations / builtin / generation / upload.
  const [builtinAssets, setBuiltinAssets] = useState([]);
  const [pickerLine, setPickerLine] = useState(null);
  // Direction-lab (Approach C): the latest A/B/C take results for audition in
  // the Inspector. Keyed by lineId; a take's audio lives in the cache, never
  // on the line itself.
  const [labResult, setLabResult] = useState(null);
  // Real save indicator: 'saved' | 'pending' | 'error' — the TopBar badge
  // mirrors the 450ms debounce queue instead of claiming success forever.
  const [saveState, setSaveState] = useState('saved');
  const saveTimer = useRef(null);
  const pendingSave = useRef(null);
  // Promise-based prompt/confirm: replaces every window.prompt / window.confirm
  // call site; resolving (or dismissing) the dialog settles the awaiting flow.
  const [dialog, setDialog] = useState(null);
  const openDialog = (request) => new Promise((resolve) => setDialog({ ...request, resolve }));
  const closeDialog = (value) => { dialog?.resolve(value); setDialog(null); };

  const commitPendingSave = async () => {
    window.clearTimeout(saveTimer.current);
    const pending = pendingSave.current;
    if (!pending) return null;
    pendingSave.current = null;
    try {
      const saved = await api.saveProject(pending.projectId, { state: pending.state });
      setProject((current) => current?.id === saved.id ? saved : current);
      setSaveState('saved');
      return saved;
    } catch (error) {
      // Put the state back so the next flush (or any generation/export)
      // retries instead of silently dropping the edit.
      pendingSave.current = pending;
      setSaveState('error');
      throw error;
    }
  };

  const state = project?.state || EMPTY_STATE;
  const scenes = state.scenes || [];
  const currentScene = useMemo(() => scenes.find((scene) => scene.id === currentSceneId) || scenes[0] || null, [scenes, currentSceneId]);
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
    // Best-effort: a missing builtin library degrades the picker's builtin
    // tab, nothing else.
    api.builtinAssets().then((payload) => setBuiltinAssets(payload.assets)).catch(() => setBuiltinAssets([]));
  }, []);
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
    setSaveState('pending');
    pendingSave.current = { projectId: project.id, state: nextState };
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => commitPendingSave().catch((error) => setToast(error.message)), 450);
  };
  // Changing the text does not delete the clip; the server flags it stale so the
  // old audio stays auditionable until it is regenerated.
  const updateLine = (lineId, patch) => persistState({ ...state, scenes: scenes.map((scene) => scene.id !== currentScene.id ? scene : { ...scene, status: 'draft', lines: scene.lines.map((line) => line.id === lineId ? { ...line, ...patch } : line) }) });
  const updateScene = (sceneId, patch) => persistState({ ...state, scenes: scenes.map((scene) => scene.id !== sceneId ? scene : { ...scene, ...patch, status: 'draft' }) });
  const changeScene = (sceneId) => { const scene = scenes.find((item) => item.id === sceneId); setCurrentSceneId(sceneId); setSelectedLineId(scene.lines.find((line) => line.type === 'dialogue')?.id || scene.lines[0]?.id || null); };
  const selectProject = async (projectId) => { setLoading(true); try { await refreshProjects(projectId); setView('studio'); } catch (error) { setToast(error.message); } finally { setLoading(false); } };
  const createProject = async () => {
    const name = await openDialog({ type: 'prompt', message: '作品名称' });
    if (!name?.trim()) return;
    try { const created = await api.createProject({ name: name.trim() }); await refreshProjects(created.id); setView('studio'); setToast(`已创建作品：${created.name}`); }
    catch (error) { setToast(error.message); }
  };

  const ensureVoiceConfigured = () => {
    if (!config || config.provider === 'unavailable') { setToast('本地模型服务未启动'); return false; }
    if (config.provider !== 'demo' && !config.hasAccessKey) { setView('settings'); setToast('请先配置真实语音模型凭证'); return false; }
    return true;
  };
  const generationRequest = (line) => buildGenerationRequest(line, state.voiceMap);
  // Shared pipeline for every generation entry point (scene / line / batch
  // fill / batch stale): guard, enqueue one persistent task, watch it, then
  // refresh. Server-side B3's runGenerationRequests is the other half of this
  // contract - both manual and future orchestrated flows converge here.
  const runGenerationTask = async ({ kind, requests, sceneId, buildingMessage, doneMessage }) => {
    if (!project || generation || !ensureVoiceConfigured()) return false;
    const missingVoices = [...new Set(requests.filter((request) => !request.voiceId).map((request) => request.speakerId))];
    if (missingVoices.length) { setView('voices'); setToast(`有 ${missingVoices.length} 个角色尚未绑定 voice_id`); return false; }
    try {
      setGeneration({ progress: 1, message: buildingMessage(requests.length) });
      await commitPendingSave();
      const task = await api.generate({ projectId: project.id, sceneId, kind, requests });
      setGeneration({ progress: task.progress || 1, message: task.message, taskId: task.id });
      const completed = await waitForTask(task.id, (taskState) => setGeneration({ progress: taskState.progress, message: taskState.message, taskId: task.id }));
      await refreshProjects(project.id);
      setTaskRefreshToken(Date.now());
      const failureCount = completed.result?.failures?.length || 0;
      const note = failureCount ? `，${failureCount} 句失败（任务历史可逐句查看）` : '';
      setToast(`${doneMessage(completed)}${note}`);
      return true;
    } catch (error) { setToast(error.message); return false; }
    finally { setGeneration(null); }
  };
  const generateScene = () => {
    const requests = currentScene?.lines.filter((line) => line.type === 'dialogue').map(generationRequest) || [];
    if (!requests.length) { setToast('当前场景没有可生成的对白'); return; }
    runGenerationTask({ kind: 'scene', requests, sceneId: currentScene.id, buildingMessage: () => '正在创建持久任务', doneMessage: (completed) => `${completed.message}，${completed.result?.results?.length || 0} 句可用` });
  };
  const regenerateLine = async (line) => {
    const ok = await runGenerationTask({ kind: 'line', requests: [generationRequest(line)], sceneId: currentScene?.id, buildingMessage: () => '正在创建持久任务', doneMessage: (completed) => completed.message });
    if (ok) setRequestedLineId(line.id);
  };
  // Direction lab (Approach C): render the SAME line under N direction takes.
  // Server kind 'direction-lab' skips the project writeback, so the line keeps
  // its current audio; every take lands in the cache keyed by its direction
  // params, making "apply take → regenerate" an instant cache hit.
  const runDirectionLab = async (line, variants) => {
    if (!project || generation || !ensureVoiceConfigured()) return;
    const base = generationRequest(line);
    if (!base.voiceId) { setView('voices'); setToast('该角色尚未绑定 voice_id，先在角色音色页配置'); return; }
    try {
      setGeneration({ progress: 1, message: `正在生成 ${variants.length} 组方向对比` });
      await commitPendingSave();
      const requests = variants.map((variant) => ({
        ...base,
        emotion: variant.emotion,
        emotionScale: Math.max(0.1, (variant.intensity || 40) / 100),
        subtext: variant.subtext || '',
        distance: variant.distance || '',
      }));
      const task = await api.generate({ projectId: project.id, sceneId: currentScene?.id, kind: 'direction-lab', requests });
      const completed = await waitForTask(task.id, (taskState) => setGeneration({ progress: taskState.progress, message: taskState.message, taskId: task.id }));
      setLabResult({ lineId: line.id, results: completed.result?.results || [] });
      setToast('方向对比已生成，可在检查器逐组试听');
    } catch (error) { setToast(error.message); }
    finally { setGeneration(null); }
  };
  // Shared by "fill in missing" and "regenerate stale": same batch pipeline, only
  // the line predicate and the wording differ.
  const generateBatch = ({ sceneIds = [], selects, kind, emptyMessage, doneMessage }) => {
    const targets = scenes.filter((scene) => !sceneIds.length || sceneIds.includes(scene.id));
    const requests = targets.flatMap((scene) => scene.lines
      .filter((line) => line.type === 'dialogue' && selects(line))
      .map((line) => ({ ...generationRequest(line), sceneId: scene.id })));
    if (!requests.length) { setToast(emptyMessage); return; }
    runGenerationTask({ kind, requests, buildingMessage: (count) => `正在创建 ${count} 句生成任务`, doneMessage: (completed) => doneMessage(completed.result?.results?.length || 0) });
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
        setToast(`小说拆解完成${completed.result.breakdown === 'heuristic' ? '（规则拆解，建议人工校对角色归属）' : ''}：${completed.result.sceneCount} 个场景，${completed.result.characterCount} 个角色`);
      } catch (error) { setToast(error.message); }
      finally { setAnalysis(null); }
    };
    input.click();
  };
  const saveConfig = async (draft) => { const saved = await api.saveConfig(draft); setConfig(saved); return saved; };
  const reloadConfig = async () => { try { setConfig(await api.getConfig()); } catch (error) { setToast(error.message); } };
  const designVoice = async (input) => {
    const result = await api.designVoice(input);
    persistState({ ...state, voiceMap: { ...(state.voiceMap || {}), [input.characterId]: result.voiceId } });
    return result;
  };
  const setVoice = (characterId, voiceId) => persistState({ ...state, voiceMap: { ...(state.voiceMap || {}), [characterId]: voiceId } });
  const updateDictionary = (pronunciationDictionary) => persistState({ ...state, pronunciationDictionary });
  // The server probes the uploaded file with ffprobe; a null duration means
  // the file could not be read and the library honestly shows "—".
  const uploadAsset = async (file) => { const uploaded = await api.uploadAsset(file); const asset = { ...uploaded, category: '音乐', tags: ['本地导入'], color: '#7ed6b2', duration: uploaded.durationMs ? formatDuration(uploaded.durationMs) : '—' }; persistState({ ...state, assets: [asset, ...(state.assets || [])] }); return asset; };
  const SOUND_EVENT_LABELS = { music: '背景音乐', ambient: '环境声', sfx: '动作音效' };
  const SOUND_EVENT_PLACEHOLDERS = { music: '描述需要的音乐氛围', ambient: '描述需要的环境声音', sfx: '描述需要的动作音效' };
  const addLine = (type) => {
    if (!currentScene) return;
    const id = crypto.randomUUID();
    const line = type === 'dialogue'
      ? { id, type, speaker: '旁白', speakerId: 'narrator', text: '输入新的旁白或对白', subtext: '按当前剧情上下文表达。', emotion: '克制', intensity: 40, pace: 90, distance: '近讲' }
      : { id, type, label: SOUND_EVENT_LABELS[type] || '声音事件', text: SOUND_EVENT_PLACEHOLDERS[type] || '描述需要的声音' };
    persistState({ ...state, scenes: scenes.map((scene) => scene.id === currentScene.id ? { ...scene, status: 'draft', lines: [...scene.lines, line] } : scene) });
    setSelectedLineId(id);
  };
  const deleteLine = async (lineId) => {
    if (!currentScene) return;
    const line = currentScene.lines.find((item) => item.id === lineId);
    if (!line) return;
    // Losing generated audio is the expensive part, so only confirm when there is
    // some. Plain text lines delete immediately and stay undoable by re-adding.
    if ((line.audioUrl || line.assetUrl) && !(await openDialog({ type: 'confirm', message: `删除「${line.speaker || line.label || '这条事件'}」？`, detail: '已生成的音频会一并移除。', confirmLabel: '删除' }))) return;
    const remaining = currentScene.lines.filter((item) => item.id !== lineId);
    persistState({ ...state, scenes: scenes.map((scene) => scene.id === currentScene.id ? { ...scene, status: 'draft', lines: remaining } : scene) });
    if (selectedLineId === lineId) setSelectedLineId(remaining.find((item) => item.type === 'dialogue')?.id || remaining[0]?.id || null);
  };
  const addScene = async () => {
    const title = await openDialog({ type: 'prompt', message: '新场景标题' });
    if (!title?.trim()) return;
    const id = crypto.randomUUID();
    const scene = { id, number: String(scenes.length + 1).padStart(2, '0'), title: title.trim(), duration: '待生成', cast: '旁白', status: 'pending', location: '', mood: '', synopsis: '', lines: [] };
    persistState({ ...state, scenes: [...scenes, scene] });
    setCurrentSceneId(id);
    setSelectedLineId(null);
  };
  const deleteScene = async (sceneId) => {
    const scene = scenes.find((item) => item.id === sceneId);
    if (!scene) return;
    const voiced = scene.lines.filter((line) => line.audioUrl).length;
    if (!(await openDialog({ type: 'confirm', message: `删除场景「${scene.title}」？`, detail: `${voiced ? `其中 ${voiced} 句已生成的音频会一并移除。` : ''}此操作不可撤销。`, confirmLabel: '删除' }))) return;
    const remaining = scenes.filter((item) => item.id !== sceneId).map((item, index) => ({ ...item, number: String(index + 1).padStart(2, '0') }));
    persistState({ ...state, scenes: remaining });
    if (currentSceneId === sceneId) { setCurrentSceneId(remaining[0]?.id || null); setSelectedLineId(null); }
  };
  // Deletion is two steps against one policy: unbind every line in the
  // project state, flush the save, then let the server remove the file only
  // if nothing still references it (another project may).
  const deleteAsset = async (asset) => {
    const usedBy = scenes.flatMap((scene) => scene.lines.filter((line) => line.assetId === asset.id).map((line) => scene.title));
    if (!(await openDialog({ type: 'confirm', message: usedBy.length ? `「${asset.name}」正被 ${usedBy.length} 个声音事件使用` : `删除素材「${asset.name}」？`, detail: usedBy.length ? '删除后这些事件会失去绑定。' : '', confirmLabel: usedBy.length ? '继续删除' : '删除' }))) return;
    persistState({
      ...state,
      assets: (state.assets || []).filter((item) => item.id !== asset.id),
      scenes: scenes.map((scene) => ({ ...scene, lines: scene.lines.map((line) => line.assetId === asset.id ? { ...line, assetUrl: undefined, assetName: undefined, assetId: undefined } : line) })),
    });
    try {
      await commitPendingSave();
      await api.deleteAsset(asset.url);
    } catch (error) { setToast(error.message); }
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
  // Archive removes the work from the list; rows stay in the local database
  // (soft delete), and countProjects still counts them so a reseed never
  // duplicates the sample into an install that simply archived everything.
  const archiveProjectById = async (target) => {
    if (!target) return;
    if ((analysis || generation) && target.id === project?.id) { setToast('当前作品有任务进行中，完成或取消后再归档'); return; }
    if (!(await openDialog({ type: 'confirm', message: `归档作品「${target.name}」？`, detail: '它会从列表移除，数据仍保留在本地数据库。', confirmLabel: '归档' }))) return;
    try {
      await commitPendingSave();
      await api.archiveProject(target.id);
      const remaining = projects.filter((item) => item.id !== target.id);
      setProjects(remaining);
      if (target.id === project?.id) {
        if (remaining.length) await refreshProjects(remaining[0].id);
        else setProject(null);
      }
      setToast(`已归档「${target.name}」`);
    } catch (error) { setToast(error.message); }
  };
  const bindAsset = (asset, line) => { updateLine(line.id, { assetUrl: asset.url, assetName: asset.name, assetId: asset.id }); setToast(`已将「${asset.name}」绑定到「${line.text?.slice(0, 18) || line.label}」`); };
  const uploadAndBind = async (file, line) => {
    const asset = await uploadAsset(file);
    bindAsset(asset, line);
    return true;
  };
  // SoundPicker 生成 tab: persistent task, then register the generated clip
  // as a project asset and bind it to the event in one write.
  const generateSound = async (line, { prompt, durationSec }) => {
    if (!project || generation) { setToast('已有任务进行中，稍后再试'); return false; }
    try {
      setGeneration({ progress: 5, message: `正在生成声音素材：${prompt.slice(0, 20)}` });
      await commitPendingSave();
      const task = await api.generate({ projectId: project.id, kind: 'sound-generate', sound: { prompt, durationMs: Math.round((durationSec || (line.type === 'sfx' ? 4 : 16)) * 1000), type: line.type } });
      const completed = await waitForTask(task.id, (taskState) => setGeneration({ progress: taskState.progress, message: taskState.message }));
      const result = completed.result;
      const asset = {
        id: `gen-${result.contentHash.slice(0, 12)}`,
        name: prompt.slice(0, 20),
        url: result.url,
        category: line.type === 'music' ? '音乐' : line.type === 'ambient' ? '环境' : '动作',
        tags: ['AI 生成'],
        color: '#8fb4ff',
        duration: formatDuration(result.durationMs),
        source: 'generated',
        license: 'AI 生成',
        prompt,
        provider: result.provider,
      };
      persistState({
        ...state,
        assets: [asset, ...(state.assets || [])],
        scenes: scenes.map((scene) => ({ ...scene, status: scene.id === currentScene?.id ? 'draft' : scene.status, lines: scene.lines.map((item) => item.id === line.id ? { ...item, assetUrl: asset.url, assetName: asset.name, assetId: asset.id } : item) })),
      });
      setToast(`声音素材已生成并绑定：${asset.name}`);
      return true;
    } catch (error) { setToast(error.message); return false; }
    finally { setGeneration(null); }
  };
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
      // Progress renders in the tasks tab; toasts stay for terminal states
      // only — a per-percent toast used to overwrite every other message.
      const completed = await waitForTask(task.id, () => setTaskRefreshToken(Date.now()));
      downloadMedia(completed.result.url, completed.result.name);
      if (completed.result.attributionUrl) downloadMedia(completed.result.attributionUrl, decodeURIComponent(completed.result.attributionUrl.split('/').pop()));
      setToast(`整集已导出：${completed.result.sceneCount} 场 · ${formatDuration(completed.result.durationMs)}`);
    } catch (error) { setToast(error.message); }
    finally { setExporting(false); setTaskRefreshToken(Date.now()); }
  };

  // §8 stage-checklist follow-up, adapted to the manual workbench (there is no
  // one-click orchestrator in this repo): project-wide readiness stages, each
  // deep-linking to the surface where it gets fixed.
  const stages = useMemo(() => buildStageProgress(scenes, state.voiceMap), [scenes, state.voiceMap]);

  // §8 attention-list deep links: jump from a quality issue straight to the
  // offending line in the studio.
  const locateLine = (lineId) => {
    const scene = scenes.find((item) => item.lines?.some((line) => line.id === lineId));
    if (!scene) return;
    setView('studio');
    setCurrentSceneId(scene.id);
    setSelectedLineId(lineId);
  };

  // 一键成片 (design B4/B5): server-backed estimate first - it predicts cache
  // hits, which the browser cannot - then confirm, enqueue, and hand the user
  // to the tasks tab where the orchestrator's progress renders (OV-8).
  const [oneClickToken, setOneClickToken] = useState(0);
  const oneClick = async () => {
    if (!project || exporting) return;
    try {
      const estimate = await api.oneClickEstimate(project.id);
      const parts = [`${estimate.sceneCount} 个场景`, `${estimate.requestCount} 句待生成`];
      if (estimate.cacheHits) parts.push(`预计缓存命中 ${estimate.cacheHits} 句`);
      const cost = estimate.provider === 'demo' ? '离线演示引擎 · 免费' : `真实语音 · 约 ${estimate.characters} 字`;
      const llmNote = estimate.needsLlm ? '\n项目还没有场景，将先拆解原文（未配置文本模型时使用规则拆解）。' : '';
      if (!(await openDialog({ type: 'confirm', message: '一键成片', detail: `${parts.join(' · ')} · ${cost}${llmNote}\n\n开始后自动执行：拆解 → 配音色 → 生成 → 体检 → 导出整集。`, confirmLabel: '开始' }))) return;
      await commitPendingSave();
      await api.oneClick(project.id);
      setOneClickToken((value) => value + 1);
      setTaskRefreshToken(Date.now());
      setToast('一键成片已开始，可在任务历史查看进度与结果');
    } catch (error) { setToast(error.message); }
  };

  // §8 attention-list deep links: jump from a quality issue straight to the
  // offending line in the studio. The weighting math lives in lib/quality.js.
  const qualityReport = useMemo(() => buildQualityReport(currentScene, state.voiceMap, mediaReport), [currentScene, state.voiceMap, mediaReport]);

  if (!project) {
    // Three dead-ends each with their own exit; the worst used to be a
    // finished load with projects present but none openable, which sat on
    // the loading screen forever.
    if (!loading && projects.length === 0) {
      return <BootShell view={view} onViewChange={setView}><WelcomeScreen onCreate={createProject} /><Toast message={toast} />{dialog ? <Dialog request={dialog} onDone={closeDialog} /> : null}</BootShell>;
    }
    if (!loading && projects.length > 0) {
      const retry = () => refreshProjects(projects[0].id).catch((error) => setToast(error.message));
      return <BootShell view={view} onViewChange={setView}><LoadErrorScreen onRetry={retry} onCreate={createProject} /><Toast message={toast} />{dialog ? <Dialog request={dialog} onDone={closeDialog} /> : null}</BootShell>;
    }
    return <BootShell view={view} onViewChange={setView}><LoadingScreen /><Toast message={toast} />{dialog ? <Dialog request={dialog} onDone={closeDialog} /> : null}</BootShell>;
  }
  const activeProgress = analysis || generation;
  let content;
  if (view === 'studio') content = currentScene ? <StudioLayout project={project} scenes={scenes} currentScene={currentScene} mediaReport={mediaReport} characters={state.characters || []} selectedLineId={selectedLineId} onSelectLine={setSelectedLineId} onUpdateLine={updateLine} onUpdateScene={updateScene} onSceneChange={changeScene} onImportNovel={importNovel} onAddScene={addScene} onDeleteScene={deleteScene} onRegenerate={regenerateLine} onPlayLine={playLine} onAddLine={addLine} onDeleteLine={deleteLine} onAcquireSound={setPickerLine} activeProgress={activeProgress} onCancelTask={cancelActiveTask} voiceMap={state.voiceMap || {}} configProvider={config?.provider} onOpenVoices={() => setView('voices')} onLabGenerate={runDirectionLab} labResult={labResult} labGenerating={Boolean(generation)} /> : <div className="empty-project"><BrandSignature /><h2>{project.name}</h2><p>{analysis ? `${analysis.message} · ${analysis.progress}%` : '还没有场景。导入 TXT 小说后，文本模型会识别角色、对白、旁白、声音事件和场景结构。'}</p>{analysis ? <button className="button secondary-button" type="button" onClick={cancelActiveTask}>取消拆解</button> : <><button className="button primary-button" type="button" onClick={importNovel}>导入小说并拆解</button><button className="button secondary-button" type="button" onClick={addScene}>手动新建场景</button></>}</div>;
  else if (view === 'voices') content = <VoicesView characters={state.characters || []} voiceMap={state.voiceMap || {}} voiceDesignConfig={config} onDesignVoice={designVoice} onSetVoice={setVoice} onToast={setToast} />;
  else if (view === 'sounds') content = <SoundsView assets={state.assets || []} builtinAssets={builtinAssets} sceneUsage={assetUsage} sceneEvents={(currentScene?.lines || []).filter((line) => line.type !== 'dialogue')} sceneTitle={currentScene?.title || ''} onUpload={uploadAsset} onBindAsset={bindAsset} onDeleteAsset={deleteAsset} onUpdateAsset={updateAsset} onToast={setToast} />;
  else if (view === 'production') content = <ProductionView project={project} mediaReport={mediaReport} currentSceneId={currentSceneId} onSceneChange={changeScene} onUpdateLine={updateLine} onUpdateDictionary={updateDictionary} onExportScene={exportSceneById} onExportEpisode={exportEpisode} onOneClick={oneClick} oneClickToken={oneClickToken} onGenerateMissing={generateMissingDialogue} generating={Boolean(generation)} exporting={exporting} taskRefreshToken={taskRefreshToken} onToast={setToast} />;
  else if (view === 'quality') content = <QualityView report={qualityReport} stages={stages} onToast={setToast} onExport={() => exportSceneById(currentScene?.id)} onOpenProduction={() => setView('production')} onOpenView={setView} onLocateLine={locateLine} onOpenVoices={() => setView('voices')} onOpenSounds={() => setView('sounds')} onGenerateMissing={() => generateMissingDialogue([currentScene?.id])} onRegenerateStale={() => regenerateStaleDialogue([currentScene?.id])} generating={Boolean(generation)} exporting={exporting} />;
  else content = <SettingsView config={config} onSave={saveConfig} onTestLlm={api.testLlm} onToast={setToast} onReload={reloadConfig} />;

  return <div className="app-shell"><AppRail view={view} onViewChange={setView} /><TopBar view={view} project={project} currentScene={currentScene} projects={projects} onSelectProject={selectProject} onCreateProject={createProject} onArchiveProject={archiveProjectById} onGenerate={generateScene} onReview={() => setReviewToken(Date.now())} onImportNovel={importNovel} generating={Boolean(activeProgress)} canReview={generatedClips.length > 0} saveState={saveState} /><div className="app-content">{content}</div>{view === 'studio' && currentScene ? <PlayerBar scene={currentScene} requestedLineId={requestedLineId} reviewToken={reviewToken} onOpenMix={() => setView('production')} onExport={() => exportSceneById(currentScene.id)} exporting={exporting} /> : null}{pickerLine ? <SoundPicker line={pickerLine} projectId={project.id} config={config} builtinAssets={builtinAssets} onBind={bindAsset} onUpload={uploadAndBind} onGenerate={generateSound} onClose={() => setPickerLine(null)} onToast={setToast} /> : null}{dialog ? <Dialog request={dialog} onDone={closeDialog} /> : null}<Toast message={toast} /></div>;
}

// --- Local composition helpers (props-only, no state of their own) --------

function BootShell({ view, onViewChange, children }) {
  return <div className="app-shell is-welcome"><AppRail view={view} onViewChange={onViewChange} /><div className="app-content">{children}</div></div>;
}

function WelcomeScreen({ onCreate }) {
  return <main className="empty-project"><BrandSignature /><h2>让故事，有声有场。</h2><p>还没有作品。创建一部，或运行 <code>npm run seed</code> 导入《西游记 · 三打白骨精》示例，离线体验一键成片。</p><div className="empty-project-actions"><button className="button primary-button" type="button" onClick={onCreate}>创建第一部作品</button></div></main>;
}

function LoadErrorScreen({ onRetry, onCreate }) {
  return <main className="empty-project"><BrandSignature /><h2>作品加载失败</h2><p>没有打开任何作品：读取失败，或所选作品已不存在。可重试，或从顶部切换其他作品。</p><div className="empty-project-actions"><button className="button primary-button" type="button" onClick={onRetry}>重试加载</button><button className="button secondary-button" type="button" onClick={onCreate}>新建作品</button></div></main>;
}

function LoadingScreen() {
  return <div className="app-loading" role="status"><BrandSignature /><span>正在打开本地项目数据库</span></div>;
}

function StudioLayout({ project, scenes, currentScene, mediaReport, characters, selectedLineId, onSelectLine, onUpdateLine, onUpdateScene, onSceneChange, onImportNovel, onAddScene, onDeleteScene, onRegenerate, onPlayLine, onAddLine, onDeleteLine, onAcquireSound, activeProgress, onCancelTask, voiceMap, configProvider, onOpenVoices, onLabGenerate, labResult, labGenerating }) {
  const selectedLine = currentScene?.lines.find((line) => line.id === selectedLineId) || currentScene?.lines[0] || null;
  return (
    <div className="studio-layout">
      <SceneSidebar project={project} scenes={scenes} currentSceneId={currentScene.id} mediaReport={mediaReport} onSceneChange={onSceneChange} onImportNovel={onImportNovel} onAddScene={onAddScene} onDeleteScene={onDeleteScene} />
      <SceneCanvas scene={currentScene} durationMs={mediaReport?.scenes?.find((item) => item.sceneId === currentScene.id)?.durationMs} sourceText={project.sourceText} characters={characters} selectedLineId={selectedLineId} onSelectLine={onSelectLine} onUpdateLine={onUpdateLine} onUpdateScene={onUpdateScene} onRegenerate={onRegenerate} onPlayLine={onPlayLine} onAddLine={onAddLine} onDeleteLine={onDeleteLine} onAcquireSound={onAcquireSound} generationProgress={activeProgress?.progress ?? null} generationMessage={activeProgress?.message} onCancelTask={onCancelTask} />
      <Inspector line={selectedLine} characters={characters} voiceMap={voiceMap} provider={configProvider} onUpdate={(patch) => onUpdateLine(selectedLine.id, patch)} onOpenVoices={onOpenVoices} onAcquireSound={onAcquireSound} onLabGenerate={onLabGenerate} lab={labResult} labGenerating={labGenerating} />
    </div>
  );
}

export default App;

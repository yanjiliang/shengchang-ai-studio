import { useEffect, useMemo, useRef, useState } from 'react';
import { LLM_IMPORT_BLOCKED, llmReady } from './lib/llm.js';
import { AppRail } from './components/AppRail';
import { BrandSignature } from './components/BrandSignature';
import { Dialog } from './components/Dialog';
import { PlayerBar } from './components/PlayerBar';
import { Toast } from './components/Toast';
import { ExportFailure } from './components/ExportFailure';
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
import { labVariantRequest, normalizeLinePatch } from './lib/direction-lab.js';
import { billingSummary, billingText, estimateCacheText, estimateCostText } from './lib/billing';
import { breezeEstimateText, engineOf, isBreeze } from './lib/engine.js';
import { EXPORT_ONLY_DIALOGUE, exportOnlyDialogue, goFixText, missingDetail, missingText, missingVoiceRoles, oneClickPlan } from './lib/one-click.js';
import { chainApi } from './lib/chain-api.js';
import { referenceFromVoice } from './lib/voice-design.js';
import { useBreezeStatus } from './lib/useBreezeStatus.js';
import { useExportLock } from './lib/useExportLock.js';
import { EXPORT_LOCK_TEXT } from './lib/export-lock.js';
import { exportFailureView, resolveMissingLines } from './lib/export-failure.js';
import { generationMissingRoles, generationVoiceMap, missingRolesToast } from './lib/voice-readiness.js';
import { finishedOneClick, oneClickButtonFromTasks } from './lib/one-click-progress.js';
import { breezeHealthOutage, breezeOutage, doubaoSwitchConfirm, doubaoSwitchDialog } from './lib/breeze-outage.js';
import { BreezeOutageBanner } from './components/BreezeOutageBanner.jsx';
import { singleAudio } from './lib/single-audio.js';
import { useVoiceDrafts } from './components/voice/useVoiceDrafts.js';

const EMPTY_STATE = { scenes: [], assets: [], characters: [], voiceMap: {} };

function downloadMedia(url, name) {
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; document.body.appendChild(anchor); anchor.click(); anchor.remove();
}

const DOUBAO_SWITCH_KEY = 'shengchang.doubaoSwitched';
const readDoubaoSwitched = () => { try { return localStorage.getItem(DOUBAO_SWITCH_KEY) === '1'; } catch { return false; } };
const writeDoubaoSwitched = () => { try { localStorage.setItem(DOUBAO_SWITCH_KEY, '1'); } catch { /* ignore */ } };
const clearDoubaoSwitched = () => { try { localStorage.removeItem(DOUBAO_SWITCH_KEY); } catch { /* ignore */ } };

function App() {
  const [view, setView] = useState('studio');
  const [projects, setProjects] = useState([]);
  const [project, setProject] = useState(null);
  const [currentSceneId, setCurrentSceneId] = useState(null);
  const [selectedLineId, setSelectedLineId] = useState(null);
  const [requestedLineId, setRequestedLineId] = useState(null);
  const [reviewToken, setReviewToken] = useState(0);
  const [toast, setToast] = useState('');
  // fe-0010：导出失败不再用会自己消失的 toast，留一个带「重试」「详情」的提示，直到用户关掉或重试。
  const [exportFailure, setExportFailure] = useState(null);
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [taskRefreshToken, setTaskRefreshToken] = useState(0);
  const [mediaReport, setMediaReport] = useState(null);
  const [projectRefreshToken, setProjectRefreshToken] = useState(0);
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
  // 一键成片被「没定声音」拦下时跳到这个角色。
  const [voicesRoleId, setVoicesRoleIdRaw] = useState('');
  const [voicesFocus, setVoicesFocus] = useState(0);
  // 跳到角色音色页时，焦点放到那个角色的声音描述框。
  const setVoicesRoleId = (roleId) => { setVoicesRoleIdRaw(roleId); setVoicesFocus(Date.now()); };
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
  const breezeMode = isBreeze(config);
  const [oneClickRunning, setOneClickRunning] = useState(false);
  // 一键成片在跑时停用所有导出入口；以服务端任务列表为准（刷新页面也认得）。
  const [oneClickTaskId, setOneClickTaskId] = useState('');
  const exportLock = useExportLock(project?.id || '', { pendingTaskId: oneClickTaskId, refreshToken: taskRefreshToken });
  const [outage, setOutage] = useState(null);
  const [toastSticky, setToastSticky] = useState(false);
  const breeze = useBreezeStatus(breezeMode, { generating: Boolean(generation) || oneClickRunning });
  const voiceDrafts = useVoiceDrafts(project?.id || '', { onError: (error) => setToast(error.message) });
  // Breeze 断开：正在生成 / 排队的试听变成失败卡片。
  useEffect(() => { if (breezeMode && breeze.status.state === 'disconnected') voiceDrafts.disconnected(); }, [breezeMode, breeze.status.state]); // eslint-disable-line react-hooks/exhaustive-deps
  // 同一时间只播一段：切换页面就停。
  useEffect(() => { singleAudio.stop(); }, [view]);
  const scenes = state.scenes || [];
  const currentScene = useMemo(() => scenes.find((scene) => scene.id === currentSceneId) || scenes[0] || null, [scenes, currentSceneId]);
  const generatedClips = useMemo(() => currentScene?.lines.filter((line) => line.audioUrl) || [], [currentScene]);

  // 一键成片按钮的进度（服务端任务列表推出来，刷新页面也在）+ B1：它从在跑变成结束时，
  // 重新读作品（台词 audioUrl）、媒体报告、审听里的混音 / 时间轴和任务历史。
  const oneClickBusy = useMemo(() => oneClickButtonFromTasks(exportLock.tasks, exportLock), [exportLock.tasks, exportLock.locked, exportLock.taskId]);
  const activeOneClickRef = useRef('');
  useEffect(() => {
    const finished = finishedOneClick(activeOneClickRef.current, exportLock.tasks);
    if (oneClickBusy?.taskId) activeOneClickRef.current = oneClickBusy.taskId;
    else if (finished || !exportLock.locked) activeOneClickRef.current = '';
    if (!finished || !project?.id) return;
    if (oneClickTaskId === finished.id) setOneClickTaskId('');
    refreshProjects(project.id).catch((error) => setToast(error.message));
    setProjectRefreshToken((value) => value + 1);
    setTaskRefreshToken(Date.now());
  }, [exportLock.tasks]);
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
  }, [project?.id, audioSignature, projectRefreshToken]);
  useEffect(() => {
    // Best-effort: a missing builtin library degrades the picker's builtin
    // tab, nothing else.
    api.builtinAssets().then((payload) => setBuiltinAssets(payload.assets)).catch(() => setBuiltinAssets([]));
  }, []);
  useEffect(() => setExportFailure(null), [project?.id]);
  useEffect(() => {
    if (!toast || toastSticky) return undefined;
    const timer = window.setTimeout(() => setToast(''), 3800);
    return () => window.clearTimeout(timer);
  }, [toast, toastSticky]);

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
  const updateLine = (lineId, patch) => persistState({ ...state, scenes: scenes.map((scene) => scene.id !== currentScene.id ? scene : { ...scene, status: 'draft', lines: scene.lines.map((line) => line.id === lineId ? { ...line, ...normalizeLinePatch(patch) } : line) }) });
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
    // 服务端 voiceReady 按引擎规则判断（custom / Breeze 可不鉴权）；旧服务没有该字段时退回：
    // 自定义接口只要求接口地址，凭证仅豆包必填。
    const voiceReady = config.voiceReady ?? (config.provider === 'demo' || isBreeze(config) || (config.provider === 'custom' ? Boolean(config.endpoint) : config.hasAccessKey));
    if (!voiceReady) { setView('settings'); setToast(config.provider === 'custom' ? '请先填写自定义语音接口地址' : '请先配置真实语音模型凭证'); return false; }
    return true;
  };
  // B3（e2e6）：生成用的音色表按引擎取（Breeze = 锁定参考音的 breezeVoiceId，其他 = voiceMap），跟服务端 generationVoiceMap 一致。
  const engineVoiceMap = useMemo(() => generationVoiceMap(config, state), [config, state]);
  const generationRequest = (line) => buildGenerationRequest(line, engineVoiceMap);
  // 所有手动生成入口共用：这批台词里还有没有角色没定声音。Breeze 先问服务端 GET voice-readiness（以它为准），读不到按本地算。
  const blockOnGenerationVoices = async (requests) => {
    const readiness = isBreeze(config) && project ? await chainApi.voiceReadiness(project.id).catch(() => null) : null;
    const missing = generationMissingRoles({ requests, readiness, characters: state.characters || [] });
    if (!missing.length) return false;
    setVoicesRoleId(missing[0].roleId); setView('voices'); setToast(missingRolesToast(missing, isBreeze(config)));
    return true;
  };
  // Shared pipeline for every generation entry point (scene / line / batch
  // fill / batch stale): guard, enqueue one persistent task, watch it, then
  // refresh. Server-side B3's runGenerationRequests is the other half of this
  // contract - both manual and future orchestrated flows converge here.
  const runGenerationTask = async ({ kind, requests, sceneId, buildingMessage, doneMessage }) => {
    if (!project || generation || !ensureVoiceConfigured()) return false;
    if (await blockOnGenerationVoices(requests)) return false;
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
      const billing = isBreeze(config) ? '' : billingText(billingSummary(completed.result));
      setToast(`${doneMessage(completed)}${note}${billing ? `。${billing}` : ''}`);
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
    if (await blockOnGenerationVoices([base])) return;
    try {
      setGeneration({ progress: 1, message: `正在生成 ${variants.length} 组方向对比` });
      await commitPendingSave();
      const requests = variants.map((variant) => labVariantRequest(base, variant, config?.provider));
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
    if (!requests.length) { setToast(emptyMessage); return Promise.resolve(false); }
    return runGenerationTask({ kind, requests, buildingMessage: (count) => `正在创建 ${count} 句生成任务`, doneMessage: (completed) => doneMessage(completed.result?.results?.length || 0) });
  };
  const generateMissingDialogue = (sceneIds = []) => generateBatch({ sceneIds, selects: (line) => !line.audioUrl, kind: 'batch-missing', emptyMessage: '没有需要生成的缺失对白', doneMessage: (count) => `已补全 ${count} 句对白` });
  // 过期以服务端的 line.stale 为准（audioStale 是旧的前端推断，留着兼容老数据）。
  const regenerateStaleDialogue = (sceneIds = []) => generateBatch({ sceneIds, selects: (line) => line.audioUrl && (line.stale === true || line.audioStale), kind: 'batch-stale', emptyMessage: '没有需要重新生成的过期对白', doneMessage: (count) => `已重新生成 ${count} 句对白` });
  // 导出前检查里的「先重配这 N 句」：按 export-precheck 给的 lineId 重新生成。
  // N3：豆包按字扣费，先确认（字数用服务端 precheck 的 pendingCharCount，给不出就不写数字）；Breeze / 演示直接开始。
  const regenerateLines = async (lineIds = [], { charCount = null } = {}) => {
    const wanted = new Set(lineIds);
    if (!isBreeze(config) && engineOf(config) !== 'demo' && wanted.size) {
      const chars = Number.isFinite(Number(charCount)) && charCount !== null ? `，最多约扣 ${Number(charCount)} 字额度` : '';
      if (!(await openDialog({ type: 'confirm', message: `用豆包重新生成这 ${wanted.size} 句`, detail: `会按字扣豆包额度${chars}；实际扣费以完成后的计费为准。`, confirmLabel: '重新生成' }))) return false;
    }
    return generateBatch({ selects: (line) => wanted.has(line.id), kind: 'batch-stale', emptyMessage: '这些句子已经不在作品里了', doneMessage: (count) => `已重新配音 ${count} 句，可以再导出` });
  };
  const playLine = (line) => { const url = line.audioUrl || line.assetUrl; if (!url) setToast('请先生成或绑定实际音频'); else if (line.type === 'dialogue') { setRequestedLineId(null); window.setTimeout(() => setRequestedLineId(line.id), 0); } else new Audio(url).play().catch(() => setToast('素材无法播放')); };

  const importNovel = async () => {
    if (!project) return;
    // 文本模型没测通就不导入（Yan：通用 OpenAI 兼容服务，没有本地规则拆解兜底）。
    if (!llmReady(config)) {
      if (await openDialog({ type: 'confirm', message: LLM_IMPORT_BLOCKED, detail: '在「设置 · 文本模型」里填好地址和模型名（服务需要的话再填 Key），点「测试连接」通过后再导入。', confirmLabel: '去设置' })) setView('settings');
      return;
    }
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
  const saveConfig = async (draft) => {
    const saved = await api.saveConfig(draft);
    if (isBreeze(config) && saved.provider === 'volcengine-api-key') writeDoubaoSwitched();
    if (isBreeze(saved)) clearDoubaoSwitched();
    setConfig(saved);
    return saved;
  };
  const reloadConfig = async () => { try { setConfig(await api.getConfig()); } catch (error) { setToast(error.message); } };
  const designVoice = async (input) => {
    const result = await api.designVoice(input);
    persistState({ ...state, voiceMap: { ...(state.voiceMap || {}), [input.characterId]: result.voiceId } });
    return result;
  };
  const updateCharacter = (characterId, patch) => persistState({ ...state, characters: (state.characters || []).map((character) => character.id === characterId ? { ...character, ...patch } : character) });
  const setVoice = (characterId, voiceId) => persistState({ ...state, voiceMap: { ...(state.voiceMap || {}), [characterId]: voiceId } });
  // Breeze 锁定 / 撤销 / 解除：角色上的 voice（参考音色）和 voiceMap（生成时的 voice_id = referenceId）一起改。
  // 服务端在锁定接口里已经记下了；这里同步到浏览器状态，免得自动保存把它覆盖回去。
  const applyCharacterVoice = (characterId, voice, voiceHistory) => {
    // 参考音在服务端 state.voiceReferences 里（锁定接口已经写了，浏览器保存覆盖不了）；这里乐观同步一份给界面。
    // 不写 voiceMap：Breeze 生成不看 voiceMap，切回豆包时也不能把 referenceId 当成豆包音色。
    const voiceReferences = { ...(state.voiceReferences || {}) };
    if (voice?.referenceId) voiceReferences[characterId] = referenceFromVoice(voice); else delete voiceReferences[characterId];
    persistState({ ...state, voiceReferences, characters: (state.characters || []).map((character) => character.id === characterId ? { ...character, voice: voice || null, voiceHistory: voiceHistory || [] } : character) });
    // 重新读一次项目：服务端会按新的参考音色重新算每句的 stale（需重渲）。
    window.setTimeout(() => refreshProjects(project?.id).catch((error) => setToast(error.message)), 600);
  };
  // 审听修句改的台词可能不在当前场景。
  const updateAnyLine = (lineId, patch) => persistState({ ...state, scenes: scenes.map((scene) => scene.lines?.some((line) => line.id === lineId) ? { ...scene, lines: scene.lines.map((line) => line.id === lineId ? { ...line, ...normalizeLinePatch(patch) } : line) } : scene) });
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
  // Unbind keeps the audio file and library entry: only the event's reference
  // is dropped, so rebinding (or deleting the asset later) stays available.
  const unbindAsset = (line) => { updateLine(line.id, { assetUrl: undefined, assetName: undefined, assetId: undefined }); setToast(`已解除「${line.text?.slice(0, 18) || line.label}」的素材绑定`); };
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
    if (exportLock.locked) { setToast(EXPORT_LOCK_TEXT); return; }
    if (!scene?.lines.some((line) => line.type === 'dialogue' && line.audioUrl)) { setToast('当前场景没有已生成的对白'); return; }
    setExporting(true);
    setExportFailure(null);
    try { await commitPendingSave(); const result = await api.exportScene(project.id, scene.id); downloadMedia(result.url, result.name); setToast(`本场已渲染：${formatDuration(result.durationMs)} · ${result.trackCount} 条轨道`); }
    catch (error) { showExportFailure(error, () => exportSceneById(sceneId)); } finally { setExporting(false); }
  };
  // 409（一键成片在跑）照旧一句「正在配音，配完再导出」；其余失败给固定文案 + 重试 + 详情（服务端原文）。
  const showExportFailure = (error, retry) => {
    const view = exportFailureView(error);
    if (view.locked) { setToast(view.text); return; }
    const lines = resolveMissingLines(view.lines || [], scenes);
    setExportFailure({ ...view, ...(view.missing ? { lines } : {}), retry });
    // 0049 整集导出任务失败只带一句话：丢了文件的是哪几句从 export-precheck 补。
    if (view.missing && !lines.length && project) chainApi.exportPrecheck(project.id).then((result) => {
      const found = resolveMissingLines(result.missingFileLines || [], scenes);
      if (found.length) setExportFailure((current) => current?.missing ? { ...current, lines: found } : current);
    }).catch(() => {});
  };
  const exportEpisode = async () => {
    if (exportLock.locked) { setToast(EXPORT_LOCK_TEXT); return; }
    if (!scenes.some((scene) => scene.lines.some((line) => line.type === 'dialogue' && line.audioUrl))) { setToast('整部作品还没有可导出的对白音频'); return; }
    setExporting(true);
    setExportFailure(null);
    try {
      await commitPendingSave();
      const task = await api.exportEpisode(project.id);
      setTaskRefreshToken(Date.now());
      // Progress renders in the tasks tab; toasts stay for terminal states
      // only — a per-percent toast used to overwrite every other message.
      const completed = await waitForTask(task.id, () => setTaskRefreshToken(Date.now()));
      downloadMedia(completed.result.url, completed.result.name);
      if (completed.result.attributionUrl) downloadMedia(completed.result.attributionUrl, decodeURIComponent(completed.result.attributionUrl.split('/').pop()));
      setToast(`整集已导出：${completed.result.sceneCount} 场 · ${formatDuration(completed.result.durationMs)}${exportOnlyDialogue(scenes) ? ` · ${EXPORT_ONLY_DIALOGUE}` : ''}`);
    } catch (error) { showExportFailure(error, exportEpisode); }
    finally { setExporting(false); setTaskRefreshToken(Date.now()); }
  };

  // §8 stage-checklist follow-up, adapted to the manual workbench (there is no
  // one-click orchestrator in this repo): project-wide readiness stages, each
  // deep-linking to the surface where it gets fixed.
  const stages = useMemo(() => buildStageProgress(scenes, engineVoiceMap), [scenes, engineVoiceMap]);

  // 开始前的 Breeze 检查：服务端探测最多 10 秒（HEALTH_TIMEOUT_MS），先提示一句；请求本身再卡住就按「没有响应」算。
  const checkBreezeBeforeStart = async () => {
    // 检查期间提示常驻（不走 3.8 秒自动消失），最长 12 秒内一定给结论。
    setToastSticky(true);
    setToast('正在确认 Breeze 有没有响应…');
    const timeout = new Promise((resolve) => setTimeout(() => resolve({ state: 'disconnected', cause: 'timeout', label: '没有响应', detail: '' }), 12000));
    const health = await Promise.race([breeze.refresh(), timeout]);
    setToastSticky(false);
    setToast('');
    return health;
  };

  // 「重试连接」/「Breeze 恢复后继续」：重新走一键成片。已配好的句子命中缓存，不会重配、不会重复扣费。
  const retryAfterOutage = async () => {
    const health = await checkBreezeBeforeStart();
    const still = breezeHealthOutage(health);
    if (still) { setOutage(still); setToast(health.cause === 'timeout' ? 'Breeze 还是没有响应' : 'Breeze 还是连不上，请确认 Mac 上的 Breeze 服务已启动'); return; }
    setOutage(null);
    await oneClick();
  };

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
  // 「还有 N 个角色没定声音」：列出名字，「去给X定声音」跳到角色音色并聚焦描述框；不自动套音色、不悄悄跳过。
  const blockOnMissingVoices = async (missing) => {
    if (!missing.length) return;
    if (await openDialog({ type: 'confirm', message: missingText(missing), detail: missingDetail(missing), confirmLabel: goFixText(missing) })) { setVoicesRoleId(missing[0].roleId); setView('voices'); }
  };
  // 一键成片的任务：只为了接住 BREEZE_UNREACHABLE（整个任务停一次，一条横幅，不是逐句失败）。
  const watchOneClick = async (taskId, context = {}) => {
    if (!taskId) return;
    setOneClickRunning(true);
    try {
      for (let delay = 800; ; delay = Math.min(3000, delay + 400)) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        const task = await api.getTask(taskId);
        if (!['queued', 'running'].includes(task.status)) { const found = breezeOutage(task, context); if (found) setOutage(found); return; }
      }
    } catch { /* 任务历史里仍能看到 */ } finally { setOneClickRunning(false); }
  };
  const oneClick = async () => {
    if (!project || exporting) return;
    try {
      // 开始前先确认 Breeze 连得上：连不上就不开始（没有花任何额度），只给重试 / 去设置，绝不自动换豆包。
      // N4：探测超时（Breeze 卡住 / 正忙）也算不可用，给「没有响应」横幅；检查期间先给一句提示，不再静默十几秒。
      if (isBreeze(config)) {
        const found = breezeHealthOutage(await checkBreezeBeforeStart());
        if (found) { setOutage(found); return; }
      }
      setOutage(null);
      // N1：还剩几句以 export-precheck 的 pendingLineCount 为准（只读）；读不到就按 estimate。
      const [estimate, precheck] = await Promise.all([api.oneClickEstimate(project.id), chainApi.exportPrecheck(project.id).catch(() => null)]);
      const plan = oneClickPlan(estimate, precheck);
      // Breeze：有角色没定声音就先拦下（不会自动套用预设音色，也不会悄悄跳过这些台词）。
      // 来源：estimate.missingVoiceRoles → GET voice-readiness → 本地算。检查本身在 lib/one-click.js。
      const readiness = isBreeze(config) && !Array.isArray(estimate.missingVoiceRoles) ? await chainApi.voiceReadiness(project.id).catch(() => null) : null;
      const missing = missingVoiceRoles({ estimate, readiness, config, characters: state.characters || [], scenes, voiceReferences: state.voiceReferences || null });
      if (missing.length) { await blockOnMissingVoices(missing); return; }
      const parts = [`${estimate.sceneCount} 个场景`, plan.linesText];
      const cacheText = estimateCacheText(estimate);
      if (cacheText) parts.push(cacheText);
      const cost = isBreeze(config) ? breezeEstimateText(estimate) : estimateCostText(estimate);
      const llmNote = estimate.needsLlm ? '\n项目还没有场景，将先用文本模型拆解原文。' : '';
      // 用户自己在设置里从 Breeze 换到了豆包：第一次生成前先说清楚要扣多少字、声音会不一样。
      const doubaoFirst = !isBreeze(config) && readDoubaoSwitched() && Boolean(doubaoSwitchConfirm(estimate));
      // 标题只写上限「最多约扣 X 字额度」；「预计缓存命中：未知」这种没数据的行不再出现（estimateCacheText 返回空）。
      if (doubaoFirst) { const copy = doubaoSwitchDialog(estimate); if (!(await openDialog({ type: 'confirm', message: copy.title, detail: `${copy.detail}\n${parts.join(' · ')} · ${cost.main}`, confirmLabel: '用豆包开始' }))) return; }
      // 0 句要配（precheck pendingLineCount = 0）：主按钮直接是「导出整集」，走整集导出，不再「开始」一遍空的一键成片。
      if (!doubaoFirst && plan.nothingPending) {
        if (await openDialog({ type: 'confirm', message: '一键成片', detail: `${parts.join(' · ')} · ${cost.main}`, footer: '台词都已配好，不用再生成，可以直接导出整集。', confirmLabel: '导出整集' })) await exportEpisode();
        return;
      }
      if (doubaoFirst) clearDoubaoSwitched();
      else if (!(await openDialog({ type: 'confirm', message: '一键成片', detail: `${parts.join(' · ')} · ${cost.main}${llmNote}`, note: cost.note, footer: isBreeze(config) ? '开始后自动执行：拆解 → 用已锁定的参考音色生成 → 体检 → 导出整集。' : '开始后自动执行：拆解 → 配音色 → 生成 → 体检 → 导出整集。', confirmLabel: plan.confirmLabel }))) return;
      await commitPendingSave();
      let started;
      try { started = await api.oneClick(project.id); }
      catch (error) {
        const found = breezeOutage(error);
        if (found) { setOutage(found); return; }
        // 估算之后角色又被改了（或别的标签页）：服务端 409 VOICE_NOT_READY + missingVoiceRoles，同样拦下。
        if (error.code === 'VOICE_NOT_READY') { await blockOnMissingVoices(missingVoiceRoles({ estimate: { missingVoiceRoles: error.payload?.missingVoiceRoles || [], voiceReady: false }, config, characters: state.characters || [] })); return; }
        throw error;
      }
      setOneClickToken((value) => value + 1);
      setOneClickTaskId(started?.id || started?.task?.id || started?.taskId || '');
      watchOneClick(started?.id || started?.task?.id || started?.taskId, { requestCount: estimate.requestCount });
      setTaskRefreshToken(Date.now());
      setToast('一键成片已开始，可在任务历史查看进度与结果');
    } catch (error) { setToast(error.message); }
  };

  // §8 attention-list deep links: jump from a quality issue straight to the
  // offending line in the studio. The weighting math lives in lib/quality.js.
  const qualityReport = useMemo(() => buildQualityReport(currentScene, engineVoiceMap, mediaReport), [currentScene, engineVoiceMap, mediaReport]);

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
  if (view === 'studio') content = currentScene ? <StudioLayout project={project} scenes={scenes} currentScene={currentScene} mediaReport={mediaReport} characters={state.characters || []} selectedLineId={selectedLineId} onSelectLine={setSelectedLineId} onUpdateLine={updateLine} onUpdateScene={updateScene} onSceneChange={changeScene} onImportNovel={importNovel} onAddScene={addScene} onDeleteScene={deleteScene} onRegenerate={regenerateLine} onPlayLine={playLine} onAddLine={addLine} onDeleteLine={deleteLine} onAcquireSound={setPickerLine} onUnbindSound={unbindAsset} activeProgress={activeProgress} onCancelTask={cancelActiveTask} voiceMap={engineVoiceMap} configProvider={config?.provider} config={config} onOpenVoices={() => setView('voices')} onLabGenerate={runDirectionLab} labResult={labResult} labGenerating={Boolean(generation)} /> : <div className="empty-project"><BrandSignature /><h2>{project.name}</h2><p>{analysis ? `${analysis.message} · ${analysis.progress}%` : '还没有场景。导入 TXT 小说后，文本模型会识别角色、对白、旁白、声音事件和场景结构。'}</p>{analysis ? <button className="button secondary-button" type="button" onClick={cancelActiveTask}>取消拆解</button> : <><button className="button primary-button" type="button" onClick={importNovel}>导入小说并拆解</button><button className="button secondary-button" type="button" onClick={addScene}>手动新建场景</button></>}</div>;
  else if (view === 'voices') content = <VoicesView characters={state.characters || []} voiceReferences={state.voiceReferences || {}} voiceMap={state.voiceMap || {}} voiceDesignConfig={config} onDesignVoice={designVoice} onSetVoice={setVoice} onUpdateCharacter={updateCharacter} onToast={setToast} breeze={breezeMode ? breeze : null} scenes={scenes} projectId={project.id} voiceDrafts={voiceDrafts} onApplyVoice={applyCharacterVoice} onOpenSettings={() => setView('settings')} initialRoleId={voicesRoleId} focusRequest={voicesFocus} />;
  else if (view === 'sounds') content = <SoundsView assets={state.assets || []} builtinAssets={builtinAssets} sceneUsage={assetUsage} sceneEvents={(currentScene?.lines || []).filter((line) => line.type !== 'dialogue')} sceneTitle={currentScene?.title || ''} onUpload={uploadAsset} onBindAsset={bindAsset} onDeleteAsset={deleteAsset} onUpdateAsset={updateAsset} onToast={setToast} />;
  else if (view === 'production') content = <ProductionView onRegenerateLines={regenerateLines} project={project} mediaReport={mediaReport} currentSceneId={currentSceneId} onSceneChange={changeScene} onUpdateLine={updateLine} onUpdateDictionary={updateDictionary} onExportScene={exportSceneById} onExportEpisode={exportEpisode} exportLocked={exportLock.locked} onOneClick={oneClick} oneClickToken={oneClickToken} oneClickTaskId={oneClickTaskId} oneClickBusy={oneClickBusy} projectRefreshToken={projectRefreshToken} onGenerateMissing={generateMissingDialogue} generating={Boolean(generation)} exporting={exporting} taskRefreshToken={taskRefreshToken} onToast={setToast} onUpdateAnyLine={updateAnyLine} onLineAccepted={() => refreshProjects(project.id)} onSaveNow={commitPendingSave} hideBilling={breezeMode} breezeMode={breezeMode} breeze={breezeMode ? breeze : null} onOpenStudio={() => setView('studio')} />;
  else if (view === 'quality') content = <QualityView report={qualityReport} stages={stages} onToast={setToast} onExport={() => exportSceneById(currentScene?.id)} onOpenProduction={() => setView('production')} onOpenView={setView} onLocateLine={locateLine} onOpenVoices={() => setView('voices')} onOpenSounds={() => setView('sounds')} onGenerateMissing={() => generateMissingDialogue([currentScene?.id])} onRegenerateStale={() => regenerateStaleDialogue([currentScene?.id])} generating={Boolean(generation)} exporting={exporting} exportLocked={exportLock.locked} />;
  else content = <SettingsView config={config} onSave={saveConfig} onTestLlm={api.testLlm} onToast={setToast} onReload={reloadConfig} />;

  return <div className="app-shell"><AppRail view={view} onViewChange={setView} /><TopBar view={view} project={project} currentScene={currentScene} projects={projects} onSelectProject={selectProject} onCreateProject={createProject} onArchiveProject={archiveProjectById} onGenerate={generateScene} onReview={() => setReviewToken(Date.now())} onImportNovel={importNovel} generating={Boolean(activeProgress)} canReview={generatedClips.length > 0} saveState={saveState} /><div className="app-content">{outage ? <BreezeOutageBanner outage={outage} checking={breeze.checking} onRetry={retryAfterOutage} onResume={retryAfterOutage} onSettings={() => { setOutage(null); setView('settings'); }} onDismiss={() => setOutage(null)} /> : null}{content}</div>{view === 'studio' && currentScene ? <PlayerBar scene={currentScene} requestedLineId={requestedLineId} reviewToken={reviewToken} onOpenMix={() => setView('production')} onExport={() => exportSceneById(currentScene.id)} exporting={exporting} exportLocked={exportLock.locked} /> : null}{pickerLine ? <SoundPicker line={pickerLine} projectId={project.id} config={config} builtinAssets={builtinAssets} onBind={bindAsset} onUpload={uploadAndBind} onGenerate={generateSound} onClose={() => setPickerLine(null)} onToast={setToast} /> : null}{dialog ? <Dialog request={dialog} onDone={closeDialog} /> : null}<Toast message={toast} />{exportFailure ? <ExportFailure className="export-failure-notice" text={exportFailure.text} detail={exportFailure.detail} missing={Boolean(exportFailure.missing)} lines={exportFailure.lines || []} onRegenerate={(ids) => { setExportFailure(null); regenerateLines(ids); }} onLocate={(item) => locateLine(item.lineId)} retryDisabled={exporting || exportLock.locked} onRetry={() => { const { retry } = exportFailure; setExportFailure(null); retry?.(); }} onClose={() => setExportFailure(null)} /> : null}</div>;
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

function StudioLayout({ project, scenes, currentScene, mediaReport, characters, selectedLineId, onSelectLine, onUpdateLine, onUpdateScene, onSceneChange, onImportNovel, onAddScene, onDeleteScene, onRegenerate, onPlayLine, onAddLine, onDeleteLine, onAcquireSound, onUnbindSound, activeProgress, onCancelTask, voiceMap, configProvider, config, onOpenVoices, onLabGenerate, labResult, labGenerating }) {
  const selectedLine = currentScene?.lines.find((line) => line.id === selectedLineId) || currentScene?.lines[0] || null;
  return (
    <div className="studio-layout">
      <SceneSidebar project={project} scenes={scenes} currentSceneId={currentScene.id} mediaReport={mediaReport} onSceneChange={onSceneChange} onImportNovel={onImportNovel} onAddScene={onAddScene} onDeleteScene={onDeleteScene} />
      <SceneCanvas scene={currentScene} provider={configProvider} durationMs={mediaReport?.scenes?.find((item) => item.sceneId === currentScene.id)?.durationMs} sourceText={project.sourceText} characters={characters} selectedLineId={selectedLineId} onSelectLine={onSelectLine} onUpdateLine={onUpdateLine} onUpdateScene={onUpdateScene} onRegenerate={onRegenerate} onPlayLine={onPlayLine} onAddLine={onAddLine} onDeleteLine={onDeleteLine} onAcquireSound={onAcquireSound} generationProgress={activeProgress?.progress ?? null} generationMessage={activeProgress?.message} onCancelTask={onCancelTask} />
      <Inspector line={selectedLine} characters={characters} voiceMap={voiceMap} provider={configProvider} config={config} onUpdate={(patch) => onUpdateLine(selectedLine.id, patch)} onOpenVoices={onOpenVoices} onAcquireSound={onAcquireSound} onUnbindSound={onUnbindSound} onLabGenerate={onLabGenerate} lab={labResult} labGenerating={labGenerating} />
    </div>
  );
}

export default App;

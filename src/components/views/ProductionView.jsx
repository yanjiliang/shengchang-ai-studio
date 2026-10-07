import { AlertCircle, BookType, Check, Download, LoaderCircle, Music2, PauseCircle, PlayCircle, RefreshCcw, RotateCcw, Save, SlidersHorizontal, Trash2, Volume2, WandSparkles, Waves, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { defaultMix, rulerTicks, timelinePreview } from '../../lib/timeline';

const tabs = [
  { id: 'mix', label: '混音编排', icon: SlidersHorizontal },
  { id: 'tasks', label: '任务历史', icon: RefreshCcw },
  { id: 'dictionary', label: '发音词典', icon: BookType },
];

const typeNames = { dialogue: '对白', ambient: '环境', sfx: '音效', music: '音乐' };
const typeIcons = { dialogue: Volume2, ambient: Waves, sfx: PlayCircle, music: Music2 };
const statusNames = { queued: '排队中', running: '处理中', completed: '已完成', failed: '失败', cancelled: '已取消' };
const kindNames = { 'analyze-novel': '小说拆解', 'export-project': '整集导出', 'one-click': '一键成片', scene: '场景生成', line: '单句生成', 'batch-missing': '缺失对白补全', 'batch-stale': '过期对白重生成' };

function numberValue(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round((milliseconds || 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function MixInspector({ line, media, onUpdate }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    audio.pause(); setPlaying(false); setPositionMs(0);
    return undefined;
  }, [line?.id]);
  if (!line) return <aside className="mix-inspector"><div className="mix-empty"><SlidersHorizontal size={24} /><p>选择一条轨道编辑混音参数。</p></div></aside>;
  const mix = defaultMix(line);
  const update = (field, value) => onUpdate(line.id, { mix: { ...mix, [field]: value } });
  const sourceUrl = line.audioUrl || line.assetUrl;
  const sourceDurationMs = media?.durationMs || 0;
  const previewStartMs = Math.min(numberValue(mix.trimStartMs, 0), Math.max(0, sourceDurationMs - 20));
  const previewEndMs = Math.min(numberValue(mix.trimEndMs, sourceDurationMs), sourceDurationMs);
  const togglePreview = async () => {
    const audio = audioRef.current; if (!audio || !sourceUrl) return;
    if (!audio.paused) { audio.pause(); setPlaying(false); return; }
    if (audio.currentTime * 1000 < previewStartMs || audio.currentTime * 1000 >= previewEndMs) audio.currentTime = previewStartMs / 1000;
    try { await audio.play(); setPlaying(true); } catch { setPlaying(false); }
  };
  const onTimeUpdate = (event) => {
    const currentMs = Math.round(event.currentTarget.currentTime * 1000);
    setPositionMs(Math.max(0, currentMs - previewStartMs));
    if (previewEndMs > previewStartMs && currentMs >= previewEndMs) { event.currentTarget.pause(); event.currentTarget.currentTime = previewStartMs / 1000; setPlaying(false); setPositionMs(0); }
  };
  return (
    <aside className="mix-inspector">
      <div className="mix-inspector-head"><span>{typeNames[line.type] || line.type}</span><strong>{line.speaker || line.label || line.text}</strong><small>{sourceUrl ? media?.ok ? `真实音频 · ${formatDuration(sourceDurationMs)} · ${media.sampleRate / 1000} kHz · ${media.channels === 1 ? '单声道' : `${media.channels} 声道`}` : '音频文件无法读取' : line.type === 'dialogue' ? '待生成语音' : '待绑定素材'}</small></div>
      {sourceUrl ? <div className="mix-preview"><audio ref={audioRef} src={sourceUrl} preload="metadata" onTimeUpdate={onTimeUpdate} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} /><button type="button" disabled={!media?.ok} onClick={togglePreview}>{playing ? <PauseCircle size={15} /> : <PlayCircle size={15} />}{playing ? '暂停' : '试听裁切片段'}</button><span>{formatDuration(positionMs)} / {formatDuration(Math.max(0, previewEndMs - previewStartMs))}</span></div> : null}
      <div className="mix-field-grid">
        <label><span>入点（秒）</span><input type="number" min="0" step="0.1" value={mix.startMs === '' ? '' : mix.startMs / 1000} placeholder={line.type === 'dialogue' ? '自动顺排' : '0'} onChange={(event) => update('startMs', event.target.value === '' ? '' : Math.round(numberValue(event.target.value, 0) * 1000))} /></label>
        <label><span>持续（秒）</span><input type="number" min="0" step="0.1" value={mix.durationMs === '' ? '' : mix.durationMs / 1000} placeholder="素材原长" onChange={(event) => update('durationMs', event.target.value === '' ? '' : Math.round(numberValue(event.target.value, 0) * 1000))} /></label>
        <label><span>裁切开始（秒）</span><input type="number" min="0" max={sourceDurationMs ? sourceDurationMs / 1000 : undefined} step="0.01" value={mix.trimStartMs / 1000} disabled={!media?.ok} onChange={(event) => update('trimStartMs', Math.round(numberValue(event.target.value, 0) * 1000))} /></label>
        <label><span>裁切结束（秒）</span><input type="number" min={mix.trimStartMs / 1000 + 0.02} max={sourceDurationMs ? sourceDurationMs / 1000 : undefined} step="0.01" value={mix.trimEndMs === '' ? '' : mix.trimEndMs / 1000} placeholder={sourceDurationMs ? String(sourceDurationMs / 1000) : '素材原长'} disabled={!media?.ok} onChange={(event) => update('trimEndMs', event.target.value === '' ? '' : Math.round(numberValue(event.target.value, sourceDurationMs / 1000) * 1000))} /></label>
        <label><span>增益（dB）</span><input type="number" min="-60" max="12" step="1" value={mix.gainDb} onChange={(event) => update('gainDb', numberValue(event.target.value, 0))} /></label>
        <label><span>声像（-1 到 1）</span><input type="number" min="-1" max="1" step="0.1" value={mix.pan} onChange={(event) => update('pan', numberValue(event.target.value, 0))} /></label>
        <label><span>淡入（秒）</span><input type="number" min="0" step="0.1" value={mix.fadeInMs / 1000} onChange={(event) => update('fadeInMs', Math.round(numberValue(event.target.value, 0) * 1000))} /></label>
        <label><span>淡出（秒）</span><input type="number" min="0" step="0.1" value={mix.fadeOutMs / 1000} onChange={(event) => update('fadeOutMs', Math.round(numberValue(event.target.value, 0) * 1000))} /></label>
      </div>
      {line.type === 'dialogue' ? <label className="mix-full-field"><span>句后停顿（秒）</span><input type="number" min="0" max="10" step="0.1" value={mix.gapAfterMs / 1000} onChange={(event) => update('gapAfterMs', Math.round(numberValue(event.target.value, 0) * 1000))} /></label> : <label className="mix-check"><input type="checkbox" checked={mix.loop} onChange={(event) => update('loop', event.target.checked)} /><span>循环素材至设定时长或场景结束</span></label>}
      <div className="mix-engine-note"><Check size={14} /><p>音乐和环境轨进入对白区间时自动闪避；导出统一执行 -1 dBTP 峰值限制。</p></div>
    </aside>
  );
}

function MixWorkspace({ project, mediaReport, currentSceneId, onSceneChange, onUpdateLine, onExportScene, onExportEpisode, onOneClick, onGenerateMissing, generating, exporting, onToast }) {
  const scenes = project.state.scenes || [];
  const scene = scenes.find((item) => item.id === currentSceneId) || scenes[0];
  const [selectedId, setSelectedId] = useState(scene?.lines?.[0]?.id || '');
  const previewRef = useRef(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  useEffect(() => { if (!scene?.lines?.some((line) => line.id === selectedId)) setSelectedId(scene?.lines?.[0]?.id || ''); }, [scene?.id, scene?.lines, selectedId]);
  const selected = scene?.lines?.find((line) => line.id === selectedId);
  const sceneMedia = mediaReport?.scenes?.find((item) => item.sceneId === scene?.id);
  const selectedMedia = sceneMedia?.files?.find((item) => item.lineId === selectedId);
  const renderable = scene?.lines?.filter((line) => line.audioUrl || line.assetUrl).length || 0;
  const voicedScenes = scenes.filter((item) => item.lines?.some((line) => line.type === 'dialogue' && line.audioUrl)).length;
  const missingDialogue = scene?.lines?.filter((line) => line.type === 'dialogue' && !line.audioUrl).length || 0;
  const invalidFileCount = sceneMedia?.invalidFileCount || 0;
  const durationByLine = useMemo(() => new Map((sceneMedia?.files || []).map((file) => [file.lineId, file.durationMs || 0])), [sceneMedia]);
  const timeline = useMemo(() => timelinePreview(scene, durationByLine), [scene, durationByLine]);
  const missingLabel = (line) => line.type === 'dialogue' ? '待生成语音' : '待绑定素材';
  const previewScene = async () => {
    if (!scene || previewLoading) return;
    try {
      setPreviewLoading(true);
      const result = await api.previewScene(project.id, scene.id);
      const audio = previewRef.current;
      if (!audio) return;
      audio.src = result.url;
      await audio.play();
      onToast(`正在试听预混：${formatDuration(result.durationMs)} · ${result.trackCount} 条轨道`);
    } catch (error) { onToast(error.message); }
    finally { setPreviewLoading(false); }
  };
  const toggleScenePreview = () => {
    if (previewPlaying) { previewRef.current?.pause(); return; }
    previewScene();
  };
  return (
    <div className="production-workspace">
      <aside className="mix-scenes"><div className="section-caption">场景顺序</div>{scenes.map((item) => <button className={item.id === scene?.id ? 'is-active' : ''} type="button" key={item.id} onClick={() => onSceneChange(item.id)}><span>{item.number}</span><div><strong>{item.title}</strong><small>{item.lines?.filter((line) => line.audioUrl || line.assetUrl).length || 0} 条可渲染轨道</small></div></button>)}</aside>
      <section className="mix-timeline">
        <header><div><span>当前时间轴</span><h3>{scene?.title || '没有场景'}</h3><p>对白默认按顺序排列；填写入点后可精确覆盖。声音素材按事件入点进入。</p>{missingDialogue || invalidFileCount ? <div className="mix-readiness">{missingDialogue ? <span>{missingDialogue} 句待生成</span> : null}{invalidFileCount ? <span className="is-warning">{invalidFileCount} 个文件无法读取</span> : null}</div> : null}</div><div className="header-actions"><audio ref={previewRef} preload="none" onPlay={() => setPreviewPlaying(true)} onEnded={() => setPreviewPlaying(false)} onPause={() => setPreviewPlaying(false)} /><button className="button secondary-button" type="button" disabled={!renderable || invalidFileCount || previewLoading} onClick={toggleScenePreview}>{previewLoading ? <LoaderCircle size={14} className="spin" /> : previewPlaying ? <PauseCircle size={14} /> : <PlayCircle size={14} />}{previewLoading ? '正在预混' : previewPlaying ? '暂停试听' : '试听本场'}</button>{missingDialogue ? <button className="button secondary-button" type="button" disabled={generating} onClick={() => onGenerateMissing([scene.id])}>{generating ? <LoaderCircle size={14} className="spin" /> : <WandSparkles size={14} />}{generating ? '正在补全' : `补全对白 · ${missingDialogue}`}</button> : null}<button className="button secondary-button" type="button" disabled={!renderable || invalidFileCount || exporting} onClick={() => onExportScene(scene.id)}><Download size={14} />导出本场</button><button className="button secondary-button" type="button" disabled={!voicedScenes || exporting} onClick={onExportEpisode}>{exporting ? <LoaderCircle size={14} className="spin" /> : <Download size={14} />}{exporting ? '正在渲染' : `导出整集 · ${voicedScenes} 场`}</button><button className="button primary-button" type="button" disabled={exporting} onClick={onOneClick} title="自动拆解、配音色、生成、体检并导出整集"><WandSparkles size={14} />一键成片</button></div></header>
        <div className="timeline-ruler">{rulerTicks(timeline.totalMs).map((second) => <span key={second}>{formatDuration(second * 1000)}</span>)}</div>
        <div className="timeline-tracks">{timeline.tracks.map(({ line, startMs, durationMs, hasAudio }) => { const Icon = typeIcons[line.type] || Volume2; const mix = defaultMix(line); const span = Math.max(1, timeline.totalMs); return <button className={`timeline-track is-${line.type} ${selectedId === line.id ? 'is-selected' : ''} ${hasAudio ? '' : 'is-missing'}`} type="button" key={line.id} onClick={() => setSelectedId(line.id)}><span className="track-label"><Icon size={13} /><strong>{line.speaker || line.label || typeNames[line.type]}</strong><small>{hasAudio ? `${mix.gainDb} dB` : missingLabel(line)}</small></span><span className="track-lane"><i style={{ left: `${(startMs / span) * 100}%`, width: `${Math.max(1.5, (durationMs / span) * 100)}%` }}><b>{hasAudio ? line.text : missingLabel(line)}</b></i></span></button>; })}</div>
      </section>
      <MixInspector line={selected} media={selectedMedia} onUpdate={onUpdateLine} />
    </div>
  );
}

function TaskHistory({ projectId, refreshToken, onToast }) {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const load = async () => { try { const result = await api.listTasks(projectId); setTasks(result.tasks); } catch (error) { onToast(error.message); } finally { setLoading(false); } };
  useEffect(() => { load(); const timer = window.setInterval(() => { if (tasks.some((task) => ['queued', 'running'].includes(task.status))) load(); }, 1500); return () => window.clearInterval(timer); }, [projectId, refreshToken, tasks.some((task) => ['queued', 'running'].includes(task.status))]);
  const action = async (task, kind) => { try { if (kind === 'cancel') await api.cancelTask(task.id); else await api.retryTask(task.id); await load(); } catch (error) { onToast(error.message); } };
  if (loading) return <div className="tasks-loading"><LoaderCircle size={18} className="spin" />正在读取本地任务</div>;
  return <section className="task-history"><div className="task-history-head"><div><h3>持久任务</h3><p>小说拆解、语音生成和整集导出都会保留状态，服务重启后可恢复。</p></div><button className="button secondary-button" type="button" onClick={load}><RefreshCcw size={14} />刷新</button></div>{tasks.length ? tasks.map((task) => <article className={`task-row is-${task.status}`} key={task.id}><span className="task-status-icon">{task.status === 'completed' ? <Check size={16} /> : task.status === 'failed' ? <AlertCircle size={16} /> : task.status === 'cancelled' ? <XCircle size={16} /> : task.status === 'running' ? <LoaderCircle size={16} className="spin" /> : <PauseCircle size={16} />}</span><div className="task-copy"><strong>{kindNames[task.kind] || task.kind}<small>{statusNames[task.status]}</small></strong><p>{task.error || task.message}</p>{task.result?.failures?.length ? <details className="task-failures"><summary>失败明细 · {task.result.failures.length} 句</summary><ul>{task.result.failures.map((failure) => <li key={failure.lineId}><strong>{failure.text?.slice(0, 24) || failure.lineId}</strong><span>{failure.error}</span></li>)}</ul><p>重试任务时，成功句会直接命中缓存，只为失败句重新付费。</p></details> : null}{task.result?.attention?.length ? <details className="task-failures is-attention"><summary>注意事项 · {task.result.attention.length} 项</summary><ul>{task.result.attention.map((item, index) => <li key={index}><strong>{item}</strong></li>)}</ul></details> : null}<div><span style={{ width: `${task.progress}%` }} /></div></div><time>{new Date(task.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time><div className="task-actions">{['queued', 'running'].includes(task.status) ? <button type="button" onClick={() => action(task, 'cancel')}>取消</button> : null}{['failed', 'cancelled'].includes(task.status) ? <button type="button" onClick={() => action(task, 'retry')}><RotateCcw size={13} />重试</button> : null}{task.result?.url ? <a href={task.result.url} download={task.result.name}><Download size={13} />下载</a> : null}{task.result?.attributionUrl ? <a href={task.result.attributionUrl} download><BookType size={13} />来源清单</a> : null}</div></article>) : <div className="empty-project"><h2>还没有制作任务</h2><p>生成对白、拆解小说或导出整集后，任务会出现在这里。</p></div>}</section>;
}

function PronunciationDictionary({ entries, onChange }) {
  const [term, setTerm] = useState(''); const [replacement, setReplacement] = useState('');
  const add = () => { if (!term.trim() || !replacement.trim()) return; onChange([{ id: crypto.randomUUID(), term: term.trim(), replacement: replacement.trim() }, ...entries]); setTerm(''); setReplacement(''); };
  return <section className="dictionary-view"><div className="dictionary-head"><div><h3>项目发音词典</h3><p>合成前按顺序替换文本，用于多音字、人名、地名和特殊读法。替换后的文本参与缓存计算。</p></div><span>{entries.length} 条规则</span></div><div className="dictionary-form"><label><span>原文词语</span><input value={term} placeholder="例如：重庆" onChange={(event) => setTerm(event.target.value)} /></label><label><span>送入模型的读法</span><input value={replacement} placeholder="例如：重 庆" onChange={(event) => setReplacement(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') add(); }} /></label><button className="button primary-button" type="button" disabled={!term.trim() || !replacement.trim()} onClick={add}><Save size={14} />添加规则</button></div><div className="dictionary-table"><div className="dictionary-table-head"><span>原文</span><span>合成读法</span><span>作用范围</span><span /></div>{entries.map((entry) => <article key={entry.id}><strong>{entry.term}</strong><span>{entry.replacement}</span><small>当前作品全部场景</small><button type="button" aria-label={`删除${entry.term}`} onClick={() => onChange(entries.filter((item) => item.id !== entry.id))}><Trash2 size={14} /></button></article>)}{entries.length === 0 ? <div className="dictionary-empty"><BookType size={22} /><p>还没有发音规则。没有规则时，原文将直接送入语音模型。</p></div> : null}</div></section>;
}

export function ProductionView({ project, mediaReport, currentSceneId, onSceneChange, onUpdateLine, onUpdateDictionary, onExportScene, onExportEpisode, onOneClick, oneClickToken, onGenerateMissing, generating, exporting, taskRefreshToken, onToast }) {
  const [tab, setTab] = useState('mix');
  const tabTitle = useMemo(() => tabs.find((item) => item.id === tab)?.label, [tab]);
  // The 一键成片 button lives in the mix tab but progress renders in the
  // tasks tab; a click with zero visible feedback reads as broken (OV-8).
  useEffect(() => { if (oneClickToken) setTab('tasks'); }, [oneClickToken]);
  return <main className="asset-view production-view"><header className="view-header"><div><span className="view-kicker">从场景音频到完整成片</span><h2>制作中心</h2><p>时间轴混音、整集导出、持久任务与发音控制。</p></div><strong className="production-current">{tabTitle}</strong></header><nav className="production-tabs" aria-label="制作中心功能">{tabs.map(({ id, label, icon: Icon }) => <button className={tab === id ? 'is-active' : ''} type="button" key={id} onClick={() => setTab(id)}><Icon size={14} />{label}</button>)}</nav>{tab === 'mix' ? <MixWorkspace project={project} mediaReport={mediaReport} currentSceneId={currentSceneId} onSceneChange={onSceneChange} onUpdateLine={onUpdateLine} onExportScene={onExportScene} onExportEpisode={onExportEpisode} onOneClick={onOneClick} onGenerateMissing={onGenerateMissing} generating={generating} exporting={exporting} onToast={onToast} /> : null}{tab === 'tasks' ? <TaskHistory projectId={project.id} refreshToken={taskRefreshToken} onToast={onToast} /> : null}{tab === 'dictionary' ? <PronunciationDictionary entries={project.state.pronunciationDictionary || []} onChange={onUpdateDictionary} /> : null}</main>;
}

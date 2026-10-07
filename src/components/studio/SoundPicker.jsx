import { Music2, PauseCircle, PlayCircle, Search, Sparkles, Upload, WandSparkles, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';

const TABS = [
  { id: 'recommend', label: '推荐' },
  { id: 'builtin', label: '内置库' },
  { id: 'generate', label: 'AI 生成' },
  { id: 'upload', label: '本地导入' },
];
const TYPE_LABEL = { ambient: '环境声', sfx: '动作音效', music: '背景音乐' };
const SOURCE_LABEL = { builtin: '内置 · CC0', upload: '导入', generated: 'AI 生成' };

function formatSeconds(ms) {
  const seconds = Math.round((ms || 0) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// One entry point for a sound event's entire supply side: recommendations
// from its text description, the builtin CC0 library, AI generation, or a
// local file. Every candidate auditions before binding.
export function SoundPicker({ line, projectId, config, builtinAssets, onBind, onUpload, onGenerate, onClose, onToast }) {
  const [tab, setTab] = useState('recommend');
  const [recommendations, setRecommendations] = useState(null);
  const [query, setQuery] = useState('');
  const [playingId, setPlayingId] = useState(null);
  const [prompt, setPrompt] = useState(line.text || '');
  const [durationSec, setDurationSec] = useState(line.type === 'sfx' ? 4 : 16);
  const [generating, setGenerating] = useState(false);
  const [uploading, setUploading] = useState(false);
  const audioRef = useRef(null);
  const fileInput = useRef(null);

  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    let active = true;
    api.recommendSound(projectId, line.id).then((payload) => { if (active) setRecommendations(payload.recommendations); }).catch(() => { if (active) setRecommendations([]); });
    return () => { active = false; };
  }, [projectId, line.id]);

  const play = (asset) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playingId === asset.id) { audio.pause(); setPlayingId(null); return; }
    audio.src = asset.url;
    audio.play().then(() => setPlayingId(asset.id)).catch(() => { setPlayingId(null); onToast('素材无法播放'); });
  };
  const builtinVisible = builtinAssets.filter((asset) => asset.type === line.type && `${asset.name} ${(asset.tags || []).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()));
  const generate = async () => {
    if (!prompt.trim() || generating) return;
    setGenerating(true);
    try {
      const ok = await onGenerate(line, { prompt: prompt.trim(), durationSec: Number(durationSec) || undefined });
      if (ok) onClose();
    } finally { setGenerating(false); }
  };
  const upload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const ok = await onUpload(file, line);
      if (ok) onClose();
    } catch (error) { onToast(error.message); }
    finally { setUploading(false); event.target.value = ''; }
  };

  const row = (asset, extra) => (
    <div className="picker-row" key={asset.id}>
      <button className="picker-play" type="button" aria-label={`试听${asset.name}`} onClick={() => play(asset)}>{playingId === asset.id ? <PauseCircle size={15} fill="currentColor" /> : <PlayCircle size={15} fill="currentColor" />}</button>
      <div className="picker-copy"><strong>{asset.name}</strong><small>{asset.reason || (asset.tags || []).slice(0, 4).join(' · ') || TYPE_LABEL[asset.type]}</small></div>
      <span className="picker-duration">{formatSeconds(asset.durationMs)}</span>
      <span className={`source-chip is-${asset.source}`}>{SOURCE_LABEL[asset.source]}</span>
      <button className="button primary-button" type="button" onClick={() => { onBind(asset, line); onClose(); }}>绑定</button>
      {extra}
    </div>
  );

  return (
    <div className="modal-overlay" role="presentation" onMouseDown={onClose}>
      <div className="modal-card sound-picker" role="dialog" aria-modal="true" aria-label={`为${TYPE_LABEL[line.type]}获取素材`} onMouseDown={(event) => event.stopPropagation()}>
        <audio ref={audioRef} onEnded={() => setPlayingId(null)} onPause={() => setPlayingId(null)} />
        <header className="modal-header">
          <div>
            <span className="view-kicker">{TYPE_LABEL[line.type]} · {line.assetName ? `当前：${line.assetName}` : '尚未绑定'}</span>
            <h3>「{line.text?.slice(0, 26) || line.label}」获取素材</h3>
          </div>
          <button className="modal-close" type="button" aria-label="关闭" onClick={onClose}><X size={15} /></button>
        </header>
        <nav className="picker-tabs" role="tablist">
          {TABS.map(({ id, label }) => <button key={id} className={tab === id ? 'is-active' : ''} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}
        </nav>
        <div className="picker-body">
          {tab === 'recommend' ? (
            recommendations === null
              ? <div className="picker-empty">正在按描述匹配素材…</div>
              : recommendations.length
                ? recommendations.map((asset) => row(asset))
                : <div className="picker-empty">没有明显匹配的素材。可切到「内置库」浏览，或用「AI 生成」按描述定制。</div>
          ) : null}
          {tab === 'builtin' ? (
            <>
              <label className="search-field picker-search"><Search size={15} /><input aria-label="搜索内置素材" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={`搜索${TYPE_LABEL[line.type]}素材或标签`} /></label>
              {builtinVisible.length ? builtinVisible.map((asset) => row(asset)) : <div className="picker-empty">没有匹配的内置素材。</div>}
              <p className="picker-note">内置素材为 CC0 授权（随声场分发），成片使用无需署名。</p>
            </>
          ) : null}
          {tab === 'generate' ? (
            <>
              <label className="setting-field"><span>生成描述</span><textarea rows="3" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="描述想要的声音：环境、动作或音乐氛围" /></label>
              <label className="setting-field"><span>时长（秒）</span><input type="number" min="1" max="60" step="1" value={durationSec} onChange={(event) => setDurationSec(event.target.value)} /></label>
              {config?.sfxProvider === 'demo' ? <p className="picker-note is-warning">当前为离线演示引擎：生成的是占位音（链路真实，声音为合成示意）。在设置中配置音效生成服务后可产出真实素材。</p> : null}
              {config?.sfxProvider === 'custom' && !config?.hasSfxAccessKey ? <p className="picker-note is-warning">音效生成服务尚未配置完成，请先到「设置」填写接口与凭证。</p> : null}
              <div className="settings-actions"><button className="button primary-button" type="button" disabled={!prompt.trim() || generating} onClick={generate}><WandSparkles size={14} />{generating ? '正在生成…' : '生成并绑定'}</button></div>
              <p className="picker-note">生成结果进入本地素材库（按描述缓存，重复生成同一描述直接命中）；来源清单会随整集导出。</p>
            </>
          ) : null}
          {tab === 'upload' ? (
            <>
              <input ref={fileInput} type="file" accept="audio/*" hidden onChange={upload} />
              <button className="picker-upload" type="button" disabled={uploading} onClick={() => fileInput.current?.click()}><Upload size={18} />{uploading ? '正在上传…' : '选择本地音频文件'}</button>
              <p className="picker-note">支持 MP3 / WAV / OGG / M4A / FLAC，上传后自动绑定到当前事件；授权由你自行保证。</p>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

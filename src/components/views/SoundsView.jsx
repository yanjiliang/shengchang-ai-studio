import { Music2, Pause, Play, Search, SlidersHorizontal, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Waveform } from '../studio/Waveform';

const filters = ['全部', '环境', '动作', '音乐', '人物主题', '关键音效'];
const categoryToTypes = { 环境: ['ambient'], 动作: ['sfx'], 关键音效: ['sfx'], 音乐: ['music'], 人物主题: ['music'] };
const eventTypeLabel = { ambient: '环境声', sfx: '动作音效', music: '音乐' };

export function SoundsView({ assets, sceneUsage, sceneEvents = [], sceneTitle, onUpload, onBindAsset, onDeleteAsset, onUpdateAsset, onToast }) {
  const fileInput = useRef(null);
  const audioRef = useRef(null);
  const [filter, setFilter] = useState('全部');
  const [query, setQuery] = useState('');
  const [playingId, setPlayingId] = useState(null);
  const [pendingBind, setPendingBind] = useState(null);
  useEffect(() => {
    if (!pendingBind) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setPendingBind(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingBind]);
  const usageCount = (asset) => sceneUsage?.[asset.id] || 0;
  const allAssets = assets;
  const visibleAssets = useMemo(() => allAssets.filter((item) => {
    const matchesFilter = filter === '全部' || item.category === filter;
    const haystack = `${item.name} ${item.category} ${(item.tags || []).join(' ')}`.toLowerCase();
    return matchesFilter && haystack.includes(query.trim().toLowerCase());
  }), [allAssets, filter, query]);
  const playAsset = (asset) => {
    if (!asset.url) { onToast('素材文件不存在，请重新导入'); return; }
    if (playingId === asset.id) { audioRef.current?.pause(); setPlayingId(null); return; }
    setPlayingId(asset.id);
    audioRef.current.src = asset.url;
    audioRef.current.play().catch(() => setPlayingId(null));
  };
  const upload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try { await onUpload(file); onToast(`声音素材已导入：${file.name}`); }
    catch (error) { onToast(error.message); }
    finally { event.target.value = ''; }
  };
  const startBind = (asset) => {
    if (!sceneEvents.length) { onToast(sceneTitle ? `场景「${sceneTitle}」还没有声音事件，请先在场景导演中添加` : '请先创建一个场景'); return; }
    const preferred = categoryToTypes[asset.category] || [];
    const candidates = sceneEvents.filter((line) => preferred.includes(line.type));
    const pool = candidates.length ? candidates : sceneEvents;
    if (pool.length === 1) { onBindAsset(asset, pool[0]); return; }
    setPendingBind({ asset, pool });
  };
  return (
    <main className="asset-view">
      <audio ref={audioRef} onEnded={() => setPlayingId(null)} />
      <input ref={fileInput} type="file" accept="audio/*" hidden onChange={upload} />
      <header className="view-header"><div><span className="view-kicker">整部作品共享</span><h2>声音素材</h2><p>导入环境、动作、音乐与人物主题，并绑定到场景声音事件。</p></div><div className="header-actions"><button className="button primary-button" type="button" onClick={() => fileInput.current?.click()}><Upload size={15} />导入音频</button></div></header>
      <div className="asset-toolbar"><label className="search-field"><Search size={15} /><input aria-label="搜索声音" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索声音、类型或标签" /></label></div>
      <div className="sound-layout"><aside className="filter-sidebar"><div className="section-caption">声音类型</div>{filters.map((item) => <button key={item} className={filter === item ? 'is-active' : ''} type="button" onClick={() => setFilter(item)}><span>{item}</span><b>{item === '全部' ? allAssets.length : allAssets.filter((asset) => asset.category === item).length}</b></button>)}<div className="sound-engine-note"><Music2 size={18} /><strong>声音世界基准</strong><p>写实、克制、近距离。导入的实际素材会在成片导出时进入声床混音。</p></div></aside>
        <section className="sound-table"><div className="sound-table-head"><span>声音</span><span>类型</span><span>标签</span><span>使用</span><span>时长</span><span /><span /></div>{visibleAssets.length ? visibleAssets.map((asset) => <article className="sound-row" key={asset.id}><button className="sound-play" type="button" aria-label={`试听${asset.name}`} onClick={() => playAsset(asset)}>{playingId === asset.id ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}</button><div className="sound-name"><strong>{asset.name}</strong><Waveform color={asset.color || 'var(--color-mint)'} url={asset.url} /></div><select className="category-select" aria-label={`${asset.name}的声音类型`} value={asset.category} onChange={(event) => onUpdateAsset(asset.id, { category: event.target.value })}>{filters.filter((item) => item !== '全部').map((item) => <option key={item} value={item}>{item}</option>)}</select><span className="asset-tags">{(asset.tags || []).map((tag) => <i key={tag}>{tag}</i>)}</span><span className="asset-usage">{usageCount(asset) ? `${usageCount(asset)} 处` : '未使用'}</span><span className="asset-duration">{asset.duration || '—'}</span><button className="asset-action" type="button" aria-label={`绑定${asset.name}到场景`} title={sceneTitle ? `绑定到场景「${sceneTitle}」的声音事件` : '绑定到场景声音事件'} disabled={!asset.url} onClick={() => startBind(asset)}><SlidersHorizontal size={15} /></button><button className="asset-action" type="button" aria-label={`删除${asset.name}`} title="删除素材" onClick={() => onDeleteAsset(asset)}><Trash2 size={15} /></button></article>) : <div className="empty-sound-library"><Music2 size={20} /><strong>{query ? '没有匹配的声音素材' : '还没有声音素材'}</strong><p>{query ? '调整搜索词或声音类型。' : '导入实际音频文件后，可试听并绑定到当前场景。'}</p></div>}</section></div>
      {pendingBind ? (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="选择要绑定的声音事件" onClick={() => setPendingBind(null)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <header className="modal-header"><div><span className="view-kicker">{sceneTitle ? `场景「${sceneTitle}」` : '当前场景'}</span><h3>把「{pendingBind.asset.name}」绑定到…</h3></div><button className="modal-close" type="button" aria-label="关闭" onClick={() => setPendingBind(null)}><X size={15} /></button></header>
            <div className="bind-options">{pendingBind.pool.map((line) => <button className="bind-option" type="button" key={line.id} onClick={() => { onBindAsset(pendingBind.asset, line); setPendingBind(null); }}><span className={`event-type-dot dot-${line.type}`} /><span className="bind-option-kind">{eventTypeLabel[line.type] || line.label}</span><span className="bind-option-text">{line.text || line.label}</span>{line.assetName ? <span className="bind-option-current">当前：{line.assetName}</span> : null}</button>)}</div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

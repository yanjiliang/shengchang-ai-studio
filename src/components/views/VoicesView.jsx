import { Check, LoaderCircle, LockKeyhole, Save, Search, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

export function VoicesView({ characters, voiceMap, voiceDesignConfig, onDesignVoice, onSetVoice, onToast }) {
  const [selectedId, setSelectedId] = useState(characters[0]?.id || 'narrator');
  const [designing, setDesigning] = useState(false);
  const [query, setQuery] = useState('');
  const [voiceId, setVoiceId] = useState('');
  useEffect(() => {
    if (!characters.some((item) => item.id === selectedId)) setSelectedId(characters[0]?.id || 'narrator');
  }, [characters, selectedId]);
  const selected = characters.find((item) => item.id === selectedId) || characters[0];
  const configuredVoiceId = selected ? voiceMap?.[selected.id] || '' : '';
  const visibleCharacters = characters.filter((character) => `${character.name} ${character.role} ${voiceMap?.[character.id] || ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => setVoiceId(configuredVoiceId), [configuredVoiceId, selected?.id]);
  if (!selected) return <main className="asset-view"><div className="empty-project"><h2>还没有角色</h2><p>导入并拆解小说后，识别出的角色会出现在这里。</p></div></main>;
  const design = async () => {
    setDesigning(true);
    try {
      const result = await onDesignVoice({ characterId: selected.id, voiceId, description: selected.description, sampleText: `${selected.name}，这是我在整部作品中保持一致的声音。` });
      onToast(result.status === 1 ? `音色设计任务已提交：${result.voiceId}` : `音色已设计并锁定：${result.voiceId}`);
    } catch (error) { onToast(error.message); }
    finally { setDesigning(false); }
  };
  return (
    <main className="asset-view voices-view">
      <header className="view-header"><div><span className="view-kicker">当前作品的角色资产</span><h2>角色音色</h2><p>每个角色的 voice_id 随项目保存，不会与其他小说混用；在右侧详情中绑定或设计音色。</p></div></header>
      <div className="asset-toolbar"><label className="search-field"><Search size={15} /><input aria-label="搜索角色" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索角色或音色 ID" /></label><div className="toolbar-summary"><span><Check size={13} />{Object.values(voiceMap || {}).filter(Boolean).length} / {characters.length} 个角色已锁定</span><span>按项目独立保存</span></div></div>
      <div className="voice-workspace">
        <section className="voice-list" aria-label="角色列表">
          {visibleCharacters.map((character) => {
            const mapped = voiceMap?.[character.id];
            return <button className={`voice-list-row ${selectedId === character.id ? 'is-selected' : ''}`} type="button" key={character.id} onClick={() => setSelectedId(character.id)}><span className="large-avatar" style={{ '--avatar-color': character.color || 'var(--color-accent)' }}>{character.name.slice(0, 1)}</span><span className="voice-list-copy"><strong>{character.name}<small>{character.role}</small></strong><span>{character.description}</span><span className="voice-traits">{(character.traits || []).map((trait) => <i key={trait}>{trait}</i>)}</span></span><span className="voice-score"><b>{mapped ? '已配置' : '待配置'}</b><small>{mapped || '没有 voice_id'}</small></span><span className="lock-cell"><LockKeyhole size={13} /></span></button>;
          })}
        </section>
        <aside className="voice-detail">
          <div className="detail-top"><div className="detail-avatar" style={{ '--avatar-color': selected.color || 'var(--color-accent)' }}>{selected.name.slice(0, 1)}</div><div><span>{selected.role}</span><h3>{selected.name}</h3><p>{configuredVoiceId || '尚未绑定真实 voice_id'}</p></div></div>
          <div className={`voice-lock-banner ${configuredVoiceId ? '' : 'is-unconfigured'}`}><LockKeyhole size={15} /><span><strong>{configuredVoiceId ? '真实音色身份已锁定' : '角色音色尚未完成'}</strong><small>{configuredVoiceId ? '所有场景固定使用这个 voice_id' : '填写控制台音色库中的 speaker_id / voice_id 后锁定到当前作品'}</small></span></div>
          <label className="setting-field voice-id-field"><span>豆包 speaker_id / voice_id</span><input value={voiceId} placeholder="填写角色固定使用的音色 ID" onChange={(event) => setVoiceId(event.target.value)} /></label>
          <button className="button primary-button full-button" type="button" disabled={!voiceId.trim() || voiceId.trim() === configuredVoiceId} onClick={() => { onSetVoice(selected.id, voiceId.trim()); onToast(`已绑定 ${selected.name} 的 voice_id`); }}><Save size={14} />保存 voice_id</button>
          <dl className="voice-facts"><div><dt>角色定位</dt><dd>{selected.role || '角色'}</dd></div><div><dt>项目音色</dt><dd>{configuredVoiceId ? '已锁定' : '待配置'}</dd></div><div><dt>角色 ID</dt><dd>{selected.id}</dd></div><div><dt>一致性策略</dt><dd>固定 ID</dd></div></dl>
          <section className="voice-description"><div className="section-caption">声音圣经</div><p>{selected.description}</p><div className="voice-boundary"><span>表演边界</span><p>允许情绪变化，但保持共鸣位置、发声年龄与句尾习惯稳定。高强度情绪优先改变气息与节奏，不改变基础音色。</p></div></section>
          <div className="voice-actions"><button className="button secondary-button full-button" type="button" disabled={designing || !voiceId.trim() || voiceDesignConfig?.provider !== 'volcengine-api-key'} onClick={design}><Sparkles size={15} />{designing ? '正在提交' : '设计当前音色'}</button><p>先填写控制台预创建的音色槽位 speaker_id。音色设计复用“模型连接”中的新版 API Key，并会消耗控制台额度。</p></div>
        </aside>
      </div>
    </main>
  );
}

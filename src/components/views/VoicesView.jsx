import { AlertTriangle, Check, LoaderCircle, LockKeyhole, Save, Search, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { chainApi } from '../../lib/chain-api.js';
import { goFixText, missingNames, missingText, missingVoiceRoles } from '../../lib/one-click.js';
import { DirectableBadge } from '../DirectableBadge';
import { castDirectableBanner } from '../../lib/directable';
import { singleAudio } from '../../lib/single-audio.js';
import { emptyDraft, roleLines, roleVoiceStatus, staleLineCount, voiceFromReference } from '../../lib/voice-design.js';
import { VoiceDesignPanel } from '../voice/VoiceDesignPanel';

// Field names and values are the casting contract with the server's one-click
// voice assignment: user-set values win over the analyzer's guesses.
// Stored values are the same Chinese words the story analyzer writes.
export const GENDER_OPTIONS = ['男', '女', '未知'];
export const AGE_OPTIONS = ['儿童', '少年', '青年', '中年', '老年', '未知'];
const normalize = (options, value) => (options.includes(value) ? value : '未知');

// breeze：本地 Breeze 模式（声音设计 handoff v3）——不显示 voice_id / 可导演，改成描述生成 / 上传录音 + 锁定参考音色。
export function VoicesView({ characters: rawCharacters, voiceReferences = null, voiceMap, voiceDesignConfig, onDesignVoice, onSetVoice, onUpdateCharacter, onToast, breeze = null, scenes = [], projectId = '', voiceDrafts = null, onApplyVoice, onOpenSettings, initialRoleId = '', focusRequest = 0 }) {
  // Breeze：角色「定了什么声音」以服务端 state.voiceReferences 为准，角色上缓存的 voice 只补界面字段。
  const characters = useMemo(() => breeze && voiceReferences ? rawCharacters.map((character) => ({ ...character, voice: voiceFromReference(voiceReferences[character.id], character.voice) })) : rawCharacters, [rawCharacters, voiceReferences, breeze]);
  const [selectedId, setSelectedId] = useState(initialRoleId && characters.some((item) => item.id === initialRoleId) ? initialRoleId : characters[0]?.id || 'narrator');
  useEffect(() => { if (initialRoleId && characters.some((item) => item.id === initialRoleId)) setSelectedId(initialRoleId); }, [initialRoleId]); // eslint-disable-line react-hooks/exhaustive-deps
  // 同一时间只播一段：切换角色就停。
  useEffect(() => { singleAudio.stop(); }, [selectedId]);
  const [designing, setDesigning] = useState(false);
  const [query, setQuery] = useState('');
  const [voiceId, setVoiceId] = useState('');
  useEffect(() => {
    if (!characters.some((item) => item.id === selectedId)) setSelectedId(characters[0]?.id || 'narrator');
  }, [characters, selectedId]);
  const selected = characters.find((item) => item.id === selectedId) || characters[0];
  const directableBanner = castDirectableBanner({ characters, voiceMap, config: voiceDesignConfig });
  const configuredVoiceId = selected ? voiceMap?.[selected.id] || '' : '';
  const visibleCharacters = characters.filter((character) => `${character.name} ${character.role} ${voiceMap?.[character.id] || ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  useEffect(() => setVoiceId(configuredVoiceId), [configuredVoiceId, selected?.id]);
  if (selected && breeze) return <BreezeVoicesView {...{ characters, scenes, selected, selectedId, setSelectedId, query, setQuery, visibleCharacters, breeze, projectId, voiceDrafts, onApplyVoice, onToast, onOpenSettings, focusRequest }} />;
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
          {directableBanner ? <p className="drift-risk-hint directable-banner" role="note"><AlertTriangle size={12} />{directableBanner}</p> : null}
          {visibleCharacters.map((character) => {
            const mapped = voiceMap?.[character.id];
            return <button className={`voice-list-row ${selectedId === character.id ? 'is-selected' : ''}`} type="button" key={character.id} onClick={() => setSelectedId(character.id)}><span className="large-avatar" style={{ '--avatar-color': character.color || 'var(--color-accent)' }}>{character.name.slice(0, 1)}</span><span className="voice-list-copy"><strong>{character.name}<small>{character.role}</small></strong><span>{character.description}</span><span className="voice-traits">{(character.traits || []).map((trait) => <i key={trait}>{trait}</i>)}</span></span><span className="voice-score"><b>{mapped ? '已配置' : '待配置'}</b><small>{mapped || '没有 voice_id'}</small><DirectableBadge voiceId={mapped} /></span><span className="lock-cell"><LockKeyhole size={13} /></span></button>;
          })}
        </section>
        <aside className="voice-detail">
          <div className="detail-top"><div className="detail-avatar" style={{ '--avatar-color': selected.color || 'var(--color-accent)' }}>{selected.name.slice(0, 1)}</div><div><span>{selected.role}</span><h3>{selected.name}<DirectableBadge voiceId={configuredVoiceId} /></h3><p>{configuredVoiceId || '尚未绑定真实 voice_id'}</p></div></div>
          <div className={`voice-lock-banner ${configuredVoiceId ? '' : 'is-unconfigured'}`}><LockKeyhole size={15} /><span><strong>{configuredVoiceId ? '真实音色身份已锁定' : '角色音色尚未完成'}</strong><small>{configuredVoiceId ? '所有场景固定使用这个 voice_id' : '填写控制台音色库中的 speaker_id / voice_id 后锁定到当前作品'}</small></span></div>
          <div className="casting-fields">
            <label className="setting-field"><span>性别</span><select aria-label={`${selected.name}的性别`} value={normalize(GENDER_OPTIONS, selected.gender)} onChange={(event) => onUpdateCharacter(selected.id, { gender: event.target.value })}>{GENDER_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
            <label className="setting-field"><span>年龄段</span><select aria-label={`${selected.name}的年龄段`} value={normalize(AGE_OPTIONS, selected.age)} onChange={(event) => onUpdateCharacter(selected.id, { age: event.target.value })}>{AGE_OPTIONS.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
          </div>
          <p className="casting-hint">一键成片按性别和年龄段匹配预设音色；这里标注的值优先于自动拆解的判断。</p>
          <label className="setting-field voice-id-field"><span>豆包 speaker_id / voice_id</span><input value={voiceId} placeholder="填写角色固定使用的音色 ID" onChange={(event) => setVoiceId(event.target.value)} /></label>
          <button className="button primary-button full-button" type="button" disabled={!voiceId.trim() || voiceId.trim() === configuredVoiceId} onClick={() => { onSetVoice(selected.id, voiceId.trim()); onToast(`已绑定 ${selected.name} 的 voice_id`); }}><Save size={14} />保存 voice_id</button>
          <dl className="voice-facts"><div><dt>角色定位</dt><dd>{selected.role || '角色'}</dd></div><div><dt>性别 · 年龄</dt><dd>{normalize(GENDER_OPTIONS, selected.gender)} · {normalize(AGE_OPTIONS, selected.age)}</dd></div><div><dt>项目音色</dt><dd>{configuredVoiceId ? '已锁定' : '待配置'}</dd></div><div><dt>角色 ID</dt><dd>{selected.id}</dd></div><div><dt>一致性策略</dt><dd>固定 ID</dd></div></dl>
          <section className="voice-description"><div className="section-caption">声音圣经</div><p>{selected.description}</p><div className="voice-boundary"><span>表演边界</span><p>允许情绪变化，但保持共鸣位置、发声年龄与句尾习惯稳定。高强度情绪优先改变气息与节奏，不改变基础音色。</p></div></section>
          <div className="voice-actions"><button className="button secondary-button full-button" type="button" disabled={designing || !voiceId.trim() || voiceDesignConfig?.provider !== 'volcengine-api-key'} onClick={design}><Sparkles size={15} />{designing ? '正在提交' : '设计当前音色'}</button><p>先填写控制台预创建的音色槽位 speaker_id。音色设计复用“模型连接”中的新版 API Key，并会消耗控制台额度。</p></div>
        </aside>
      </div>
    </main>
  );
}

function BreezeVoicesView({ characters, scenes, selected, selectedId, setSelectedId, query, setQuery, visibleCharacters, breeze, projectId, voiceDrafts, onApplyVoice, onToast, onOpenSettings, focusRequest = 0 }) {
  const lockedCount = characters.filter((character) => character.voice?.referenceId).length;
  const lines = roleLines(scenes, selected.id);
  // 还没定声音的角色（GET /api/projects/{id}/voice-readiness；读不到就按项目自己算）。
  const [readiness, setReadiness] = useState(null);
  useEffect(() => {
    let alive = true;
    chainApi.voiceReadiness(projectId).then((result) => { if (alive) setReadiness(result); }).catch(() => { if (alive) setReadiness(null); });
    return () => { alive = false; };
  }, [projectId, lockedCount]);
  const missing = missingVoiceRoles({ readiness, config: { ttsEngine: 'breeze' }, characters, scenes });
  // 「去给X定声音」：选中那个角色，焦点放到声音描述框。
  const [focusToken, setFocusToken] = useState(focusRequest);
  useEffect(() => { if (focusRequest) setFocusToken(focusRequest); }, [focusRequest]);
  const goFix = (roleId) => { setSelectedId(roleId); setFocusToken(Date.now()); };
  return (
    <main className="asset-view voices-view is-breeze">
      <header className="view-header"><div><span className="view-kicker">当前作品的角色资产 · 本地 Breeze</span><h2>角色音色</h2><p>每个角色锁定一段参考音频，之后的每句台词都从它克隆。参考音色随项目保存，不和其他小说混用。</p></div></header>
      <div className="asset-toolbar"><label className="search-field"><Search size={15} /><input aria-label="搜索角色" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索角色" /></label><div className="toolbar-summary"><span><Check size={13} />{lockedCount} / {characters.length} 个角色已定声音</span><span>按项目独立保存</span></div></div>
      {missing.length ? <div className="readiness-banner" role="status"><AlertTriangle size={14} aria-hidden="true" /><div><strong>{missingText(missing)}</strong><p>{missingNames(missing)}</p></div>{missing[0].roleId !== selected.id || !focusToken ? <button className="button secondary-button" type="button" onClick={() => goFix(missing[0].roleId)}>{goFixText(missing)}</button> : null}</div> : null}
      <div className="voice-workspace">
        <section className="voice-list" aria-label="角色列表">
          {visibleCharacters.map((character) => {
            const draft = voiceDrafts?.drafts?.[character.id];
            const status = roleVoiceStatus(character, draft);
            const stale = character.voice?.referenceId ? staleLineCount(roleLines(scenes, character.id)) : 0;
            const tone = character.voice?.referenceId ? 'is-locked' : status === '未设计' ? 'is-empty' : 'is-working';
            return <button className={`voice-list-row ${selectedId === character.id ? 'is-selected' : ''}`} type="button" key={character.id} aria-current={selectedId === character.id ? 'true' : undefined} onClick={() => setSelectedId(character.id)}><span className="large-avatar" style={{ '--avatar-color': character.color || 'var(--color-accent)' }}>{character.name.slice(0, 1)}</span><span className="voice-list-copy"><strong>{character.name}<small>{character.role}</small></strong><span>{character.voice?.description || character.description}</span></span><span className="voice-score"><b className={`role-status-pill ${tone}`}>{status}</b>{stale ? <small className="stale-pill">{stale} 句需重渲</small> : null}</span><span className="lock-cell">{character.voice?.referenceId ? <LockKeyhole size={13} aria-label="已锁定" /> : null}</span></button>;
          })}
        </section>
        <aside className="voice-detail" aria-label={`${selected.name}的声音设计`}>
          <div className="detail-top"><div className="detail-avatar" style={{ '--avatar-color': selected.color || 'var(--color-accent)' }}>{selected.name.slice(0, 1)}</div><div><span>{selected.role}</span><h3>{selected.name}</h3><p>{lines.length} 句台词</p></div></div>
          <VoiceDesignPanel key={selected.id} character={selected} characters={characters} lines={lines} draft={voiceDrafts?.drafts?.[selected.id] || emptyDraft(selected.voice?.description || '')} actions={voiceDrafts} breeze={breeze} projectId={projectId} onApplyVoice={onApplyVoice} onToast={onToast} onOpenSettings={onOpenSettings} focusToken={selected.id === selectedId ? focusToken : 0} />
        </aside>
      </div>
    </main>
  );
}

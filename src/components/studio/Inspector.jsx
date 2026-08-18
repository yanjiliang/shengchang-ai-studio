import { Check, CircleDot, LockKeyhole, MapPin, Mic2, Volume2 } from 'lucide-react';
import { useState } from 'react';

const emotions = ['警惕', '怀疑', '克制', '疲惫', '愤怒', '悲伤'];

function RangeField({ label, value, suffix, min = 0, max = 100, onChange }) {
  return (
    <label className="range-field">
      <span><b>{label}</b><output>{value}{suffix}</output></span>
      <input type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

export function Inspector({ line, characters = [], voiceMap = {}, provider, onUpdate, onOpenVoices }) {
  const [tab, setTab] = useState('performance');

  if (!line || line.type !== 'dialogue') {
    return (
      <aside className="inspector">
        <div className="inspector-title"><strong>声音事件</strong><span><Check size={12} />已保存</span></div>
        <div className="event-inspector-empty"><CircleDot size={28} /><h3>{line?.label || '选择一个事件'}</h3>{line ? <textarea className="intent-editor" rows="6" value={line.text || ''} onChange={(event) => onUpdate({ text: event.target.value })} /> : <p>选择对白或声音事件，在这里调整生成参数。</p>}</div>
      </aside>
    );
  }

  const character = characters.find((item) => item.id === line.speakerId) || { id: line.speakerId, name: line.speaker || '未命名角色' };
  const voiceId = voiceMap?.[line.speakerId] || '';
  return (
    <aside className="inspector">
      <div className="inspector-title"><strong>导演检查器</strong><span><Check size={12} />已保存</span></div>
      <div className="inspector-tabs" role="tablist">
        <button className={tab === 'performance' ? 'is-active' : ''} type="button" onClick={() => setTab('performance')}>表演</button>
        <button className={tab === 'voice' ? 'is-active' : ''} type="button" onClick={() => setTab('voice')}>声音</button>
        <button className={tab === 'space' ? 'is-active' : ''} type="button" onClick={() => setTab('space')}>空间</button>
      </div>
      {tab === 'performance' ? (
        <>
          <section className="inspector-section">
            <div className="section-caption">当前角色</div>
            <button className="character-selector" type="button" onClick={onOpenVoices}>
              <span className="character-avatar" style={{ '--avatar-color': character.color || 'var(--color-accent)' }}>{character.name.slice(0, 1)}</span>
              <span><strong>{character.name}</strong><small>{voiceId || '尚未绑定 voice_id'}</small></span>
              <span className="voice-lock"><LockKeyhole size={11} />{voiceId ? '已绑定' : '待配置'}</span>
            </button>
            <div className="similarity-row"><span>当前音频</span><b>{line.audioUrl ? '已生成' : '待生成'}</b></div>
          </section>
          <section className="inspector-section">
            <div className="section-caption">说话意图</div>
            <textarea className="intent-editor" rows="4" value={line.subtext} onChange={(event) => onUpdate({ subtext: event.target.value })} />
          </section>
          <section className="inspector-section">
            <div className="section-caption">情绪与力度</div>
            <div className="emotion-options">
              {emotions.map((emotion) => <button key={emotion} className={line.emotion === emotion ? 'is-active' : ''} type="button" onClick={() => onUpdate({ emotion })}>{emotion}</button>)}
            </div>
            <RangeField label="情绪强度" value={line.intensity} suffix="%" onChange={(intensity) => onUpdate({ intensity })} />
            <RangeField label="语速" value={line.pace} suffix="%" min={70} max={120} onChange={(pace) => onUpdate({ pace })} />
          </section>
          <section className="inspector-section continuity-section">
            <div className="section-caption">连续性</div>
            <div className="continuity-note"><Check size={15} /><p>人物一致性由项目固定 voice_id 保证；修改台词或表演参数后需重新生成当前音频。</p></div>
          </section>
        </>
      ) : null}
      {tab === 'voice' ? (
        <section className="inspector-section inspector-stack">
          <div className="section-caption">语音合成</div>
          <div className="parameter-row"><Mic2 size={15} /><span>语音适配器</span><b>{provider || '未配置'}</b></div>
          <div className="parameter-row"><LockKeyhole size={15} /><span>项目 voice_id</span><b>{voiceId || '待配置'}</b></div>
          <div className="parameter-row"><Check size={15} /><span>生成状态</span><b>{line.audioUrl ? '已有音频' : '没有音频'}</b></div>
          <button className="button secondary-button full-button" type="button" onClick={onOpenVoices}>管理角色音色</button>
        </section>
      ) : null}
      {tab === 'space' ? (
        <section className="inspector-section inspector-stack">
          <div className="section-caption">声场位置</div>
          <div className="parameter-row"><MapPin size={15} /><span>说话距离</span><b>{line.distance || '近讲'}</b></div>
          <label className="setting-field"><span>声音距离提示</span><select value={line.distance || '近讲'} onChange={(event) => onUpdate({ distance: event.target.value })}><option value="耳语">耳语</option><option value="近讲">近讲</option><option value="中距">中距</option><option value="远距">远距</option></select></label>
          <div className="parameter-row"><Volume2 size={15} /><span>用途</span><b>作为合成表演提示</b></div>
        </section>
      ) : null}
    </aside>
  );
}

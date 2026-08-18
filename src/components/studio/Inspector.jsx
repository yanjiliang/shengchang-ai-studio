import { Check, CircleDot, FlaskConical, LockKeyhole, MapPin, Mic2, Volume2 } from 'lucide-react';
import { useEffect, useState } from 'react';

const emotions = ['警惕', '怀疑', '克制', '疲惫', '愤怒', '悲伤'];

// Direction-lab takes (Approach C): the same line under three contrasting
// directions. The pitch is the direction layer itself — identical text and
// voice, audibly different performances.
const labPresets = (line) => [
  { name: 'A · 隐忍克制', emotion: '克制', intensity: 30, subtext: '压住情绪，话里有话', distance: line?.distance || '近讲' },
  { name: 'B · 情绪外放', emotion: '愤怒', intensity: 85, subtext: '情绪决堤，音量抬高', distance: '近讲' },
  { name: 'C · 耳语试探', emotion: '警惕', intensity: 45, subtext: '贴近耳边，压低声音试探', distance: '耳语' },
];

function RangeField({ label, value, suffix, min = 0, max = 100, onChange }) {
  return (
    <label className="range-field">
      <span><b>{label}</b><output>{value}{suffix}</output></span>
      <input type="range" min={min} max={max} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

export function Inspector({ line, characters = [], voiceMap = {}, provider, onUpdate, onOpenVoices, onLabGenerate, lab, labGenerating }) {
  const [tab, setTab] = useState('performance');
  const [labOpen, setLabOpen] = useState(false);
  const [variants, setVariants] = useState(() => labPresets(line));

  // Variants reset to presets when the selected line changes; edits within a
  // line survive re-renders (state object identity changes on every keystroke,
  // so the dependency has to be the id, not the object).
  useEffect(() => { setVariants(labPresets(line)); setLabOpen(false); }, [line?.id]);
  const updateVariant = (index, patch) => setVariants((current) => current.map((variant, position) => position === index ? { ...variant, ...patch } : variant));

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
          <section className="inspector-section lab-section">
            <div className="section-caption">方向实验室</div>
            <button className="lab-toggle" type="button" onClick={() => setLabOpen((open) => !open)}><FlaskConical size={12} />{labOpen ? '收起对比' : '同一句台词，试三种演法'}</button>
            {labOpen ? (
              <>
                <p className="lab-hint">对比只用于试听，不会写回台词；应用某个方向后重新生成，会直接命中缓存、瞬间完成。</p>
                {variants.map((variant, index) => {
                  const audio = lab?.lineId === line.id ? lab.results?.[index]?.url : '';
                  const emotionOptions = emotions.includes(variant.emotion) ? emotions : [variant.emotion, ...emotions];
                  return (
                    <div className="lab-variant" key={variant.name}>
                      <div className="lab-variant-head">
                        <b>{variant.name}</b>
                        <button type="button" onClick={() => onUpdate({ emotion: variant.emotion, intensity: variant.intensity, subtext: variant.subtext, distance: variant.distance })}>应用方向</button>
                      </div>
                      <label className="lab-field"><span>情绪</span><select value={variant.emotion} onChange={(event) => updateVariant(index, { emotion: event.target.value })}>{emotionOptions.map((emotion) => <option key={emotion} value={emotion}>{emotion}</option>)}</select></label>
                      <RangeField label="强度" value={variant.intensity} suffix="%" onChange={(intensity) => updateVariant(index, { intensity })} />
                      <label className="lab-field"><span>潜台词</span><input value={variant.subtext} onChange={(event) => updateVariant(index, { subtext: event.target.value })} /></label>
                      {audio ? <audio controls preload="none" src={audio} /> : null}
                    </div>
                  );
                })}
                <button className="button secondary-button full-button" type="button" disabled={labGenerating} onClick={() => onLabGenerate(line, variants)}>{labGenerating ? '正在生成对比…' : '生成对比试听'}</button>
              </>
            ) : null}
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

import { GripVertical, Play, RefreshCcw, Trash2 } from 'lucide-react';
import { Waveform } from './Waveform';

const typeColors = {
  ambient: 'var(--color-mint)',
  sfx: 'var(--color-gold)',
  music: 'var(--color-violet)',
};

export function ScriptLine({ line, character, selected, onSelect, onTextChange, onRegenerate, onPlay, onDelete }) {
  if (line.type !== 'dialogue') {
    return (
      <div className={`sound-event sound-${line.type}`}>
        <button className="sound-event-main" type="button" onClick={() => { onSelect(); if (line.assetUrl) onPlay(); }}>
          <span className="event-grip"><GripVertical size={14} /></span>
          <span className="event-type">{line.label}</span>
          {line.type === 'ambient' ? <Waveform color={typeColors[line.type]} /> : <span className="event-copy">{line.assetName ? `${line.text} · ${line.assetName}` : line.text}</span>}
          <span className="event-time">{line.time}</span>
          <Play size={13} className="event-play" fill="currentColor" />
        </button>
        <button className="event-delete" type="button" aria-label={`删除${line.label}`} title="删除此事件" onClick={onDelete}><Trash2 size={13} /></button>
      </div>
    );
  }

  return (
    <article className={`dialogue-line ${selected ? 'is-selected' : ''}`} onClick={onSelect}>
      <span className="line-selection" />
      <button className="speaker-button" type="button" style={{ color: character?.color }} onClick={onSelect}>{line.speaker}</button>
      <div className="dialogue-body">
        <div className="delivery-line">{line.delivery}</div>
        <textarea
          className="dialogue-editor"
          value={line.text}
          rows={Math.max(1, Math.ceil(line.text.length / 22))}
          aria-label={`${line.speaker}的台词`}
          onClick={(event) => event.stopPropagation()}
          onFocus={onSelect}
          onChange={(event) => {
            event.currentTarget.style.height = 'auto';
            event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`;
            onTextChange(event.target.value);
          }}
        />
        <p className="subtext-line"><span>潜台词</span>{line.subtext}</p>
      </div>
      <div className="line-actions">
        {line.audioStale ? <span className="stale-badge" title="台词已修改，当前音频仍是旧版本">待重生成</span> : null}
        <button type="button" aria-label="试听本句" title="试听本句" disabled={!line.audioUrl} onClick={(event) => { event.stopPropagation(); onPlay(); }}><Play size={14} fill="currentColor" /></button>
        <button type="button" aria-label="重新生成本句" title="重新生成本句" onClick={(event) => { event.stopPropagation(); onRegenerate(); }}><RefreshCcw size={14} /></button>
        <button type="button" aria-label="删除本句" title="删除本句" onClick={(event) => { event.stopPropagation(); onDelete(); }}><Trash2 size={14} /></button>
      </div>
    </article>
  );
}

import { Play, RefreshCcw, Sparkles, Trash2 } from 'lucide-react';
import { deliveryLabel } from './delivery-label.js';
import { Waveform } from './Waveform';

const typeColors = {
  ambient: 'var(--color-mint)',
  sfx: 'var(--color-gold)',
  music: 'var(--color-violet)',
};


// Sound events carry no schedule of their own: the real entry point lives in
// mix.startMs (the timeline previews it); unbound events have nothing to show
// but that fact.
function eventTimeLabel(line) {
  if (!line.assetUrl) return '待绑定';
  const startMs = Number(line.mix?.startMs);
  return Number.isFinite(startMs) && line.mix.startMs !== '' ? `入点 ${(Math.max(0, startMs) / 1000).toFixed(1)}s` : '跟随场景';
}

export function ScriptLine({ line, provider, character, selected, onSelect, onTextChange, onRegenerate, onPlay, onAcquire, onDelete }) {
  if (line.type !== 'dialogue') {
    return (
      <div className={`sound-event sound-${line.type}`}>
        <button className="sound-event-main" type="button" onClick={() => { onSelect(); if (line.assetUrl) onPlay(); }}>
          <span className="event-type">{line.label}</span>
          {line.type === 'ambient' ? <Waveform color={typeColors[line.type]} url={line.assetUrl} /> : <span className="event-copy">{line.assetName ? `${line.text} · ${line.assetName}` : line.text}</span>}
          <span className="event-time">{eventTimeLabel(line)}</span>
          <Play size={13} className="event-play" fill="currentColor" />
        </button>
        <button className="event-acquire" type="button" aria-label={`获取${line.label}素材`} title={line.assetUrl ? '更换素材' : '获取素材'} onClick={onAcquire}><Sparkles size={13} /></button>
        <button className="event-delete" type="button" aria-label={`删除${line.label}`} title="删除此事件" onClick={onDelete}><Trash2 size={13} /></button>
      </div>
    );
  }

  return (
    <article
      className={`dialogue-line ${selected ? 'is-selected' : ''}`}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(); } }}
    >
      <span className="line-selection" />
      <button className="speaker-button" type="button" style={{ color: character?.color }} onClick={onSelect}>{line.speaker}</button>
      <div className="dialogue-body">
        <div className="delivery-line">{deliveryLabel(line, provider)}</div>
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

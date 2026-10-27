import { Check, ChevronDown, Flag, LoaderCircle, Pause, Play, PlayCircle, RotateCcw, Shuffle, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { singleAudio } from '../../lib/single-audio.js';
import { useSingleAudio } from '../../lib/useSingleAudio.js';
import { MARK_REASONS, MAX_TAKES, OFFLINE_REGEN, PREV_TAIL_SEC, formatClock, isMarked, jobText, regenHint, staleReasonText, takeTags } from '../../lib/review.js';

const SEED_NOTE = '仅存档，不能用来复现声音';
const engineName = (engine) => (engine === 'breeze' ? 'Breeze' : engine === 'doubao' ? '豆包' : engine || '—');
const seconds = (value) => (Number.isFinite(value) ? `${value.toFixed(1)} 秒` : '—');

export function Waveform({ peaks = [], label }) {
  if (!peaks.length) return <div className="review-wave is-empty" aria-hidden="true" />;
  return <div className="review-wave" role="img" aria-label={label}>{peaks.map((peak, index) => <span key={index} style={{ height: `${Math.max(6, peak * 100)}%` }} />)}</div>;
}

// seed 只放在「详情」里，标明只是存档。
function TakeDetails({ take }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="take-details">
      <button type="button" className="link-button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}><ChevronDown size={12} className={open ? 'is-open' : ''} aria-hidden="true" />详情</button>
      {open ? <dl id={id}><dt>seed</dt><dd>{take.seed ?? take.renderSeed ?? '—'}<small>{SEED_NOTE}</small></dd>{Number.isInteger(take.renderSeed) && Number.isInteger(take.seed) && take.renderSeed !== take.seed ? <><dt>实际生成</dt><dd>{take.renderSeed}<small>{SEED_NOTE}</small></dd></> : null}{take.createdAt ? <><dt>生成时间</dt><dd>{new Date(take.createdAt).toLocaleString('zh-CN', { hour12: false })}</dd></> : null}</dl> : null}
    </div>
  );
}

function driftCheck(take, nameOf) {
  // fe-0010：还没算出相似度 = 没有数据，这一行不显示（以前写「这一条还没算」）。
  if (!take?.drift || !Number.isFinite(take.drift.dOwn)) return null;
  if (take.drift.flagged) return { text: take.drift.nearest ? `可能换人，像${nameOf(take.drift.nearest)}` : '可能换人', tone: 'drift' };
  return { text: '和本角色一致', tone: 'ok' };
}

function CompareCard({ line, prevLine, prevIndex, original, fresh, nameOf, tailSegment, busy, onAccept, onKeep }) {
  const [withTail, setWithTail] = useState(true);
  const audio = useSingleAudio();
  const play = (take, which) => {
    const id = `compare:${which}:${take.takeId}`;
    if (audio.playing && audio.id === id) { singleAudio.stop(); return; }
    const items = [withTail && tailSegment ? { id, ...tailSegment } : null, { id, url: take.audioUrl }].filter(Boolean);
    singleAudio.playSequence(items);
  };
  const card = (take, which, title, tag) => {
    const check = driftCheck(take, nameOf);
    const playing = audio.playing && audio.id === `compare:${which}:${take.takeId}`;
    return (
      <div className={`compare-take is-${which}`}>
        <p className="compare-title"><strong>{title}</strong><span className="take-tag">{tag}</span></p>
        <Waveform peaks={take.peaks} label={`${title}波形`} />
        <p className="compare-meta">{engineName(take.engine)} · {seconds(take.durationSec)}</p>
        {check ? <p className={`compare-check is-${check.tone}`}>音色复检：{check.text}</p> : null}
        <button type="button" className="button secondary-button" aria-pressed={playing} onClick={() => play(take, which)}>{playing ? <Pause size={13} /> : <Play size={13} />}{playing ? '停止' : `听${title}`}</button>
        <TakeDetails take={take} />
      </div>
    );
  };
  return (
    <section className="compare-card" aria-label="新旧对比">
      <h4>新旧对比</h4>
      {prevLine && tailSegment ? <label className="compare-tail"><input type="checkbox" checked={withTail} onChange={(event) => setWithTail(event.target.checked)} />带上一句（第 {prevIndex + 1} 句 {prevLine.speaker || nameOf(prevLine.speakerId)}）结尾约 {PREV_TAIL_SEC} 秒</label> : null}
      <div className="compare-grid">{card(original, 'original', '原版', '当前')}{card(fresh, 'fresh', '新版', '刚生成')}</div>
      <div className="compare-actions">
        <button type="button" className="button primary-button" disabled={busy} onClick={onAccept}>{busy ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />}用新版</button>
        <button type="button" className="button secondary-button" disabled={busy} onClick={onKeep}>保留原版</button>
      </div>
      <p className="muted">用新版后整集需要重新混音；新旧两条音频都会保留在版本记录里。</p>
    </section>
  );
}

function History({ takes, activeTakeId, mixTakeId, pendingTakeId, busy, onUse }) {
  const audio = useSingleAudio();
  return (
    <section className="review-section" aria-labelledby="take-history-title">
      <h4 id="take-history-title">版本记录 <span className="muted">{takes.filter((take) => !take.original).length}/{MAX_TAKES}</span></h4>
      <p className="muted">最多保留 {MAX_TAKES} 版，超出时清理最早的、没在用的那版。</p>
      <ol className="take-history">
        {takes.map((take, index) => {
          const tags = takeTags(take, { activeTakeId, mixTakeId, pendingTakeId });
          const id = `history:${take.takeId}`;
          const playing = audio.playing && audio.id === id;
          return (
            <li key={take.takeId}>
              <button type="button" className="icon-button round" aria-label={`${playing ? '停止' : '播放'}${take.label || `第 ${index + 1} 版`}`} aria-pressed={playing} onClick={() => singleAudio.toggle(id, take.audioUrl)}>{playing ? <Pause size={13} /> : <Play size={13} />}</button>
              <div className="take-history-body">
                <strong>{take.original ? '第一次生成的原版' : take.label || `第 ${index + 1} 版`}</strong>
                <span className="muted">{engineName(take.engine)} · {seconds(take.durationSec)}</span>
                {tags.length ? <span className="take-tags">{tags.map((tag) => <span key={tag} className={`take-tag is-${tag === '待确认' ? 'pending' : 'on'}`}>{tag}</span>)}</span> : null}
                <TakeDetails take={take} />
              </div>
              {take.takeId !== activeTakeId && take.takeId !== pendingTakeId && !take.original ? <button type="button" className="button ghost-button" disabled={busy} onClick={() => onUse(take)}>改用这版</button> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// 右侧检查面板（手机：底部抽屉）。
export function ReviewInspector({ line, index, prevLine, timelineItem, sceneNumber, nameOf, emotions, takes: rawTakes, job, breezeOnline, batchRunning, busy, tailSegment, draft, onDraft, breezeMode = true, onPlayFrom, onToggleMark, onToggleReason, onRegen, onCancelJob, onAccept, onKeep, onUse, onClose }) {
  const audio = useSingleAudio();
  const titleId = useId();
  // line.renderSeed（0028 起）= 现在这条音频实际用的 seed：挂到音频就是这条的那版上，详情里显示。
  const takes = !line || !Number.isInteger(line.renderSeed) ? rawTakes : { ...rawTakes, takes: rawTakes.takes.map((take) => take.audioUrl && take.audioUrl === line.audioUrl ? { ...take, renderSeed: line.renderSeed } : take) };
  if (!line) return <aside className="review-inspector is-empty"><p className="muted">点一句台词，在这里标记问题或换一条。</p></aside>;
  const marked = isMarked(line);
  const edited = draft.text !== (line.text || '') || draft.emotion !== (line.emotion || '') || draft.subtext !== (line.subtext || '');
  const status = jobText(job && !breezeOnline && job.status === 'queued' ? { ...job, status: 'offline' } : job);
  const soloId = `solo:${line.id}`;
  const soloPlaying = audio.playing && audio.id === soloId;
  const original = takes.takes.find((take) => take.takeId === (takes.activeTakeId || line.activeTakeId));
  const fresh = takes.takes.find((take) => take.takeId === (takes.pendingTakeId || line.pendingTakeId));
  const generating = job && ['queued', 'running', 'stopping'].includes(job.status);
  const durationSec = original?.durationSec ?? (timelineItem?.end && timelineItem.start !== undefined ? timelineItem.end - timelineItem.start : [...String(line.text || '')].length * 0.19);
  return (
    <aside className="review-inspector" aria-labelledby={titleId}>
      <header className="inspector-head">
        <div>
          <h3 id={titleId} tabIndex={-1} className="inspector-title">第 {index + 1} 句 · {line.speaker || nameOf(line.speakerId)}</h3>
          <p className="muted">第 {sceneNumber} 场{line.emotion ? ` · ${line.emotion}` : ''}{timelineItem ? ` · 在整集 ${formatClock(timelineItem.start)} 处` : ''}</p>
        </div>
        {onClose ? <button type="button" className="button ghost-button" onClick={onClose}><X size={13} />收起</button> : null}
      </header>
      <p className="inspector-text">{line.text}</p>
      {line.audioUrl && line.stale === true ? <p className="inspector-stale" role="note"><strong>需重渲</strong> · {staleReasonText(line.staleReason)}</p> : null}
      <div className="inspector-row">
        <button type="button" className="button secondary-button" disabled={!line.audioUrl} aria-pressed={soloPlaying} onClick={() => singleAudio.toggle(soloId, line.audioUrl)}>{soloPlaying ? <Pause size={13} /> : <Play size={13} />}{soloPlaying ? '停止' : '只听这句'}</button>
        <button type="button" className="button ghost-button" disabled={!timelineItem} onClick={onPlayFrom}><PlayCircle size={13} />从这句开始播整集</button>
      </div>

      <section className="review-section" aria-labelledby={`${titleId}-mark`}>
        <h4 id={`${titleId}-mark`}>标记问题</h4>
        <button type="button" className={`button ${marked ? 'ghost-button' : 'primary-button'}`} aria-pressed={marked} onClick={onToggleMark}><Flag size={13} />{marked ? '已标记 · 取消标记' : '标记这句（M）'}</button>
        <div className="reason-chips" role="group" aria-label="原因（可选，可多选）">
          <span className="muted">原因（可选）</span>
          {MARK_REASONS.map((reason) => { const on = marked && line.mark.reasons?.includes(reason); return <button key={reason} type="button" className={`chip ${on ? 'is-on' : ''}`} aria-pressed={Boolean(on)} onClick={() => onToggleReason(reason)}>{reason}</button>; })}
        </div>
      </section>

      <section className="review-section" aria-labelledby={`${titleId}-regen`}>
        <h4 id={`${titleId}-regen`}>换一条</h4>
        <p className="muted">{breezeMode ? '每次「换一条」都用新的随机种子，旧的那条会留着。可以先改台词或情绪再换。' : '豆包不支持换种子：重新生成按字扣费，结果可能和原来差不多。可以先改台词或情绪再换。'}</p>
        <label className="field"><span>台词</span><textarea rows={2} value={draft.text} disabled={generating} onChange={(event) => onDraft({ text: event.target.value })} /></label>
        <div className="field-row">
          <label className="field"><span>情绪</span><select value={draft.emotion} disabled={generating} onChange={(event) => onDraft({ emotion: event.target.value })}>{[...new Set([line.emotion || '', ...emotions])].map((item) => <option key={item} value={item}>{item || '（不指定）'}</option>)}</select></label>
          <label className="field"><span>表演提示</span><input value={draft.subtext} disabled={generating} onChange={(event) => onDraft({ subtext: event.target.value })} /></label>
        </div>
        {status ? (
          <div className={`regen-status is-${job.status}`} aria-live="polite" role={job.status === 'failed' ? 'alert' : undefined}>
            <p><strong>{['queued', 'running', 'stopping'].includes(job.status) ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : null}{status.title}</strong>{status.detail ? <span>{status.detail}</span> : null}</p>
            {job.status === 'running' ? <div className="review-progress" role="progressbar" aria-label="生成进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((job.progress || 0) * 100)}><span style={{ width: `${Math.round((job.progress || 0) * 100)}%` }} /></div> : null}
            {status.note ? <p className="muted">{status.note}</p> : null}
            <div className="inspector-row">
              {status.cancel ? <button type="button" className="button ghost-button" onClick={onCancelJob}>{status.cancel}</button> : null}
              {status.retry ? <button type="button" className="button secondary-button" disabled={!breezeOnline} onClick={() => onRegen(edited)}><RotateCcw size={13} />{status.retry}</button> : null}
            </div>
          </div>
        ) : null}
        {!generating && job?.status !== 'failed' ? <>
          {breezeOnline ? <p className="muted">{regenHint({ edited, durationSec, batchRunning })}</p> : <p className="review-offline-note" role="note">{OFFLINE_REGEN}</p>}
          <button type="button" className="button primary-button" disabled={!breezeOnline || !line.audioUrl || !draft.text.trim() || Boolean(fresh)} title={fresh ? '先决定「用新版」还是「保留原版」' : undefined} onClick={() => onRegen(edited)}><Shuffle size={13} />换一条</button>
        </> : null}
        {fresh && original ? <CompareCard line={line} prevLine={prevLine} prevIndex={index - 1} original={original} fresh={fresh} nameOf={nameOf} tailSegment={tailSegment} busy={busy} onAccept={() => onAccept(fresh, original)} onKeep={() => onKeep(fresh)} /> : null}
      </section>

      {takes.error ? <p className="muted" role="alert">版本记录读取失败：{takes.error}</p> : takes.takes.length ? <History takes={takes.takes} activeTakeId={takes.activeTakeId} mixTakeId={takes.mixTakeId} pendingTakeId={takes.pendingTakeId} busy={busy} onUse={(take) => onUse(take, original)} /> : null}
    </aside>
  );
}

export function useDraft(line, pinned) {
  const empty = { text: line?.text || '', emotion: line?.emotion || '', subtext: line?.subtext || '' };
  const [draft, setDraft] = useState(empty);
  const key = line ? `${line.id}:${line.text}:${line.emotion}:${line.subtext}` : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!pinned) setDraft(empty); }, [key]);
  const dirty = Boolean(line) && (draft.text !== empty.text || draft.emotion !== empty.emotion || draft.subtext !== empty.subtext);
  return { draft, dirty, update: (patch) => setDraft((current) => ({ ...current, ...patch })), reset: () => setDraft(empty) };
}

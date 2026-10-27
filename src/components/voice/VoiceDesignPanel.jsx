import { AlertTriangle, Check, ChevronDown, LoaderCircle, LockKeyhole, Pause, Play, RefreshCw, RotateCcw, Sparkles, Upload, Wifi, WifiOff, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { chainApi } from '../../lib/chain-api.js';
import { BREEZE_LICENSE_FULL, BREEZE_TIME_NOTE, formatSeconds } from '../../lib/engine.js';
import { singleAudio } from '../../lib/single-audio.js';
import { useSingleAudio } from '../../lib/useSingleAudio.js';
import { CONSENT_TEXT, DIMENSIONS, NEUTRAL_SUFFIX, SEED_TOOLTIP, TAKE_COUNT, cancelButtonText, designPrompt, dimensionsCovered, draftRemainingSeconds, isGenerating, lockedVoice, referenceWarningTexts, staleLineCount, takeQueueText, uploadChecks } from '../../lib/voice-design.js';
import { LockDialog } from './LockDialog';

const VERSION_NAMES = ['第 1 版', '第 2 版', '第 3 版', '第 4 版', '第 5 版', '第 6 版'];
const versionName = (slot) => VERSION_NAMES[slot] || `第 ${slot + 1} 版`;
const formatTime = (iso) => { try { return new Date(iso).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

// seed 只在「详情」里显示，并写明只是存档（handoff v4）。
export function SeedDetails({ seed, id }) {
  const [open, setOpen] = useState(false);
  if (seed === null || seed === undefined) return null;
  return (
    <div className="seed-details">
      <button className="vd-details-toggle" type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}><ChevronDown size={13} aria-hidden="true" />详情</button>
      {open ? <dl className="vd-details" id={id}><div><dt>seed</dt><dd><code>{seed}</code><small className="seed-tag">{SEED_TOOLTIP}</small></dd></div></dl> : null}
    </div>
  );
}

function PlayButton({ id, url, label }) {
  const audio = useSingleAudio();
  const playing = audio.id === id && audio.playing;
  return <button className={`button ghost-button play-button ${playing ? 'is-playing' : ''}`} type="button" disabled={!url} aria-label={`${playing ? '停止' : '播放'}${label}`} aria-pressed={playing} onClick={() => singleAudio.toggle(id, url)}>{playing ? <Pause size={14} /> : <Play size={14} />}{playing ? '停止' : '播放'}</button>;
}

// Breeze 断开时的横幅：已生成的试听还能听，新的生成要等连上。
export function BreezeBanner({ status, checking, onRefresh, onOpenSettings }) {
  if (status.state !== 'disconnected') return null;
  return (
    <div className="breeze-banner" role="status">
      <WifiOff size={15} aria-hidden="true" />
      <span><strong>Breeze 服务没有连接</strong><small>{status.detail || '已经生成的试听还能播放；新的生成要等连上之后。'}</small></span>
      <button className="button secondary-button" type="button" disabled={checking} onClick={onRefresh}>{checking ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}重新检测</button>
      {onOpenSettings ? <button className="button ghost-button" type="button" onClick={onOpenSettings}>去设置</button> : null}
    </div>
  );
}

function TakeCard({ take, draft, referenceText, picked, nameOf, onPick, onRetry, canGenerate }) {
  const queue = takeQueueText(take, draft, { referenceText });
  const label = versionName(take.slot);
  if (take.status === 'error') {
    return (
      <div className="take-card is-error">
        <div className="take-head"><strong>{label}</strong></div>
        <p className="take-failed-title">这一版没生成出来</p>
        <p className="take-failed-reason" role="alert">原因：{take.error || '未知错误'}</p>
        <button className="button secondary-button" type="button" disabled={!canGenerate} onClick={() => onRetry(take.slot)}><RotateCcw size={13} />重新生成这一版</button>
      </div>
    );
  }
  if (take.status === 'cancelled') return <div className="take-card is-cancelled"><div className="take-head"><strong>{label}</strong></div><p>已取消</p></div>;
  if (take.status !== 'ready') {
    return (
      <div className={`take-card is-${take.status}`} aria-busy="true">
        <div className="take-head"><strong>{label}</strong>{take.status === 'running' ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : null}</div>
        <p className="take-queue-title">{queue?.title}</p>
        <small>{queue?.detail}</small>
        {take.status === 'running' ? <div className="take-progress" role="progressbar" aria-label={`${label}生成进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((take.progress || 0) * 100)}><span style={{ width: `${Math.round((take.progress || 0) * 100)}%` }} /></div> : null}
      </div>
    );
  }
  return (
    <div className={`take-card is-ready ${picked ? 'is-picked' : ''}`}>
      <div className="take-head">
        <label className="take-pick"><input type="radio" name={`take-${draft.jobId}`} checked={picked} onChange={() => onPick(take.takeId)} /><strong>{label}</strong></label>
      </div>
      <div className="take-meta">
        <PlayButton id={`take:${take.takeId}`} url={take.audioUrl} label={label} />
        {Number.isFinite(take.durationSec) ? <span>{take.durationSec.toFixed(1)} 秒</span> : null}
        {Number.isFinite(take.f0Hz) ? <span title="平均基频">音高约 {Math.round(take.f0Hz)} Hz</span> : null}
      </div>
      {take.nearestRoleId ? <p className="take-near"><AlertTriangle size={12} aria-hidden="true" />和{nameOf(take.nearestRoleId)}比较接近，建议从质感上拉开</p> : null}
      <SeedDetails seed={take.seed} id={`seed-${take.takeId}`} />
    </div>
  );
}

function DescribeTab({ character, draft, actions, canGenerate, generating, testLines, nameOf, onLockTake, focusToken }) {
  // 自动设计没成功时保留 AI 写的描述；用户一改，「由 AI 根据原文写的描述」的说明就去掉。
  const aiDescription = character.voiceDraft?.aiDescription || '';
  const edited = Boolean(draft.description) || draft.edited;
  const description = draft.description || (draft.edited ? '' : aiDescription);
  const fromAi = Boolean(aiDescription) && !edited;
  const textRef = useRef(null);
  useEffect(() => { if (focusToken) window.requestAnimationFrame(() => textRef.current?.focus()); }, [focusToken]);
  const covered = dimensionsCovered(description);
  const referenceText = draft.referenceText || '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const insert = (dim) => {
    const base = description.trim();
    const next = base ? `${base.replace(/[，,。.]?$/, '，')}${dim.example}` : dim.example;
    actions.setDescription(character.id, next);
    window.requestAnimationFrame(() => { const el = textRef.current; if (!el) return; el.focus(); el.setSelectionRange(next.length - dim.example.length, next.length); });
  };
  const generate = async () => {
    setBusy(true); setError('');
    try { await actions.generate(character.id, { description: description.trim(), testLines }); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  const retry = async (slot) => {
    setError('');
    try { await actions.retry(character.id, slot, { description: description.trim(), testLines, referenceText }); }
    catch (failure) { setError(failure.message); }
  };
  const takes = draft.takes || [];
  const remaining = draftRemainingSeconds(draft, { referenceText });
  const picked = takes.find((take) => take.takeId && take.takeId === draft.pickedTakeId && take.status === 'ready');
  const empty = !description.trim();
  return (
    <div className="vd-describe">
      <section className="vd-step">
        <h4><span className="vd-step-no">1</span>写声音描述</h4>
        <p className="vd-step-sub">描述这个角色“平时说话”的声音。情绪不用写在这里，之后每句台词会单独加情绪指令。</p>
        <label className="setting-field"><span>{character.name}的声音描述</span>
          <textarea ref={textRef} rows={3} maxLength={200} value={description} readOnly={generating} aria-describedby="vd-desc-hint" placeholder="例如：中年男声，四十岁上下，声音低沉略带沙哑，语速偏慢" onChange={(event) => actions.setDescription(character.id, event.target.value, { edited: true })} />
          {fromAi ? <small className="vd-ai-note">由 AI 根据原文写的描述，可以改</small> : null}
          <small id="vd-desc-hint">{empty ? '先写一段声音描述才能生成' : '建议 30–80 字'} · {[...description].length} / 200 字</small>
        </label>
        <div className="vd-dims" role="group" aria-label="可以写到的维度"><span>可以写到：</span>{DIMENSIONS.map((dim) => <button key={dim.id} type="button" className={`vd-dim ${covered.includes(dim.id) ? 'is-covered' : ''}`} disabled={generating} title={`插入示例：${dim.example}`} onClick={() => insert(dim)}>{covered.includes(dim.id) ? <Check size={11} aria-hidden="true" /> : null}{dim.label}{covered.includes(dim.id) ? <span className="sr-only">（已写到）</span> : null}</button>)}</div>
        <div className="vd-hint"><strong>写质感，别只写音高</strong><p>“沙哑、鼻音、气声、浑厚、清亮”比“低一点、高一点”更能把角色分开。参考音频会用平静、中性、正常语速生成，系统会自动加上这句要求，不用自己写。</p></div>
        <details className="vd-sent"><summary>查看实际发送给 Breeze 的内容</summary><dl><div><dt>声音描述</dt><dd>{designPrompt(description) || `（还没写）${NEUTRAL_SUFFIX}`}</dd></div><div><dt>参考文本</dt><dd>{referenceText || '由服务端选定，生成后显示'}</dd></div><div><dt>每版</dt><dd>{TAKE_COUNT} 版各自独立生成，声音会不一样。锁定时保存的是你选中的那段音频本身。</dd></div></dl></details>
        <div className="vd-generate">
          <button className="button primary-button" type="button" disabled={empty || generating || busy || !canGenerate} onClick={generate}>{busy ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}{takes.length ? `换一批，再生成 ${TAKE_COUNT} 版` : `生成 ${TAKE_COUNT} 版试听`}</button>
          <small>{TAKE_COUNT} 版依次生成，{BREEZE_TIME_NOTE}；Breeze 一次只做一件事，会插在批量台词前面，只等当前这句。</small>
        </div>
        {error ? <p className="vd-error" role="alert">{error}</p> : null}
      </section>
      <section className="vd-step">
        <div className="vd-step-head">
          <h4><span className="vd-step-no">2</span>试听、对比，选一版</h4>
          {generating ? <span className="vd-remaining" aria-live="polite">全部完成还需约 {formatSeconds(remaining)}</span> : null}
          {generating || draft.jobStatus === 'cancelling' ? <button className="button secondary-button" type="button" disabled={draft.jobStatus === 'cancelling'} onClick={() => actions.cancel(character.id)}><X size={13} />{cancelButtonText(draft)}</button> : null}
        </div>
        {!takes.length ? <p className="vd-empty">还没有试听</p> : null}
        {draft.jobStatus === 'cancelled' ? <p className="vd-empty" role="status">已取消，可以改描述后重新生成</p> : null}
        {takes.length ? <div className="take-grid" role="radiogroup" aria-label="选择一版作为参考音色">{takes.map((take) => <TakeCard key={`${take.slot}-${take.takeId || 'pending'}`} take={take} draft={draft} referenceText={referenceText} picked={take.takeId === draft.pickedTakeId} nameOf={nameOf} canGenerate={canGenerate && !empty} onPick={(takeId) => actions.pick(character.id, takeId)} onRetry={retry} />)}</div> : null}
        {takes.some((take) => take.status === 'ready') ? <div className="vd-lock-row"><button className="button primary-button" type="button" disabled={!picked} onClick={() => onLockTake(picked)}><LockKeyhole size={14} />{picked ? `锁定${versionName(picked.slot)}` : '先选一版'}</button><small>锁定后，这个角色的每句台词都从这段参考音频克隆。</small></div> : null}
      </section>
    </div>
  );
}

function UploadTab({ character, onLockUpload }) {
  const [file, setFile] = useState(null);
  const [durationSec, setDurationSec] = useState(null);
  const [decodeError, setDecodeError] = useState('');
  const [transcript, setTranscript] = useState('');
  const [consent, setConsent] = useState(false);
  const [touched, setTouched] = useState(false);
  const [previewUrl, setPreviewUrl] = useState('');
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);
  const choose = (picked) => {
    setFile(picked); setDurationSec(null); setDecodeError(''); setTouched(false);
    if (!picked) return;
    const url = URL.createObjectURL(picked); setPreviewUrl(url);
    const probe = new Audio(); probe.preload = 'metadata';
    probe.onloadedmetadata = () => setDurationSec(Number.isFinite(probe.duration) ? probe.duration : null);
    probe.onerror = () => setDecodeError('decode');
    probe.src = url;
  };
  const checks = uploadChecks({ durationSec, transcript, consent, decodeError });
  const visibleErrors = checks.errors.filter((item) => touched || item.field === 'file' && file);
  const fieldError = (field) => visibleErrors.find((item) => item.field === field);
  const fieldWarning = (field) => checks.warnings.find((item) => item.field === field);
  return (
    <div className="vd-upload">
      <p className="vd-step-sub">上传一段 5–30 秒（建议 10 到 30 秒）、只有一个人说话的录音，并写下录音里说的原话。之后{character.name}的每句台词都从这段录音克隆。</p>
      <label className="setting-field"><span>录音文件（wav / mp3 / m4a）</span><input type="file" accept="audio/*,.wav,.mp3,.m4a" aria-invalid={Boolean(fieldError('file'))} onChange={(event) => choose(event.target.files?.[0] || null)} />{file ? <small>{file.name}{Number.isFinite(durationSec) ? ` · ${durationSec.toFixed(1)} 秒` : ''}</small> : null}{fieldError('file') ? <small className="field-error" role="alert">{fieldError('file').text}</small> : fieldWarning('file') ? <small className="field-warning" role="note">{fieldWarning('file').text}</small> : null}</label>
      {previewUrl && !decodeError ? <PlayButton id={`upload:${character.id}`} url={previewUrl} label="上传的录音" /> : null}
      <label className="setting-field"><span>录音里说的原话</span><textarea rows={3} value={transcript} aria-invalid={Boolean(fieldError('transcript'))} aria-describedby={`vd-transcript-note-${character.id}`} placeholder="手动输入录音里的每句话，一字不差，包括语气词" onChange={(event) => setTranscript(event.target.value)} />
        <small id={`vd-transcript-note-${character.id}`}>必填，请手动输入。 · {[...transcript.replace(/\s+/g, '')].length} 字</small>
        {fieldError('transcript') ? <small className="field-error" role="alert">{fieldError('transcript').text}</small> : fieldWarning('transcript') ? <small className="field-warning">{fieldWarning('transcript').text}</small> : null}
      </label>
      <label className="vd-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} /><span>{CONSENT_TEXT}</span></label>
      {fieldError('consent') ? <small className="field-error" role="alert">{fieldError('consent').text}</small> : null}
      <button className="button primary-button" type="button" onClick={() => { setTouched(true); if (checks.canLock) onLockUpload({ file, transcript: transcript.trim(), durationSec }); }}><Upload size={14} />上传并锁定</button>
    </div>
  );
}

function LockedCard({ character, lines, onReplace, onUnlock }) {
  const [open, setOpen] = useState(false);
  const voice = character.voice;
  const stale = staleLineCount(lines, character);
  const cardRef = useRef(null);
  useEffect(() => {
    // 锁定弹窗关掉后焦点会落回 body；锁定成功后把焦点交给这张卡片。
    if (voice?.lockedAt && Date.now() - Date.parse(voice.lockedAt) < 5000) cardRef.current?.focus();
  }, [voice?.referenceId, voice?.lockedAt]);
  return (
    <section className="vd-locked" aria-label="当前参考音色" tabIndex={-1} ref={cardRef}>
      <div className="vd-locked-head"><LockKeyhole size={15} aria-hidden="true" /><strong>当前参考音色 · 第 {voice.version || 1} 版</strong></div>
      {stale ? <p className="stale-note" role="status"><AlertTriangle size={13} aria-hidden="true" />{stale} 句需重渲：这些台词是用旧的参考音色生成的，去「制作中心 · 审听修句」逐句重渲。</p> : null}
      <dl className="vd-facts">
        <div><dt>来源</dt><dd>{voice.source === 'uploaded' ? '上传录音' : '描述生成'}</dd></div>
        {Number.isFinite(voice.durationSec) ? <div><dt>时长</dt><dd>{voice.durationSec.toFixed(1)} 秒</dd></div> : null}
        {Number.isFinite(voice.f0Hz) ? <div><dt>音高</dt><dd>约 {Math.round(voice.f0Hz)} Hz</dd></div> : null}
        <div><dt>锁定时间</dt><dd>{formatTime(voice.lockedAt)}</dd></div>
      </dl>
      {voice.description ? <div className="vd-field"><span className="field-label">描述</span><p>{voice.description}</p></div> : null}
      {voice.refTranscript ? <div className="vd-field"><span className="field-label">{voice.source === 'uploaded' ? '原话' : '参考文本'}</span><p>{voice.refTranscript}</p></div> : null}
      <PlayButton id={`ref:${character.id}:${voice.referenceId}`} url={voice.refAudioUrl} label="参考音频" />
      <button className="vd-details-toggle" type="button" aria-expanded={open} aria-controls={`vd-details-${character.id}`} onClick={() => setOpen((value) => !value)}><ChevronDown size={13} aria-hidden="true" />详情</button>
      {open ? <dl className="vd-details" id={`vd-details-${character.id}`}><div><dt>参考音频 referenceId</dt><dd><code>{voice.referenceId}</code></dd></div><div><dt>音频指纹</dt><dd><code>{voice.audioHash}</code></dd></div>{voice.seed !== null && voice.seed !== undefined ? <div><dt>seed</dt><dd><code>{voice.seed}</code><small className="seed-tag">{SEED_TOOLTIP}</small></dd></div> : null}</dl> : null}
      <div className="vd-locked-actions"><button className="button secondary-button" type="button" onClick={onReplace}><Sparkles size={13} />更换参考音色</button>{onUnlock ? <button className="button ghost-button" type="button" onClick={onUnlock}>解除锁定</button> : null}</div>
    </section>
  );
}

// Breeze 声音设计（handoff v3）：描述生成 / 上传录音 → 试听 → 锁定（先看影响）→ 可撤销。
export function VoiceDesignPanel({ character, characters, lines, draft, actions, breeze, projectId, onApplyVoice, onToast, onOpenSettings, focusToken = 0 }) {
  const [tab, setTab] = useState('describe');
  const [replacing, setReplacing] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [undo, setUndo] = useState(null);
  const nameOf = (id) => characters.find((item) => item.id === id)?.name || id;
  const connected = breeze.status.state !== 'disconnected';
  const generating = isGenerating(draft);
  const locked = Boolean(character.voice?.referenceId);
  // 每一版只试一句（openapi 的 take 按 candidateIndex × lineIndex 生成；多句会成倍占用 Breeze）。
  const testLines = lines.slice(0, 1).map((line) => line.text.slice(0, 200));
  useEffect(() => { setReplacing(false); setTab('describe'); setUndo(null); }, [character.id]);
  useEffect(() => { if (focusToken) { setTab('describe'); setReplacing(false); } }, [focusToken]);
  useEffect(() => { singleAudio.stop(); }, [tab]);
  useEffect(() => { if (!undo) return undefined; const timer = window.setTimeout(() => setUndo(null), 10000); return () => window.clearTimeout(timer); }, [undo]);

  const history = character.voiceHistory || [];
  const applyLock = (voice, warnings = []) => {
    const previous = character.voice?.referenceId ? character.voice : null;
    onApplyVoice(character.id, voice, previous ? [previous, ...history.filter((item) => item.referenceId !== previous.referenceId && item.referenceId !== voice.referenceId)] : history.filter((item) => item.referenceId !== voice.referenceId));
    setReplacing(false);
    setUndo({ text: `已锁定${character.name}的第 ${voice.version} 版参考音色`, hints: referenceWarningTexts(warnings), previous, history, canUndo: previous ? chainApi.capabilities.referenceHistory : chainApi.capabilities.unlockReference });
    actions.clear(character.id);
  };
  const doUndo = async () => {
    const { previous, history: before } = undo; setUndo(null);
    try {
      if (previous) await chainApi.relockReference(character.id, { projectId, referenceId: previous.referenceId });
      else await chainApi.unlockReference(character.id, { projectId });
      onApplyVoice(character.id, previous, before);
      onToast(previous ? `已换回第 ${previous.version || 1} 版` : '已撤销锁定');
    } catch (failure) { onToast(`撤销失败：${failure.message}`); }
  };
  const lockTake = (take) => setDialog({ mode: 'lock', versionLabel: `试听${versionName(take.slot)}`, run: async () => {
    const result = await chainApi.lockDesignedReference(character.id, { projectId, takeId: take.takeId });
    applyLock(lockedVoice({ result, take, draft, previous: character.voice }), result.warnings);
  } });
  const lockUpload = ({ file, transcript, durationSec }) => setDialog({ mode: 'lock', versionLabel: '这段录音', run: async () => {
    const result = await chainApi.uploadReference(character.id, { projectId, file, transcript, description: draft?.description || '' });
    applyLock(lockedVoice({ result: { durationSec, ...result, audioUrl: result.audioUrl || '' }, previous: character.voice, transcript, source: 'uploaded' }), result.warnings);
  } });
  const unlock = () => setDialog({ mode: 'unlock', run: async () => {
    await chainApi.unlockReference(character.id, { projectId });
    const previous = character.voice;
    onApplyVoice(character.id, null, [previous, ...history.filter((item) => item.referenceId !== previous.referenceId)]);
    setUndo({ text: `已解除${character.name}的参考音色`, previous, history });
  } });
  const restore = async (version) => {
    try {
      const result = await chainApi.relockReference(character.id, { projectId, referenceId: version.referenceId });
      applyLock({ ...version, audioHash: result.audioHash || version.audioHash, lockedAt: new Date().toISOString() });
    } catch (failure) { onToast(failure.message); }
  };

  return (
    <div className="voice-design-panel">
      <BreezeBanner status={breeze.status} checking={breeze.checking} onRefresh={breeze.refresh} onOpenSettings={onOpenSettings} />
      {breeze.status.state === 'connected' ? <p className="breeze-online"><Wifi size={12} aria-hidden="true" />本地 Breeze · {breeze.status.label}</p> : null}
      {undo ? <div className="vd-undo" role="status"><span>{undo.text}</span>{undo.hints?.map((hint) => <small key={hint} className="vd-soft-hint">{hint}</small>)}{undo.canUndo ? <button className="button ghost-button" type="button" onClick={doUndo}><RotateCcw size={13} />撤销</button> : null}</div> : null}
      {!locked && character.voiceAutoError ? <div className="vd-auto-error" role="status"><strong>未设计</strong><span>自动设计没成功 · 原因：{String(character.voiceAutoError).replace(/^自动设计没成功[:：]\s*/, '')}</span></div> : null}
      {locked && !replacing ? <LockedCard character={character} lines={lines} onReplace={() => setReplacing(true)} onUnlock={chainApi.capabilities.unlockReference ? unlock : null} /> : (
        <>
          {locked ? <div className="vd-replacing"><span>正在更换参考音色，锁定新的一版之前，台词继续用第 {character.voice.version || 1} 版。</span><button className="button ghost-button" type="button" onClick={() => setReplacing(false)}>不换了</button></div> : null}
          <div className="vd-tabs" role="tablist" aria-label="参考音色来源">
            {[['describe', '用描述生成'], ['upload', '上传录音']].map(([id, label]) => <button key={id} type="button" role="tab" id={`vd-tab-${id}`} aria-selected={tab === id} aria-controls={`vd-panel-${id}`} tabIndex={tab === id ? 0 : -1} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)} onKeyDown={(event) => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { const next = tab === 'describe' ? 'upload' : 'describe'; setTab(next); document.getElementById(`vd-tab-${next}`)?.focus(); } }}>{label}</button>)}
          </div>
          <div role="tabpanel" id={`vd-panel-${tab}`} aria-labelledby={`vd-tab-${tab}`}>
            {tab === 'describe'
              ? <DescribeTab character={character} draft={draft} actions={actions} canGenerate={connected} generating={generating} testLines={testLines} nameOf={nameOf} onLockTake={lockTake} focusToken={focusToken} />
              : <UploadTab character={character} onLockUpload={lockUpload} />}
          </div>
        </>
      )}
      {history.length ? (
        <section className="vd-history" aria-label="以前的版本">
          <div className="section-caption">以前的版本</div>
          <ul>{history.map((version) => <li key={version.referenceId}><span>第 {version.version || 1} 版 · {version.source === 'uploaded' ? '上传录音' : '描述生成'} · {formatTime(version.lockedAt)}</span><PlayButton id={`hist:${version.referenceId}`} url={version.refAudioUrl} label={`第 ${version.version || 1} 版`} />{chainApi.capabilities.referenceHistory ? <button className="button ghost-button" type="button" onClick={() => restore(version)}>换回这一版</button> : null}</li>)}</ul>
        </section>
      ) : null}
      <p className="license-note">{BREEZE_LICENSE_FULL}</p>
      {dialog ? <LockDialog mode={dialog.mode} roleId={character.id} roleName={character.name} projectId={projectId} lines={lines} versionLabel={dialog.versionLabel} onConfirm={dialog.run} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

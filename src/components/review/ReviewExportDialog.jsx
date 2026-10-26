import { Download, LoaderCircle, RotateCcw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { exportNotes, exportPrecheck, exportSummary, pendingRenderText, staleExportText } from '../../lib/review.js';
import { ModalShell } from '../ModalShell';

// 导出整集（handoff 第 2 节「导出」）。phase: check | running | done | failed。
// 导出进行中可以关掉窗口，导出会继续，完成后由外面弹 toast「整集已导出」+「查看」。
// precheck = GET /export-precheck 的结果（打开窗口时取）：{ loading, staleLineCount, missingAudioLineCount, staleLineIds, error }。
export function ReviewExportDialog({ episodeLabel, phase, mixStale, markedCount, driftCount, precheck, sfxUnbound, breeze, progress, message, result, error, onStart, onFixStale, onReview, onClose }) {
  const check = exportPrecheck({ mixStale, markedCount, driftCount, staleLineCount: precheck?.staleLineCount || 0 });
  const checking = phase === 'check' && precheck?.loading;
  const notes = exportNotes({ sfxUnbound, breeze });
  const summary = exportSummary(result);
  // 点「开始」后那个按钮会消失，焦点得有个去处：完成/失败时给主按钮（下载 / 重试），进行中给「关闭」。
  const footerRef = useRef(null);
  const firstPhase = useRef(phase);
  useEffect(() => {
    if (phase === firstPhase.current) return;
    firstPhase.current = null;
    const buttons = footerRef.current?.querySelectorAll('a, button');
    buttons?.[buttons.length - 1]?.focus();
  }, [phase]);
  return (
    <ModalShell title="导出整集" onClose={onClose} className="review-export">
      <div className="export-body">
        <p className="muted">{episodeLabel} · 只导出 mp3（这一版不含字幕）</p>
        {checking ? <p className="muted" aria-live="polite"><LoaderCircle size={13} className="spin" aria-hidden="true" />正在检查有没有改过没重配的句子</p> : null}
        {phase === 'check' && !checking ? <>
          {check.stale ? <div className="export-box is-warning" role="note"><strong>{check.stale.title}</strong><p>直接导出会用这些句子原来的音频。</p></div> : null}
          {precheck?.missingAudioLineCount > 0 ? <div className="export-box" role="note"><strong>还有 {precheck.missingAudioLineCount} 句没有音频</strong><p>导出时会跳过这些句子。</p></div> : null}
          {pendingRenderText(precheck?.pendingLineCount, precheck?.pendingCharCount) ? <p className="muted export-pending">{pendingRenderText(precheck.pendingLineCount, precheck.pendingCharCount)}</p> : null}
          {precheck?.error ? <p className="muted">没能检查过期句子（{precheck.error}），仍可以导出。</p> : null}
          {check.remixFirst ? <div className="export-box"><strong>有句子换了新版，整集需要先重新混音</strong><p>只拼接和统一响度，不重新生成；混完会自动导出。</p></div> : null}
          {check.warning ? <div className="export-box is-warning" role="note"><strong>{check.warning.title}</strong><p>{check.warning.detail}<button type="button" className="button ghost-button" onClick={onReview}>{check.warning.action}</button></p></div> : null}
        </> : null}
        {phase === 'running' ? <div className="export-box" aria-live="polite">
          <strong><LoaderCircle size={13} className="spin" aria-hidden="true" />{message || '正在导出'}</strong>
          <div className="review-progress" role="progressbar" aria-label="导出进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((progress || 0) * 100)}><span style={{ width: `${Math.round((progress || 0) * 100)}%` }} /></div>
          <p className="muted">可以关掉这个窗口，导出会继续，完成后会提示。</p>
        </div> : null}
        {phase === 'failed' ? <div className="export-box is-error" role="alert"><strong>导出失败</strong><p>原因：{error || '未知错误'}</p><p className="muted">整集混音不受影响，可以直接重试。</p></div> : null}
        {phase === 'done' && summary?.staleLineCount ? <div className="export-box is-warning" role="note"><strong>{staleExportText(summary.staleLineCount)}</strong><p>这些句子按原来的音频导出了；重配之后可以再导出一次。</p></div> : null}
        {phase === 'done' && summary ? <dl className="export-result">
          <dt>文件</dt><dd>{summary.name}</dd>
          <dt>时长</dt><dd>{summary.duration}</dd>
          <dt>响度</dt><dd>{summary.loudness}</dd>
          {summary.counts ? <><dt>内容</dt><dd>{summary.counts}</dd></> : null}
        </dl> : null}
        {notes.map((note) => <p key={note} className="export-fixed-note">{note}</p>)}
      </div>
      <footer className="dialog-actions" ref={footerRef}>
        <button type="button" className="button ghost-button" onClick={onClose}>关闭</button>
        {phase === 'check' && !checking && check.stale && onFixStale ? <button type="button" className="button secondary-button" onClick={onFixStale}>{check.stale.fix}</button> : null}
        {phase === 'check' && !checking ? <button type="button" className="button primary-button" onClick={() => onStart(check.remixFirst)}>{check.primary}</button> : null}
        {phase === 'failed' ? <button type="button" className="button primary-button" onClick={() => onStart(mixStale)}><RotateCcw size={13} />重试</button> : null}
        {phase === 'done' && result?.url ? <a className="button primary-button" href={`${result.url}${result.url.includes('?') ? '&' : '?'}download=${encodeURIComponent(result.name || 'episode.mp3')}`} download={result.name}><Download size={13} />下载 mp3</a> : null}
      </footer>
    </ModalShell>
  );
}

import { AlertCircle, Copy, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { EXPORT_DETAIL_LABEL, MISSING_FILES_ACTION, missingLineLabel } from '../lib/export-failure.js';

// 导出失败（fe-0010）：一句人话 + 「重试」 + 可展开的「详情」（服务端原文，等宽，可复制）。
// onRetry 不传就不显示重试（例如导出窗口的重试按钮在底栏）；onClose 不传就不显示关闭。
// missing（0049 AUDIO_FILE_MISSING）：重试没用，不给重试；列出丢了文件的句子（onLocate 点句子定位），
// 给「重新生成这几句」（onRegenerate）。
export function ExportFailure({ text, detail, missing = false, lines = [], onRetry, onRegenerate, onLocate, onClose, retryDisabled = false, className = '', role = 'alert' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(detail); setCopied(true); window.setTimeout(() => setCopied(false), 1600); }
    catch { setCopied(false); }
  };
  return (
    <div className={`export-failure ${className}`} role={role}>
      <div className="export-failure-head">
        <AlertCircle size={15} aria-hidden="true" />
        <strong>{text}</strong>
        {missing && onRegenerate && lines.length ? <button type="button" className="button secondary-button export-failure-retry" disabled={retryDisabled} onClick={() => onRegenerate(lines.map((item) => item.lineId))}><RotateCcw size={13} />{MISSING_FILES_ACTION}</button> : null}
        {onRetry && !missing ? <button type="button" className="button secondary-button export-failure-retry" disabled={retryDisabled} onClick={onRetry}><RotateCcw size={13} />重试</button> : null}
        {onClose ? <button type="button" className="icon-button export-failure-close" aria-label="关闭" onClick={onClose}><X size={14} /></button> : null}
      </div>
      {missing && lines.length ? <MissingLineList lines={lines} onLocate={onLocate} /> : null}
      {detail ? (
        <details className="export-failure-detail">
          <summary>{EXPORT_DETAIL_LABEL}</summary>
          <pre>{detail}</pre>
          <button type="button" className="link-button" onClick={copy}><Copy size={12} aria-hidden="true" />{copied ? '已复制' : '复制'}</button>
        </details>
      ) : null}
    </div>
  );
}

// 丢了音频文件的句子：角色 + 开头几个字；能定位就是按钮。
export function MissingLineList({ lines, onLocate, limit = 5 }) {
  return (
    <ul className="missing-file-lines">
      {lines.slice(0, limit).map((item) => <li key={item.lineId}>{onLocate ? <button type="button" className="link-button" onClick={() => onLocate(item)}>{missingLineLabel(item)}</button> : missingLineLabel(item)}</li>)}
      {lines.length > limit ? <li className="muted">……另外 {lines.length - limit} 句</li> : null}
    </ul>
  );
}

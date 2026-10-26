import { AlertCircle, Copy, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { EXPORT_DETAIL_LABEL } from '../lib/export-failure.js';

// 导出失败（fe-0010）：一句人话 + 「重试」 + 可展开的「详情」（服务端原文，等宽，可复制）。
// onRetry 不传就不显示重试（例如导出窗口的重试按钮在底栏）；onClose 不传就不显示关闭。
export function ExportFailure({ text, detail, onRetry, onClose, retryDisabled = false, className = '', role = 'alert' }) {
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
        {onRetry ? <button type="button" className="button secondary-button export-failure-retry" disabled={retryDisabled} onClick={onRetry}><RotateCcw size={13} />重试</button> : null}
        {onClose ? <button type="button" className="icon-button export-failure-close" aria-label="关闭" onClick={onClose}><X size={14} /></button> : null}
      </div>
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

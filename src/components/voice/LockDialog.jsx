import { AlertTriangle, LoaderCircle, LockKeyhole, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { chainApi } from '../../lib/chain-api.js';
import { impactSummary } from '../../lib/voice-design.js';
import { ModalShell } from '../ModalShell';

// 锁定 / 解除锁定前的影响预览：打开即请求 impact；没加载完确认按钮不可点；失败可重试。
export function LockDialog({ mode = 'lock', roleId, roleName, projectId, lines, versionLabel, onConfirm, onClose }) {
  const [impact, setImpact] = useState({ state: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setImpact({ state: 'loading' });
    try { setImpact({ state: 'ready', ...impactSummary(await chainApi.voiceImpact(roleId, { projectId }), lines) }); }
    catch (failure) { setImpact({ state: 'error', message: failure.message }); }
  }, [roleId, projectId, lines]);
  useEffect(() => { load(); }, [load]);
  const confirm = async () => {
    setBusy(true); setError('');
    try { await onConfirm(); onClose(); }
    catch (failure) { setError(failure.message); setBusy(false); }
  };
  const unlocking = mode === 'unlock';
  return (
    <ModalShell title={unlocking ? `解除${roleName}的参考音色` : `锁定${roleName}的${versionLabel || '这一版'}`} onClose={onClose} className="lock-dialog">
      <div className="lock-impact" aria-live="polite">
        {impact.state === 'loading' ? <p className="lock-impact-loading"><LoaderCircle size={14} className="spin" aria-hidden="true" />正在统计受影响的台词…</p> : null}
        {impact.state === 'error' ? <div className="lock-impact-error"><p role="alert"><AlertTriangle size={14} aria-hidden="true" />没能统计受影响的台词：{impact.message}</p><button className="button secondary-button" type="button" onClick={load}><RefreshCw size={13} />重试</button></div> : null}
        {impact.state === 'ready' ? (
          <>
            <p>{impact.staleCount ? <>已生成的 <strong>{impact.staleCount} 句</strong>会标记为「需重渲」，不会自动重新生成，也不会扣费。</> : '这个角色还没有生成过台词，不会有需重渲的句子。'}</p>
            {impact.unrenderedCount ? <p>还没生成的 {impact.unrenderedCount} 句{unlocking ? '要等重新锁定一版参考音色后才能生成' : '会直接用新的参考音色'}。</p> : null}
            {impact.staleLines.length ? <ul className="lock-impact-lines">{impact.staleLines.slice(0, 5).map((line) => <li key={line.id}>{line.text}</li>)}{impact.staleLines.length > 5 ? <li>……另外 {impact.staleLines.length - 5} 句</li> : null}</ul> : null}
          </>
        ) : null}
      </div>
      {error ? <p className="dialog-error" role="alert">{error}</p> : null}
      <div className="dialog-actions">
        <button className="button secondary-button" type="button" onClick={onClose}>取消</button>
        <button className="button primary-button" type="button" disabled={impact.state !== 'ready' || busy} onClick={confirm}>{busy ? <LoaderCircle size={14} className="spin" /> : <LockKeyhole size={14} />}{unlocking ? '解除锁定' : '确认锁定'}</button>
      </div>
    </ModalShell>
  );
}

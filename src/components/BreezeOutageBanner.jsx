import { outageActionLabel } from '../lib/breeze-outage.js';

// Breeze 连不上 / 中途断开：整个任务一条横幅。没有「换豆包」——换引擎是用户自己在设置里的选择。
export function BreezeOutageBanner({ outage, checking, onRetry, onResume, onSettings, onDismiss }) {
  const handlers = { retry: onRetry, resume: onResume, settings: onSettings };
  return (
    <div className="breeze-outage" role="alert">
      <p>{outage.text}{outage.detail ? <small className="breeze-outage-detail">{outage.detail}</small> : null}</p>
      <div className="breeze-outage-actions">
        {outage.actions.map((action, index) => (
          <button key={action} type="button" className={`button ${index === 0 ? 'primary-button' : 'secondary-button'}`} aria-disabled={checking && action !== 'settings' ? 'true' : undefined} onClick={() => { if (!(checking && action !== 'settings')) handlers[action]?.(); }}>{checking && action !== 'settings' ? '正在连接…' : outageActionLabel[action]}</button>
        ))}
        <button type="button" className="button ghost-button breeze-outage-close" aria-label="关闭提示" onClick={onDismiss}>×</button>
      </div>
    </div>
  );
}

import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

// Promise-based replacement for window.prompt / window.confirm: Esc and
// backdrop click cancel (null / false), Enter submits. request is
// { type: 'prompt' | 'confirm', message, detail?, note?, footer?, defaultValue?, confirmLabel? }.
// note 是紧跟 detail 的小字（如“上限 Y 字”），footer 是另起一段的说明。
export function Dialog({ request, onDone }) {
  const [value, setValue] = useState(request.type === 'prompt' ? request.defaultValue || '' : '');
  const inputRef = useRef(null);
  const confirmRef = useRef(null);
  const cancelValue = request.type === 'prompt' ? null : false;
  useEffect(() => { if (inputRef.current) { inputRef.current.focus(); inputRef.current.select(); } else confirmRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (event) => { if (event.key === 'Escape') onDone(cancelValue); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone, cancelValue]);
  const submit = () => onDone(request.type === 'prompt' ? value.trim() : true);
  return (
    <div className="modal-overlay" role="presentation" onMouseDown={() => onDone(cancelValue)}>
      <div className="modal-card app-dialog" role="dialog" aria-modal="true" aria-label={request.message} onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header"><h3>{request.message}</h3><button className="modal-close" type="button" aria-label="取消" onClick={() => onDone(cancelValue)}><X size={15} /></button></header>
        {request.type === 'prompt'
          ? <input className="dialog-input" ref={inputRef} value={value} aria-label={request.message} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }} />
          : null}
        {request.detail ? <p className="dialog-detail">{request.detail}</p> : null}
        {request.note ? <p className="dialog-note">{request.note}</p> : null}
        {request.footer ? <p className="dialog-detail">{request.footer}</p> : null}
        <div className="dialog-actions">
          <button className="button secondary-button" type="button" onClick={() => onDone(cancelValue)}>取消</button>
          <button ref={confirmRef} className="button primary-button" type="button" onClick={submit}>{request.confirmLabel || '确定'}</button>
        </div>
      </div>
    </div>
  );
}

import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { singleAudio } from '../lib/single-audio.js';

// 通用对话框外壳：打开时停止播放、焦点进框；Esc / 点背景关闭；Tab 在框内循环；关闭后焦点回到原处。
export function ModalShell({ title, onClose, children, className = '', labelledBy }) {
  const cardRef = useRef(null);
  useEffect(() => {
    singleAudio.stop();
    const previous = document.activeElement;
    const focusables = () => [...(cardRef.current?.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])];
    const first = focusables().find((element) => !element.classList.contains('modal-close')) || focusables()[0];
    first?.focus();
    const onKey = (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
      if (event.key === 'Tab') {
        const items = focusables(); if (!items.length) return;
        const [head, tail] = [items[0], items[items.length - 1]];
        if (event.shiftKey && document.activeElement === head) { event.preventDefault(); tail.focus(); }
        else if (!event.shiftKey && document.activeElement === tail) { event.preventDefault(); head.focus(); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); if (previous instanceof HTMLElement && document.contains(previous)) previous.focus(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="modal-overlay" role="presentation" onMouseDown={onClose}>
      <div ref={cardRef} className={`modal-card app-dialog ${className}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : title} onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header"><h3 id={labelledBy}>{title}</h3><button className="modal-close" type="button" aria-label="关闭" onClick={onClose}><X size={15} /></button></header>
        {children}
      </div>
    </div>
  );
}

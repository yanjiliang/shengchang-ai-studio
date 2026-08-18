import { CheckCircle2 } from 'lucide-react';

export function Toast({ message }) {
  return (
    <div className={`toast ${message ? 'is-visible' : ''}`} role="status" aria-live="polite">
      <CheckCircle2 size={16} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

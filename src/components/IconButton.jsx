export function IconButton({ icon: Icon, label, active = false, badge, onClick, className = '' }) {
  return (
    <button
      className={`icon-button ${active ? 'is-active' : ''} ${className}`}
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
      {badge ? <span className="icon-badge">{badge}</span> : null}
    </button>
  );
}

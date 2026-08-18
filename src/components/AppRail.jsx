import { AudioLines, BookOpenText, Library, Settings, ShieldCheck, SlidersHorizontal, Users } from 'lucide-react';
import { IconButton } from './IconButton';

const navItems = [
  { id: 'studio', label: '场景导演', icon: BookOpenText },
  { id: 'voices', label: '角色音色', icon: Users },
  { id: 'sounds', label: '声音素材', icon: Library },
  { id: 'production', label: '制作中心', icon: SlidersHorizontal },
  { id: 'quality', label: '质量审听', icon: ShieldCheck },
];

export function AppRail({ view, onViewChange }) {
  return (
    <nav className="app-rail" aria-label="产品功能">
      <button className="brand-mark" type="button" aria-label="声场首页" onClick={() => onViewChange('studio')}>
        <AudioLines size={18} strokeWidth={2.3} aria-hidden="true" />
      </button>
      <div className="rail-actions">
        {navItems.map((item) => (
          <IconButton
            key={item.id}
            icon={item.icon}
            label={item.label}
            active={view === item.id}
            badge={item.badge}
            onClick={() => onViewChange(item.id)}
          />
        ))}
      </div>
      <div className="rail-spacer" />
      <IconButton icon={Settings} label="设置" onClick={() => onViewChange('settings')} />
      <div className="profile-dot" aria-label="个人工作区">L</div>
    </nav>
  );
}

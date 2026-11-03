import { useState } from 'react';
import { X } from 'lucide-react';

const formatCount = (value) => Number(value || 0).toLocaleString();

// 章节数据来自服务端的书籍导入记录（GET /api/book-imports/:id）：
// 已导入的章节不可再选；继续导入时只能追加，避免把前面的章节替换掉。
export function ChapterPicker({ chapters, fileName, hasScenes, onConfirm, onCancel }) {
  const selectable = chapters.filter((chapter) => !chapter.importedAt).map((chapter) => chapter.index);
  const failed = chapters.filter((chapter) => !chapter.importedAt && chapter.lastError).map((chapter) => chapter.index);
  const importedCount = chapters.filter((chapter) => chapter.importedAt).length;
  const hasImported = importedCount > 0;
  // 上次失败的章节优先选中：继续导入时不会顺手把没导入过的整本书再跑一遍。
  const [selected, setSelected] = useState(() => new Set(failed.length ? failed : selectable));
  const [mode, setMode] = useState(hasImported || hasScenes ? 'append' : 'replace');
  const chosen = chapters.filter((chapter) => selected.has(chapter.index));
  const totalChars = chosen.reduce((sum, chapter) => sum + chapter.charCount, 0);
  const allSelected = selectable.length > 0 && selected.size === selectable.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectable));
  const toggle = (index) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(index)) next.delete(index); else next.add(index);
    return next;
  });

  return (
    <div className="modal-overlay" role="presentation" onMouseDown={onCancel}>
      <section className="modal-card chapter-picker" role="dialog" aria-modal="true" aria-label="选择要导入的章节" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h3>{hasImported ? '继续导入' : '选择要导入的章节'}</h3>
            <span className="chapter-picker-file">{fileName}</span>
          </div>
          <button className="modal-close" type="button" aria-label="取消" onClick={onCancel}><X size={15} /></button>
        </header>
        <p className="chapter-picker-summary">
          共 {chapters.length} 章{hasImported ? ` · 已导入 ${importedCount} 章` : ''} · 已选 {chosen.length} 章 · {formatCount(totalChars)} 字
        </p>
        <div className="chapter-picker-actions">
          <button className="button secondary-button" type="button" disabled={!selectable.length} onClick={toggleAll}>{allSelected ? '全不选' : '全选未导入'}</button>
          {hasImported ? (
            <span className="chapter-mode-note">继续导入会追加到现有场景</span>
          ) : hasScenes ? (
            <label className="chapter-mode">
              导入方式
              <select value={mode} onChange={(event) => setMode(event.target.value)}>
                <option value="append">追加到现有场景</option>
                <option value="replace">替换现有场景</option>
              </select>
            </label>
          ) : null}
        </div>
        <div className="chapter-list">
          {chapters.map((chapter) => {
            const imported = Boolean(chapter.importedAt);
            return (
              <label
                key={chapter.index}
                className={`chapter-item${selected.has(chapter.index) ? ' is-selected' : ''}${imported ? ' is-imported' : ''}`}
                title={chapter.lastError || chapter.title}
              >
                <input type="checkbox" disabled={imported} checked={selected.has(chapter.index)} onChange={() => toggle(chapter.index)} />
                <span className="chapter-item-title">{chapter.title || `第 ${chapter.index + 1} 章`}</span>
                <span className="chapter-item-count">
                  {imported ? '已导入' : chapter.lastError ? '上次失败' : `${formatCount(chapter.charCount)} 字`}
                </span>
              </label>
            );
          })}
        </div>
        <footer className="chapter-picker-footer">
          <span>{selectable.length ? '每章单独拆解，已完成的章节会保留。' : '这本书的章节已经全部导入。'}</span>
          <div className="dialog-actions">
            <button className="button secondary-button" type="button" onClick={onCancel}>取消</button>
            <button className="button primary-button" type="button" disabled={!chosen.length} onClick={() => onConfirm({ indexes: chosen.map((chapter) => chapter.index), mode })}>
              {hasImported ? '继续导入' : '导入'} {chosen.length} 章
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

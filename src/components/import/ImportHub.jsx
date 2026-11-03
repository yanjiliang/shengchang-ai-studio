import { X } from 'lucide-react';

const dateText = (value) => {
  const date = new Date(Number(value) || Date.now());
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
};

// 已保存但还没导入完的书。选“继续”不会重新解析文件，直接打开服务端的章节记录。
export function ImportHub({ books, onCancel, onContinue, onDelete, onNewFile }) {
  return (
    <div className="modal-overlay" role="presentation" onMouseDown={onCancel}>
      <section className="modal-card import-hub" role="dialog" aria-modal="true" aria-label="继续导入" onMouseDown={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <div>
            <h3>已保存的导入记录</h3>
            <span className="chapter-picker-file">章节和导入进度都保存在本地</span>
          </div>
          <button className="modal-close" type="button" aria-label="取消" onClick={onCancel}><X size={15} /></button>
        </header>
        <div className="import-hub-list">
          {books.length ? books.map((book) => (
            <div className="import-hub-row" key={book.id}>
              <div className="import-hub-copy">
                <strong title={book.filename}>{book.filename || '未命名书籍'}</strong>
                <small>{book.importedCount}/{book.chapterCount} 章 · {book.remainingCount > 0 ? `还剩 ${book.remainingCount} 章` : '已完成'} · {dateText(book.updatedAt)}</small>
              </div>
              {book.remainingCount > 0
                ? <button className="button primary-button" type="button" onClick={() => onContinue(book.id)}>继续</button>
                : <span className="import-hub-done">已完成</span>}
              <button className="button secondary-button" type="button" title="只删除导入记录，不删除已生成的场景" onClick={() => onDelete(book.id)}>删除记录</button>
            </div>
          )) : <p className="dialog-detail">没有保存的导入记录。</p>}
        </div>
        <footer className="chapter-picker-footer">
          <span>选择新文件会开始另一本书的导入。</span>
          <div className="dialog-actions">
            <button className="button secondary-button" type="button" onClick={onCancel}>取消</button>
            <button className="button primary-button" type="button" onClick={onNewFile}>选择新文件</button>
          </div>
        </footer>
      </section>
    </div>
  );
}

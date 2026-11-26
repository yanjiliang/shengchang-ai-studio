// 小说导入支持的格式与展示名。单独成模块：工作台首屏只需要这两个常量，
// 真正的解析（含 fflate 解 ZIP）在 import-file.js，导入时才按需加载。
export const NOVEL_FILE_ACCEPT = [
  '.txt', '.md', '.markdown', '.html', '.htm', '.epub', '.docx',
  'text/plain', 'text/markdown', 'text/html',
  'application/epub+zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
].join(',');

const FORMAT_LABEL = { text: 'TXT', epub: 'EPUB', docx: 'DOCX', markdown: 'Markdown', html: 'HTML' };
export const formatLabel = (format) => FORMAT_LABEL[format] || '文本';

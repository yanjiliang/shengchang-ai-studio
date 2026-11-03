// 书籍导入记录：把整本书的章节文本和已导入进度存在服务端。
// 前端只上传一次章节数据；之后可以用 bookId 继续导入/查看进度，不需要重新选文件。
import { createHash } from 'node:crypto';
import { createBookImport, deleteBookImport, getBookChapter, getBookImport, getPersistentTask, getProject, listBookImports, listPersistentTasks } from './database.js';
import { enqueueNovelAnalysis } from './task-manager.js';

const MAX_CHAPTERS = 5_000;
const MAX_CHAPTER_CHARS = 2_000_000;
const ACTIVE = new Set(['queued', 'running']);

function badRequest(response, message, code = 'BOOK_IMPORT_INVALID') {
  return response.status(400).json({ error: message, code });
}

function projectFor(request, response) {
  const project = getProject(request.params.projectId);
  if (!project) { response.status(404).json({ error: '项目不存在', code: 'PROJECT_NOT_FOUND' }); return null; }
  return project;
}

function activeBookTask(projectId, bookId) {
  return listPersistentTasks(projectId, 100)
    .map((summary) => getPersistentTask(summary.id))
    .find((task) => task && task.kind === 'analyze-novel' && task.payload?.bookId === bookId && ACTIVE.has(task.status)) || null;
}

export function registerBookImportRoutes(app) {
  // 创建（或复用）一本书的章节记录。source_hash 由章节文本计算，同一本书重复上传不会产生第二份。
  app.post('/api/projects/:projectId/book-imports', (request, response, next) => {
    try {
      const project = projectFor(request, response);
      if (!project) return;
      const body = request.body || {};
      if (!Array.isArray(body.chapters) || !body.chapters.length) return badRequest(response, '没有可保存的章节');
      if (body.chapters.length > MAX_CHAPTERS) return badRequest(response, `章节数超过 ${MAX_CHAPTERS} 上限`);
      const chapters = [];
      for (const [index, chapter] of body.chapters.entries()) {
        const text = String(chapter?.text ?? '');
        if (!text.trim()) return badRequest(response, `第 ${index + 1} 章没有正文`);
        if (text.length > MAX_CHAPTER_CHARS) return badRequest(response, `第 ${index + 1} 章超过 200 万字符，请拆成更小的章节`);
        chapters.push({ title: String(chapter?.title || '').slice(0, 200), text });
      }
      const sourceHash = createHash('sha256').update(chapters.map((chapter) => chapter.text).join('\n\n')).digest('hex');
      const book = createBookImport({ projectId: project.id, sourceHash, filename: body.filename || '', format: body.format || '', chapters });
      response.status(201).json({ book });
    } catch (error) { next(error); }
  });

  app.get('/api/projects/:projectId/book-imports', (request, response, next) => {
    try {
      const project = projectFor(request, response);
      if (!project) return;
      response.json({ books: listBookImports(project.id) });
    } catch (error) { next(error); }
  });

  app.get('/api/book-imports/:bookId', (request, response, next) => {
    try {
      const book = getBookImport(request.params.bookId);
      if (!book) return response.status(404).json({ error: '书籍导入记录不存在', code: 'BOOK_IMPORT_NOT_FOUND' });
      response.json({ book });
    } catch (error) { next(error); }
  });

  app.delete('/api/book-imports/:bookId', (request, response, next) => {
    try {
      if (!deleteBookImport(request.params.bookId)) return response.status(404).json({ error: '书籍导入记录不存在', code: 'BOOK_IMPORT_NOT_FOUND' });
      response.json({ ok: true });
    } catch (error) { next(error); }
  });

  // 逐章导入：服务端从 book_chapters 读正文，前端不需要再次上传。
  // 同一章正在排队/生成时拒绝重复提交；已有章节导入过的书只能追加，不能替换。
  app.post('/api/book-imports/:bookId/chapters/:index/import', (request, response, next) => {
    try {
      const book = getBookImport(request.params.bookId);
      if (!book) return response.status(404).json({ error: '书籍导入记录不存在', code: 'BOOK_IMPORT_NOT_FOUND' });
      const chapterIndex = Number(request.params.index);
      const chapter = Number.isInteger(chapterIndex) ? getBookChapter(book.id, chapterIndex) : null;
      if (!chapter) return response.status(404).json({ error: '章节不存在', code: 'BOOK_CHAPTER_NOT_FOUND' });
      if (chapter.importedAt) return response.status(409).json({ error: '这一章已经导入过了', code: 'BOOK_CHAPTER_ALREADY_IMPORTED' });
      const project = getProject(book.projectId);
      if (!project) return response.status(404).json({ error: '项目不存在', code: 'PROJECT_NOT_FOUND' });
      const oneClick = listPersistentTasks(project.id, 100).some((task) => task.kind === 'one-click' && ACTIVE.has(task.status));
      if (oneClick) return response.status(409).json({ error: '一键成片运行中，完成后可继续导入', code: 'ONE_CLICK_RUNNING' });
      if (activeBookTask(project.id, book.id)) return response.status(409).json({ error: '这本书正在导入，请等当前章节完成', code: 'BOOK_IMPORT_RUNNING' });
      const body = request.body || {};
      // 已经导入过章节的书继续导入时只能追加，避免把前面的章节替换掉。
      const appendScenes = book.importedCount > 0 ? true : body.appendScenes === true;
      if (book.importedCount > 0 && body.mode === 'replace') return response.status(409).json({ error: '继续导入只能追加到现有场景', code: 'BOOK_IMPORT_APPEND_ONLY' });
      const task = enqueueNovelAnalysis({
        projectId: project.id,
        text: chapter.text,
        filename: book.filename,
        name: project.name,
        appendScenes,
        chapterTitle: chapter.title,
        bookId: book.id,
        chapterIndex,
      });
      response.status(202).json({ taskId: task.id, task, bookId: book.id, chapterIndex, appendScenes });
    } catch (error) { next(error); }
  });
}

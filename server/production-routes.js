// 生产链路接口（Breeze 端到端）：任务取消 / 查询、单句试听（带 seed）、音色就绪。
// 错误统一 { error, code[, ...details] }，见 docs/openapi.yaml。
import { readConfig } from './config-store.js';
import { getProject, listPersistentTasks } from './database.js';
import { resolveProjectTimeline } from './media-store.js';
import { sendError } from './breeze-routes.js';
import { acceptLineTake, listLineTakes } from './line-takes.js';
import { applyResultsToProject, cancelTask, enqueueLineTake, getTask, taskWithQueuePosition, waitForTaskToSettle } from './task-manager.js';
import { annotateStaleness, voiceReadiness } from './voice-references.js';

const httpError = (status, code, message, details) => Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });

// 已完成 / 失败的任务不能取消（409）；已取消的再取消返回 200（幂等）。
export async function cancelJob(jobId) {
  const before = getTask(jobId);
  if (!before) throw httpError(404, 'JOB_NOT_FOUND', '任务不存在');
  if (before.status === 'completed' || before.status === 'failed') throw httpError(409, 'JOB_NOT_CANCELLABLE', `任务已${before.status === 'completed' ? '完成' : '失败'}，不能取消`, { status: before.status });
  const cancelled = cancelTask(jobId);
  const settled = await waitForTaskToSettle(jobId);
  return { jobId, status: settled?.status || cancelled.status, removed: cancelled.lane.removed, discardedInFlight: cancelled.lane.discardedInFlight, task: taskWithQueuePosition(settled) };
}

const lineAnnotated = async (payload) => {
  const config = await readConfig();
  const project = annotateStaleness(config, getProject(payload.projectId));
  const line = project?.state.scenes.flatMap((scene) => scene.lines || []).find((item) => item.id === payload.lineId);
  return { ...payload, line: line || null };
};

export function latestEpisodeExport(projectId) {
  const task = listPersistentTasks(projectId, 100).find((item) => (item.kind === 'export-project' || item.kind === 'one-click') && item.status === 'completed' && item.result?.url);
  if (!task) return null;
  const { url, name, durationMs, lufs = null, lufsReason = null, targetLufs = null } = task.result;
  return { taskId: task.id, kind: task.kind, completedAt: task.completedAt, url, name, durationMs, lufs, lufsReason: lufs === null ? (lufsReason || 'NOT_MEASURED') : null, targetLufs };
}

export async function projectTimeline(project) {
  const timeline = await resolveProjectTimeline(project);
  const lastExport = latestEpisodeExport(project.id);
  return { ...timeline, lufs: lastExport?.lufs ?? null, lufsReason: lastExport ? lastExport.lufsReason : 'NOT_EXPORTED', lastExport };
}

export function registerProductionRoutes(app) {
  app.get('/api/jobs/:jobId', (request, response, next) => {
    try {
      const task = getTask(request.params.jobId);
      if (!task) throw httpError(404, 'JOB_NOT_FOUND', '任务不存在');
      response.json(taskWithQueuePosition(task));
    } catch (error) { sendError(response, error, next); }
  });

  app.delete('/api/jobs/:jobId', async (request, response, next) => {
    try { response.json(await cancelJob(request.params.jobId)); } catch (error) { sendError(response, error, next); }
  });

  // 单句试听：body { projectId?, seed? }。seed 省略 = 服务端随机，响应里立即给出。
  app.post('/api/lines/:lineId/takes', async (request, response, next) => {
    try {
      const body = request.body || {};
      const config = await readConfig();
      const { task, deduplicated } = enqueueLineTake(config, { lineId: request.params.lineId, projectId: body.projectId, seed: body.seed });
      response.status(deduplicated ? 200 : 202).json({ jobId: task.id, lineId: task.payload.lineId, projectId: task.projectId, seed: task.payload.seed, seedSource: task.payload.seedSource, status: task.status, deduplicated, queuePosition: taskWithQueuePosition(task).queuePosition, task: taskWithQueuePosition(task) });
    } catch (error) { sendError(response, error, next); }
  });

  app.get('/api/lines/:lineId/takes', async (request, response, next) => {
    try { response.json(await lineAnnotated(listLineTakes(request.params.lineId, request.query.projectId))); } catch (error) { sendError(response, error, next); }
  });

  app.post('/api/lines/:lineId/takes/:takeId/accept', async (request, response, next) => {
    try {
      const result = await acceptLineTake(request.params.lineId, request.params.takeId, { projectId: request.body?.projectId, applyResults: applyResultsToProject });
      response.json(await lineAnnotated(result));
    } catch (error) { sendError(response, error, next); }
  });

  // 整集时间轴：每句在成片里的起止（ms），和最近一次整集导出（含一键成片）
  // 测得的响度。lufs 是那次导出的成片的，之后改过的台词不会反映进去。
  app.get('/api/projects/:projectId/timeline', async (request, response, next) => {
    try {
      const project = getProject(request.params.projectId);
      if (!project) throw httpError(404, 'PROJECT_NOT_FOUND', '项目不存在');
      response.json({ projectId: project.id, ...(await projectTimeline(project)) });
    } catch (error) { sendError(response, error, next); }
  });

  app.get('/api/projects/:projectId/voice-readiness', async (request, response, next) => {
    try {
      const project = getProject(request.params.projectId);
      if (!project) throw httpError(404, 'PROJECT_NOT_FOUND', '项目不存在');
      response.json(voiceReadiness(await readConfig(), project.state));
    } catch (error) { sendError(response, error, next); }
  });
}

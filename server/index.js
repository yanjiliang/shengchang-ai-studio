import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildGenerationRequests } from '../shared/generation-requests.mjs';
import { publicConfig, readConfig, writeConfig } from './config-store.js';
import { archiveProject, createProject, getProject, listPersistentTasks, listProjects, updateProject } from './database.js';
import { designVoice, validateProviderConfig } from './model-adapters.js';
import { ensureRuntime, exportSceneTimeline, inspectProjectMedia, probeFfmpeg, renderScenePreview, runtimePaths, saveUploadedAsset } from './media-store.js';
import { cancelTask, enqueueGeneration, enqueueNovelAnalysis, enqueueOneClick, enqueueProjectExport, estimateGeneration, getTask, retryTask } from './task-manager.js';
import { testLlm, validateLlmConfig } from './story-analyzer.js';

const PORT = Number(process.env.SHENGCHANG_API_PORT || 4174);
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(serverDir, '..');
const app = express();

await ensureRuntime();
// The novel import caps at 2M characters; CJK costs 3 bytes per character in
// UTF-8, so the body limit has to clear 6MB for that check to be the one that
// rejects oversized input instead of the parser.
app.use(express.json({ limit: '24mb' }));
app.use('/media/exports', express.static(runtimePaths.EXPORT_DIR, { fallthrough: false }));
app.use('/media', express.static(runtimePaths.MEDIA_DIR, { fallthrough: false }));

app.get('/api/health', async (_request, response) => {
  const config = await readConfig();
  response.json({ ok: true, provider: config.provider, configured: config.provider === 'demo' || Boolean(config.accessKey), ffmpeg: await probeFfmpeg() });
});
app.get('/api/config', async (_request, response) => response.json(publicConfig(await readConfig())));
// Redacted secret headers round-trip as __SAVED_SECRET__. Merge per key so
// editing a non-secret header no longer discards the edit (the old behavior
// restored the entire saved JSON whenever any secret was present).
function mergeRedactedHeaders(incoming, saved) {
  try {
    const merged = JSON.parse(incoming);
    const previous = JSON.parse(saved || '{}');
    for (const key of Object.keys(merged)) if (merged[key] === '__SAVED_SECRET__') merged[key] = previous[key] ?? '';
    return JSON.stringify(merged);
  } catch { return incoming; }
}

app.put('/api/config', async (request, response, next) => {
  try {
    const current = await readConfig();
    const nextConfig = { ...current, ...request.body };
    if (!request.body.accessKey && current.accessKey && request.body.preserveSecret !== false) nextConfig.accessKey = current.accessKey;
    if (!request.body.llmApiKey && current.llmApiKey && request.body.preserveSecret !== false) nextConfig.llmApiKey = current.llmApiKey;
    if (request.body.customHeaders?.includes('__SAVED_SECRET__')) nextConfig.customHeaders = mergeRedactedHeaders(request.body.customHeaders, current.customHeaders);
    response.json(publicConfig(await writeConfig(nextConfig)));
  } catch (error) { next(error); }
});
app.post('/api/config/test-llm', async (request, response, next) => {
  try {
    const current = await readConfig();
    const config = { ...current, ...request.body };
    if (!request.body.llmApiKey && current.llmApiKey) config.llmApiKey = current.llmApiKey;
    validateLlmConfig(config);
    response.json(await testLlm(config));
  } catch (error) { next(error); }
});
app.get('/api/projects', (_request, response) => response.json({ projects: listProjects() }));
app.post('/api/projects', (request, response, next) => {
  try { response.status(201).json(createProject({ name: request.body.name, genre: request.body.genre })); } catch (error) { next(error); }
});
app.get('/api/projects/:projectId', (request, response) => {
  const project = getProject(request.params.projectId);
  return project ? response.json(project) : response.status(404).json({ error: '项目不存在' });
});
app.put('/api/projects/:projectId', (request, response, next) => {
  try {
    // OV-4 stale-autosave guard: the browser holds a whole-project snapshot,
    // so an autosave landing mid-orchestration would silently revert the
    // voiceMap/scenes the one-click task just wrote. Read-only until it ends.
    const active = listPersistentTasks(request.params.projectId, 100).some((task) => task.kind === 'one-click' && ['queued', 'running'].includes(task.status));
    if (active) return response.status(409).json({ error: '一键成片运行中，完成后可继续编辑' });
    // Whitelist: trustedAudio is a server-internal flag and must never be
    // settable by the browser, or the stale-snapshot guard is bypassable.
    response.json(updateProject(request.params.projectId, { name: request.body.name, genre: request.body.genre, sourceFilename: request.body.sourceFilename, sourceText: request.body.sourceText, state: request.body.state }));
  } catch (error) { next(error); }
});
app.delete('/api/projects/:projectId', (request, response, next) => {
  try { archiveProject(request.params.projectId); response.json({ ok: true }); } catch (error) { next(error); }
});
app.post('/api/projects/:projectId/analyze', (request, response, next) => {
  try {
    if (!request.body.text?.trim()) throw new Error('小说文本为空');
    if (request.body.text.length > 2_000_000) throw new Error('单次导入上限为 200 万字符，请按卷拆分');
    const project = getProject(request.params.projectId);
    if (!project) throw new Error('项目不存在');
    response.status(202).json(enqueueNovelAnalysis({ projectId: project.id, text: request.body.text, filename: request.body.filename || 'novel.txt', name: request.body.name || project.name }));
  } catch (error) { next(error); }
});
app.get('/api/projects/:projectId/tasks', (request, response, next) => {
  try {
    if (!getProject(request.params.projectId)) throw new Error('项目不存在');
    response.json({ tasks: listPersistentTasks(request.params.projectId, request.query.limit) });
  } catch (error) { next(error); }
});
app.get('/api/projects/:projectId/media-report', async (request, response, next) => {
  try {
    const project = getProject(request.params.projectId);
    if (!project) throw new Error('项目不存在');
    response.json(await inspectProjectMedia(project));
  } catch (error) { next(error); }
});
app.post('/api/projects/:projectId/export-scene', async (request, response, next) => {
  try {
    const project = getProject(request.params.projectId);
    if (!project) throw new Error('项目不存在');
    const scene = project.state.scenes?.find((item) => item.id === request.body.sceneId);
    if (!scene) throw new Error('场景不存在');
    const media = await inspectProjectMedia(project);
    const report = media.scenes.find((item) => item.sceneId === scene.id);
    if (report?.invalidFileCount) throw new Error(`场景含 ${report.invalidFileCount} 个无法解码的音频文件，请重新生成或重新绑定后再导出`);
    const config = await readConfig();
    response.json(await exportSceneTimeline({ projectId: project.id, scene, targetLufs: config.targetLufs }));
  } catch (error) { next(error); }
});
app.post('/api/projects/:projectId/preview-scene', async (request, response, next) => {
  try {
    const project = getProject(request.params.projectId);
    if (!project) throw new Error('项目不存在');
    const scene = project.state.scenes?.find((item) => item.id === request.body.sceneId);
    if (!scene) throw new Error('场景不存在');
    const media = await inspectProjectMedia(project);
    const report = media.scenes.find((item) => item.sceneId === scene.id);
    if (report?.invalidFileCount) throw new Error(`场景含 ${report.invalidFileCount} 个无法解码的音频文件，无法预混试听`);
    response.json(await renderScenePreview({ projectId: project.id, scene }));
  } catch (error) { next(error); }
});
app.post('/api/projects/:projectId/export-episode', (request, response, next) => {
  try {
    if (!getProject(request.params.projectId)) throw new Error('项目不存在');
    response.status(202).json(enqueueProjectExport({ projectId: request.params.projectId }));
  } catch (error) { next(error); }
});
// One-click pre-flight + enqueue (design B3 endpoint guards): 409 on a live
// run, 400 when there is nothing to make an episode from, provider validation
// before any money can burn. The LLM check is deliberately absent: since the
// offline 拆解 fallback shipped, a keyless project runs the whole pipeline
// heuristically instead of dying at stage 1.
app.post('/api/projects/:projectId/one-click', async (request, response, next) => {
  try {
    const project = getProject(request.params.projectId);
    if (!project) throw new Error('项目不存在');
    const active = listPersistentTasks(project.id, 100).some((task) => task.kind === 'one-click' && ['queued', 'running'].includes(task.status));
    if (active) return response.status(409).json({ error: '该项目的一键成片任务已在运行中' });
    if (!project.state.scenes?.length && !project.sourceText?.trim()) throw new Error('请先导入小说文本或手动创建场景');
    const config = await readConfig();
    validateProviderConfig(config);
    response.status(202).json(enqueueOneClick({ projectId: project.id }));
  } catch (error) { next(error); }
});
// Cost guardrail (design B4 + §8 server estimate follow-up): the browser has
// the scene math, but only the server can predict cache hits.
app.post('/api/projects/:projectId/one-click-estimate', async (request, response, next) => {
  try {
    const project = getProject(request.params.projectId);
    if (!project) throw new Error('项目不存在');
    const config = await readConfig();
    const dialogue = (project.state.scenes || []).flatMap((scene) => (scene.lines || []).filter((line) => line.type === 'dialogue'));
    // Count every line the run would generate: the pipeline's 音色 stage
    // auto-maps unmapped characters first, so requests without a voiceId
    // today are still billable lines (except genuinely unmappable ones, which
    // the pipeline skips - hence the separate unmappedVoiceCount).
    const requests = buildGenerationRequests(project.state);
    const mappable = requests.filter((item) => item.voiceId);
    response.json({
      provider: config.provider,
      sceneCount: project.state.scenes?.length || 0,
      dialogueCount: dialogue.length,
      requestCount: requests.length,
      unmappedVoiceCount: requests.length - mappable.length,
      characters: requests.reduce((sum, item) => sum + String(item.text || '').length, 0),
      cacheHits: await estimateGeneration(config, mappable, { projectId: project.id }),
      needsLlm: !project.state.scenes?.length && !['demo'].includes(config.provider),
    });
  } catch (error) { next(error); }
});
app.post('/api/generate', async (request, response, next) => {
  try {
    const config = await readConfig();
    validateProviderConfig(config);
    if (!Array.isArray(request.body.requests) || request.body.requests.length === 0) throw new Error('生成任务没有台词');
    const project = request.body.projectId && getProject(request.body.projectId);
    if (!project) throw new Error('生成任务缺少有效项目');
    const scenesById = new Map((project.state.scenes || []).map((scene) => [scene.id, scene]));
    const requests = request.body.requests.map((item) => {
      const sceneId = item.sceneId || request.body.sceneId;
      const scene = scenesById.get(sceneId);
      const line = scene?.lines?.find((candidate) => candidate.id === item.lineId);
      if (!scene || !line || line.type !== 'dialogue') throw new Error('生成任务中存在无效的对白位置');
      if (!String(item.text || '').trim()) throw new Error('生成任务中存在空白台词');
      return { ...item, sceneId };
    });
    response.status(202).json(enqueueGeneration({ ...request.body, requests }));
  } catch (error) { next(error); }
});
app.post('/api/voices/design', async (request, response, next) => {
  try {
    const config = await readConfig();
    const result = await designVoice(config, request.body);
    if (result.preview) {
      const saved = await saveUploadedAsset(randomUUID(), 'wav', result.preview.buffer);
      result.previewUrl = saved.url;
      delete result.preview;
    }
    response.json(result);
  } catch (error) { next(error); }
});
app.post('/api/assets/upload', express.raw({ type: 'audio/*', limit: '100mb' }), async (request, response, next) => {
  try {
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) throw new Error('没有收到音频文件');
    const originalName = decodeURIComponent(request.header('X-File-Name') || 'audio.wav');
    const extension = path.extname(originalName).slice(1) || 'wav';
    const id = randomUUID();
    const saved = await saveUploadedAsset(id, extension, request.body);
    response.json({ id: `asset-${id}`, name: originalName.replace(/\.[^.]+$/, ''), url: saved.url, mime: request.header('content-type'), size: request.body.length });
  } catch (error) { next(error); }
});
app.get('/api/tasks/:taskId', (request, response) => {
  const task = getTask(request.params.taskId);
  return task ? response.json(task) : response.status(404).json({ error: '任务不存在或本地服务已重启' });
});
app.post('/api/tasks/:taskId/cancel', (request, response, next) => {
  try { response.json(cancelTask(request.params.taskId)); } catch (error) { next(error); }
});
app.post('/api/tasks/:taskId/retry', (request, response, next) => {
  try { response.status(202).json(retryTask(request.params.taskId)); } catch (error) { next(error); }
});
// Unknown API routes must not fall through to the SPA fallback: apiRequest
// would parse the HTML shell as `{}` and treat the call as a success.
app.use('/api', (_request, response) => response.status(404).json({ error: '接口不存在' }));
app.use(express.static(path.join(rootDir, 'dist')));
app.get('/{*splat}', (_request, response) => response.sendFile(path.join(rootDir, 'dist', 'index.html')));
app.use((error, _request, response, _next) => {
  const status = error.type === 'entity.too.large' ? 413
    : Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 400;
  // Expected client errors (bad JSON, missing files) are noise; only log stacks
  // for genuine server faults.
  if (status >= 500) console.error(error);
  else console.warn(`请求失败（${status}）：${error.message}`);
  if (status === 413) return response.status(413).json({ error: '请求体过大，请按卷拆分后再导入' });
  response.status(status).json({ error: error.message || '本地服务处理失败' });
});
app.listen(PORT, '127.0.0.1', () => console.log(`声场本地服务：http://127.0.0.1:${PORT}`));

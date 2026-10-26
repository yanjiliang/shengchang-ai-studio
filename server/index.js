import express from 'express';
import path from 'node:path';
import { unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { buildGenerationRequests } from '../shared/generation-requests.mjs';
import { publicConfig, readConfig, writeConfig } from './config-store.js';
import { archiveProject, createProject, getProject, listPersistentTasks, listProjects, updateProject } from './database.js';
import { designVoice, validateProviderConfig, validateSoundConfig } from './model-adapters.js';
import { ensureRuntime, exportSceneTimeline, extractPeaks, inspectProjectMedia, probeDuration, probeFfmpeg, renderScenePreview, runtimePaths, saveUploadedAsset } from './media-store.js';
import { taskWithQueuePosition, cancelTask, enqueueGeneration, enqueueNovelAnalysis, enqueueOneClick, enqueueProjectExport, enqueueSoundGeneration, estimateBillableCharacters, estimateGeneration, getTask, retryTask } from './task-manager.js';
import { seedSampleProject } from './sample-project.js';
import { ensureBuiltinAssets, listBuiltinAssets } from './builtin-assets.js';
import { recommendForEvent } from './asset-recommend.js';
import { redactLlmSecret, resolveLlmApiKey, resolveSavedSecret, testLlm, validateLlmConfig } from './story-analyzer.js';
import { sameEndpoint, sameLlmEndpoint } from '../shared/endpoint.mjs';
import { registerBreezeRoutes, sendError } from './breeze-routes.js';
import { oneClickMissingVoiceRoles, voiceNotReadyError } from './one-click.js';
import { annotateStaleness, generationVoiceMap, staleLineCount } from './voice-references.js';
import { registerProductionRoutes } from './production-routes.js';

const PORT = Number(process.env.SHENGCHANG_API_PORT || 4174);
// Default binds loopback only. Docker sets SHENGCHANG_BIND_HOST=0.0.0.0 because
// published ports (-p) forward to the container interface, never its loopback;
// the Host/Origin guard below remains the actual security boundary there.
const BIND_HOST = process.env.SHENGCHANG_BIND_HOST || '127.0.0.1';
const serverDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(serverDir, '..');
const app = express();

await ensureRuntime();
// Register the built-in CC0 library into MEDIA_DIR (shared, read-only): the
// picker, recommendations, and mixes all treat builtin clips like any audio.
try {
  const builtin = await ensureBuiltinAssets();
  console.log(`内置声音素材库就绪：${builtin.size} 条（CC0）`);
} catch (error) {
  console.warn(`内置素材库登记失败（功能降级，不影响其他能力）：${error.message}`);
}
// Fresh install (zero project rows): seed the 三打白骨精 sample so the first
// contact is 一键成片 on a real, direction-rich project — no key, no setup.
const seeded = seedSampleProject();
if (seeded.created) console.log(`已创建示例项目「西游记 · 三打白骨精」：一键成片可在离线演示引擎下完整跑通`);
// The novel import caps at 2M characters; CJK costs 3 bytes per character in
// UTF-8, so the body limit has to clear 6MB for that check to be the one that
// rejects oversized input instead of the parser.
app.use(express.json({ limit: '24mb' }));
// Loopback-only guard: the server binds 127.0.0.1, but a hostile web page can
// still drive mutations at it (form POSTs need no CORS preflight, and a DNS-
// rebinding attack can fake the Host). Reject API calls whose Host or Origin
// is not loopback. Non-browser clients (curl, e2e) send no Origin and pass.
const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const hostnameOf = (header) => {
  // Host arrives bare (127.0.0.1:4174), Origin with a scheme (http://...).
  try { return new URL(header.includes('://') ? header : `http://${header}`).hostname; } catch { return ''; }
};
app.use('/api', (request, response, next) => {
  if (!LOCAL_HOSTNAMES.has(hostnameOf(request.headers.host || ''))) {
    return response.status(403).json({ error: '仅允许本机访问' });
  }
  if (request.headers.origin && !LOCAL_HOSTNAMES.has(hostnameOf(request.headers.origin))) {
    return response.status(403).json({ error: '仅允许本机页面调用接口' });
  }
  next();
});
app.use('/media/exports', express.static(runtimePaths.EXPORT_DIR, { fallthrough: false }));
app.use('/media', express.static(runtimePaths.MEDIA_DIR, { fallthrough: false }));

app.get('/api/health', async (_request, response) => {
  const config = await readConfig();
  let configured = true;
  try { validateProviderConfig(config); } catch { configured = false; }
  response.json({ ok: true, provider: config.provider, configured, ffmpeg: await probeFfmpeg() });
});
app.get('/api/config', async (_request, response) => response.json(publicConfig(await readConfig())));
// Redacted secret headers round-trip as __SAVED_SECRET__. Merge per key so
// editing a non-secret header no longer discards the edit (the old behavior
// restored the entire saved JSON whenever any secret was present).
// keepSaved=false（接口地址换了）→ 占位符落成空串，已保存的头部密钥不带到新地址。
function mergeRedactedHeaders(incoming, saved, keepSaved = true) {
  try {
    const merged = JSON.parse(incoming);
    const previous = JSON.parse(saved || '{}');
    for (const key of Object.keys(merged)) if (merged[key] === '__SAVED_SECRET__') merged[key] = keepSaved ? previous[key] ?? '' : '';
    return JSON.stringify(merged);
  } catch { return incoming; }
}

// 已保存的密钥：没填新值时，只有对应接口地址（规范化后）没变才沿用；地址换了就清空，
// 不能把旧 Key 带到另一家服务。preserveSecret:false = 明确要求按请求体原样保存。
const SAVED_SECRETS = [
  { secretField: 'accessKey', endpointField: 'endpoint' },
  { secretField: 'llmApiKey', endpointField: 'llmEndpoint', same: sameLlmEndpoint },
  { secretField: 'sfxAccessKey', endpointField: 'sfxEndpoint' },
];
const SECRET_HEADERS = [
  { headersField: 'customHeaders', endpointField: 'endpoint' },
  { headersField: 'sfxCustomHeaders', endpointField: 'sfxEndpoint' },
];

app.put('/api/config', async (request, response, next) => {
  try {
    const current = await readConfig();
    const nextConfig = { ...current, ...request.body };
    if (request.body.preserveSecret !== false) {
      for (const rule of SAVED_SECRETS) nextConfig[rule.secretField] = resolveSavedSecret(request.body, current, rule);
    }
    for (const { headersField, endpointField } of SECRET_HEADERS) {
      if (!String(request.body[headersField] ?? '').includes('__SAVED_SECRET__')) continue;
      const endpoint = request.body[endpointField] === undefined ? current[endpointField] : request.body[endpointField];
      nextConfig[headersField] = mergeRedactedHeaders(request.body[headersField], current[headersField], sameEndpoint(endpoint, current[endpointField]));
    }
    response.json(publicConfig(await writeConfig(nextConfig)));
  } catch (error) { next(error); }
});
// 永远回 JSON {ok, latencyMs, code, message, status?}。本地校验没过 → 400 LLM_CONFIG_INVALID；
// 上游失败（401/404/超时/其他）→ 200 + ok:false，测试本身成功地报告了结果。
app.post('/api/config/test-llm', async (request, response) => {
  let config;
  try {
    const current = await readConfig();
    config = { ...current, ...request.body, llmApiKey: resolveLlmApiKey(request.body, current) };
    validateLlmConfig(config);
  } catch (error) {
    return response.status(400).json({ ok: false, latencyMs: null, code: 'LLM_CONFIG_INVALID', message: error.message, ...(error.field ? { field: error.field } : {}), error: error.message });
  }
  try { response.json(await testLlm(config)); }
  catch (error) { response.status(500).json({ ok: false, latencyMs: null, code: 'LLM_UPSTREAM', message: redactLlmSecret(error.message, config.llmApiKey).slice(0, 300), error: '测试连接失败' }); }
});
app.get('/api/projects', (_request, response) => response.json({ projects: listProjects() }));
app.post('/api/projects', (request, response, next) => {
  try { response.status(201).json(createProject({ name: request.body.name, genre: request.body.genre })); } catch (error) { next(error); }
});
// 每句台词附带 stale / staleReason（按当前参数复算缓存键，见 voice-references.js）。
app.get('/api/projects/:projectId', async (request, response) => {
  const project = getProject(request.params.projectId);
  return project ? response.json(annotateStaleness(await readConfig(), project)) : response.status(404).json({ error: '项目不存在' });
});
app.put('/api/projects/:projectId', async (request, response, next) => {
  try {
    // OV-4 stale-autosave guard: the browser holds a whole-project snapshot,
    // so an autosave landing mid-orchestration would silently revert the
    // voiceMap/scenes the one-click task just wrote. Read-only until it ends.
    const active = listPersistentTasks(request.params.projectId, 100).some((task) => task.kind === 'one-click' && ['queued', 'running'].includes(task.status));
    if (active) return response.status(409).json({ error: '一键成片运行中，完成后可继续编辑' });
    // Whitelist: trustedAudio is a server-internal flag and must never be
    // settable by the browser, or the stale-snapshot guard is bypassable.
    const saved = updateProject(request.params.projectId, { name: request.body.name, genre: request.body.genre, sourceFilename: request.body.sourceFilename, sourceText: request.body.sourceText, state: request.body.state });
    response.json(annotateStaleness(await readConfig(), saved));
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
    const exported = await exportSceneTimeline({ projectId: project.id, scene, targetLufs: config.targetLufs });
    // staleLineCount：本场里音频已过期（进入导出的是旧音频）的对白句数。
    response.json({ ...exported, staleLineCount: staleLineCount(config, project, { sceneIds: [scene.id] }) });
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
    // Breeze：有角色没锁参考音就不开跑（自动音色设计本轮不做），409 + missingVoiceRoles。
    if (config.provider === 'breeze' && project.state.scenes?.length) {
      const missingVoiceRoles = oneClickMissingVoiceRoles(config, project.state);
      if (missingVoiceRoles.length) return sendError(response, voiceNotReadyError(missingVoiceRoles), next);
    }
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
    // Breeze 只认锁定的参考音（与生成阶段 generationVoiceMap 一致）。
    const requests = buildGenerationRequests({ ...project.state, voiceMap: generationVoiceMap(config, project.state) });
    const mappable = requests.filter((item) => item.voiceId);
    const missingVoiceRoles = oneClickMissingVoiceRoles(config, project.state);
    response.json({
      // 与 GET voice-readiness 的 missingRoles 同形；Breeze 下非空时 POST one-click 会 409。
      missingVoiceRoles,
      voiceReady: missingVoiceRoles.length === 0,
      provider: config.provider,
      sceneCount: project.state.scenes?.length || 0,
      dialogueCount: dialogue.length,
      requestCount: requests.length,
      unmappedVoiceCount: requests.length - mappable.length,
      characters: requests.reduce((sum, item) => sum + String(item.text || '').length, 0),
      // 未绑定音色的句子要等 音色 阶段选角后才知道缓存键：它们的命中数是
      // “未知”，不是 0。全部未绑定（还没选角）时 cacheHits 为 null。
      cacheHits: mappable.length ? await estimateGeneration(config, mappable, { projectId: project.id }) : (requests.length ? null : 0),
      cacheHitsUnknownCount: requests.length - mappable.length,
      ...(await estimateBillableCharacters(config, requests, { projectId: project.id })),
      needsLlm: !project.state.scenes?.length && !['demo'].includes(config.provider),
    });
  } catch (error) { next(error); }
});
app.post('/api/generate', async (request, response, next) => {
  try {
    // Sound-effect / music-bed generation has its own provider config and
    // request shape (prompt, not text + direction params).
    if (request.body.kind === 'sound-generate') {
      const config = await readConfig();
      validateSoundConfig(config);
      const sound = request.body.sound || {};
      if (!String(sound.prompt || '').trim()) throw new Error('生成描述不能为空');
      const project = getProject(request.body.projectId);
      if (!project) throw new Error('生成任务缺少有效项目');
      return response.status(202).json(enqueueSoundGeneration({ projectId: project.id, sound }));
    }
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
      // Previews are auditioned once and never referenced by any project, so
      // persist nothing: files written here could never be reclaimed (not in
      // the audio cache, not deletable via the asset policy). A data URL lets
      // the browser play the clip straight from the response.
      result.previewUrl = `data:${result.preview.mime};base64,${result.preview.buffer.toString('base64')}`;
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
    // Best-effort duration probe so the library shows a real length from the
    // start; a file ffprobe cannot read still uploads (the report flags it).
    let durationMs = null;
    try { durationMs = Math.round((await probeDuration(saved.target)) * 1000); } catch { durationMs = null; }
    response.json({ id: `asset-${id}`, name: originalName.replace(/\.[^.]+$/, ''), url: saved.url, mime: request.header('content-type'), size: request.body.length, durationMs });
  } catch (error) { next(error); }
});
// Real waveform peaks for UI drawing; same path policy as asset deletion.
app.get('/api/media/peaks', async (request, response, next) => {
  try {
    const url = String(request.query.url || '');
    const filename = path.basename(url);
    if (!url.startsWith('/media/') || !filename || filename.includes('..')) throw new Error('无效的音频地址');
    response.json({ peaks: await extractPeaks(url) });
  } catch (error) { next(error); }
});
// Built-in CC0 library (shared read-only supply for the sound picker).
app.get('/api/assets/builtin', async (_request, response, next) => {
  try { response.json({ assets: await listBuiltinAssets() }); } catch (error) { next(error); }
});
// Rule-based recommendations: the sound event's text description against
// builtin entries + the project's own assets, with usage-consistency bonus.
app.get('/api/assets/recommend', async (request, response, next) => {
  try {
    const project = getProject(String(request.query.projectId || ''));
    const line = (project?.state?.scenes || [])
      .flatMap((scene) => scene.lines || [])
      .find((item) => item.id === String(request.query.lineId || ''));
    if (!line || line.type === 'dialogue') throw new Error('没有找到对应的声音事件');
    const usageCounts = {};
    for (const scene of project.state.scenes || []) for (const item of scene.lines || []) if (item.assetId) usageCounts[item.assetId] = (usageCounts[item.assetId] || 0) + 1;
    const candidates = [...await listBuiltinAssets(), ...(project.state.assets || [])];
    response.json({ recommendations: recommendForEvent({ line, candidates, usageCounts }) });
  } catch (error) { next(error); }
});
// Asset-file deletion policy (§8): a file leaves disk only once nothing
// references it. The browser unbinds its lines first, so a 409 here means
// another project (or a manual reference) still needs the file.
app.delete('/api/assets', async (request, response, next) => {
  try {
    const url = String(request.query.url || '');
    const filename = path.basename(url);
    if (!url.startsWith('/media/') || !filename || filename.includes('..')) throw new Error('无效的素材地址');
    if (filename.startsWith('builtin-')) throw new Error('内置素材属于共享资源，不可删除');
    const referenced = listProjects().some((summary) => {
      const project = getProject(summary.id);
      return (project?.state?.scenes || []).some((scene) => (scene.lines || []).some((line) => line.assetUrl === url || line.audioUrl === url));
    });
    if (referenced) return response.status(409).json({ error: '素材仍被台词引用，请先解除全部绑定' });
    await unlink(path.join(runtimePaths.MEDIA_DIR, filename)).catch(() => {});
    response.json({ ok: true });
  } catch (error) { next(error); }
});
app.get('/api/tasks/:taskId', (request, response) => {
  const task = getTask(request.params.taskId);
  return task ? response.json(taskWithQueuePosition(task)) : response.status(404).json({ error: '任务不存在或本地服务已重启' });
});
app.post('/api/tasks/:taskId/cancel', (request, response, next) => {
  try { response.json(cancelTask(request.params.taskId)); } catch (error) { next(error); }
});
app.post('/api/tasks/:taskId/retry', (request, response, next) => {
  try { response.status(202).json(retryTask(request.params.taskId)); } catch (error) { next(error); }
});
registerBreezeRoutes(app);
registerProductionRoutes(app);
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
app.listen(PORT, BIND_HOST, () => console.log(`声场本地服务：http://127.0.0.1:${PORT}（监听 ${BIND_HOST}）`));

// Breeze 相关 HTTP 路由。单独成模块，测试可以挂到一个临时 express app 上
// （index.js 在 import 时就 listen，没法直接拿来测）。鉴权沿用 index.js 的
// 本机 Host/Origin 守卫：这些路由挂在 /api 下，守卫先于它们执行。
//
// 错误统一返回 { error, code, rule? }：code 是稳定的机器可读码（见 docs/openapi.yaml），
// rule 指出上传校验里具体哪条规则没过。
import { readFile } from 'node:fs/promises';
import express from 'express';
import { readConfig } from './config-store.js';
import { breezeHealth, BreezeError } from './breeze.js';
import { enqueueVoiceDesign } from './task-manager.js';
import { laneFor } from './breeze-lane.js';
import { findTake } from './voice-design.js';
import {
  REFERENCE_MAX_BYTES, ReferenceError, lockReference, referenceImpact, requireProjectRole,
  transcodeToMonoWav, validateTranscript, validateUploadFile,
} from './voice-references.js';

export function sendError(response, error, next) {
  if (error instanceof ReferenceError || error instanceof BreezeError || (error?.code && Number.isInteger(error.status))) {
    return response.status(error.status || 400).json({ error: error.message, code: error.code || '', ...(error.rule ? { rule: error.rule } : {}), ...(error.details || {}) });
  }
  return next(error);
}

const ROLE_BASE = '/api/projects/:projectId/roles/:roleId';

// multipart 上传：先按大小上限收原始字节（超限直接 413，给出这条规则），再用
// Node 内置的 Response#formData() 解析，不引入新依赖。
const multipartBody = express.raw({ type: 'multipart/form-data', limit: REFERENCE_MAX_BYTES + 1024 * 1024 });
function receiveMultipart(request, response, next) {
  if (!request.is('multipart/form-data')) return next();
  multipartBody(request, response, (error) => {
    if (error?.type === 'entity.too.large') return response.status(413).json({ error: `参考音频文件最大 ${REFERENCE_MAX_BYTES / 1024 / 1024}MB`, code: 'REFERENCE_TOO_LARGE', rule: 'size' });
    if (error) return next(error);
    next();
  });
}

async function parseMultipart(request) {
  try {
    return await new Response(request.body, { headers: { 'content-type': request.headers['content-type'] } }).formData();
  } catch {
    throw new ReferenceError('multipart 表单无法解析', { code: 'REFERENCE_BAD_FORM', rule: 'form' });
  }
}

export function registerBreezeRoutes(app) {
  // 永远 200：reachable 告诉前端服务在不在；active 表示当前是否选用 Breeze。
  app.get('/api/engines/breeze/health', async (_request, response, next) => {
    try {
      const config = await readConfig();
      response.json({ ...(await breezeHealth(config)), active: config.provider === 'breeze', timeoutMs: config.breezeTimeoutMs, queue: laneFor('breeze', config).snapshot() });
    } catch (error) { next(error); }
  });

  // 音色设计试听：立即返回 jobId（= taskId），试听按顺序生成，结果轮询 GET /api/tasks/:id。
  app.post(`${ROLE_BASE}/voice-design/takes`, async (request, response, next) => {
    try {
      const config = await readConfig();
      const { task, deduplicated } = enqueueVoiceDesign(config, { projectId: request.params.projectId, roleId: request.params.roleId, body: request.body || {} });
      response.status(deduplicated ? 200 : 202).json({ jobId: task.id, taskId: task.id, status: task.status, queuePosition: laneFor('breeze', config).positionOf(task.id), deduplicated, task });
    } catch (error) { sendError(response, error, next); }
  });

  app.get(`${ROLE_BASE}/voice-reference`, (request, response, next) => {
    try {
      const { project } = requireProjectRole(request.params.projectId, request.params.roleId);
      const reference = project.state.voiceReferences?.[request.params.roleId];
      if (!reference) return response.status(404).json({ error: '该角色还没有锁定参考音', code: 'REFERENCE_NOT_FOUND' });
      response.json(reference);
    } catch (error) { sendError(response, error, next); }
  });

  // 锁定参考音：JSON { takeId }（来自音色设计试听）或 multipart { file, transcript }（上传）。
  app.post(`${ROLE_BASE}/voice-reference`, receiveMultipart, async (request, response, next) => {
    try {
      const { projectId, roleId } = request.params;
      const config = await readConfig();
      if (config.provider !== 'breeze') throw new ReferenceError('当前语音引擎不是 Breeze：角色参考音只在 Breeze 引擎下可用', { status: 409, code: 'ENGINE_NOT_BREEZE' });
      requireProjectRole(projectId, roleId);
      let locked;
      if (request.is('multipart/form-data')) {
        const form = await parseMultipart(request);
        const transcript = validateTranscript(form.get('transcript'));
        const file = form.get('file');
        validateUploadFile(file);
        const { wav, durationMs } = await transcodeToMonoWav(Buffer.from(await file.arrayBuffer()));
        locked = await lockReference(config, { projectId, roleId, wav, transcript, description: String(form.get('description') || ''), source: 'upload', durationMs });
      } else {
        const takeId = request.body?.takeId;
        if (!takeId) throw new ReferenceError('需要 JSON { takeId } 或 multipart { file, transcript }', { code: 'REFERENCE_INPUT_REQUIRED', rule: 'body' });
        const take = await findTake(projectId, roleId, takeId);
        const { wav, durationMs } = await transcodeToMonoWav(await readFile(take.file), { enforceDuration: false });
        locked = await lockReference(config, { projectId, roleId, wav, transcript: take.transcript, description: take.description, seed: take.take.seed, source: 'design', durationMs });
      }
      const { reference, unchanged } = locked;
      response.status(unchanged ? 200 : 201).json({ referenceId: reference.referenceId, audioHash: reference.audioHash, source: reference.source, version: reference.version, breezeVoiceId: reference.breezeVoiceId, audioUrl: reference.audioUrl, transcript: reference.transcript, unchanged });
    } catch (error) { sendError(response, error, next); }
  });

  // 影响范围（只读、不生成）：换了参考音之后，这个角色哪些已生成的台词需要重新生成。
  app.get(`${ROLE_BASE}/voice-reference/impact`, async (request, response, next) => {
    try {
      const { project } = requireProjectRole(request.params.projectId, request.params.roleId);
      const config = await readConfig();
      response.json(referenceImpact(config, project, request.params.roleId));
    } catch (error) { sendError(response, error, next); }
  });

  // 自动转写（ASR）暂未实现：上传时请手动填写参考文本。
  app.post(`${ROLE_BASE}/voice-reference/transcribe`, (_request, response) => {
    response.status(501).json({ error: '自动转写尚未实现，请手动填写参考文本', code: 'ASR_NOT_IMPLEMENTED' });
  });
}


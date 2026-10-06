async function apiRequest(path, options = {}) {
  const response = await fetch(path, { ...options, headers: options.body ? { 'Content-Type': 'application/json', ...options.headers } : options.headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败 (${response.status})`);
  return payload;
}

export const api = {
  health: () => apiRequest('/api/health'),
  getConfig: () => apiRequest('/api/config'),
  saveConfig: (config) => apiRequest('/api/config', { method: 'PUT', body: JSON.stringify(config) }),
  testLlm: (config) => apiRequest('/api/config/test-llm', { method: 'POST', body: JSON.stringify(config) }),
  listProjects: () => apiRequest('/api/projects'),
  createProject: (input) => apiRequest('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  getProject: (projectId) => apiRequest(`/api/projects/${projectId}`),
  saveProject: (projectId, input) => apiRequest(`/api/projects/${projectId}`, { method: 'PUT', body: JSON.stringify(input) }),
  archiveProject: (projectId) => apiRequest(`/api/projects/${projectId}`, { method: 'DELETE' }),
  analyzeNovel: (projectId, input) => apiRequest(`/api/projects/${projectId}/analyze`, { method: 'POST', body: JSON.stringify(input) }),
  listTasks: (projectId) => apiRequest(`/api/projects/${projectId}/tasks`),
  getMediaReport: (projectId) => apiRequest(`/api/projects/${projectId}/media-report`),
  mediaPeaks: (url) => apiRequest(`/api/media/peaks?url=${encodeURIComponent(url)}`),
  generate: (input) => apiRequest('/api/generate', { method: 'POST', body: JSON.stringify(input) }),
  getTask: (taskId) => apiRequest(`/api/tasks/${taskId}`),
  cancelTask: (taskId) => apiRequest(`/api/tasks/${taskId}/cancel`, { method: 'POST' }),
  retryTask: (taskId) => apiRequest(`/api/tasks/${taskId}/retry`, { method: 'POST' }),
  exportScene: (projectId, sceneId) => apiRequest(`/api/projects/${projectId}/export-scene`, { method: 'POST', body: JSON.stringify({ sceneId }) }),
  previewScene: (projectId, sceneId) => apiRequest(`/api/projects/${projectId}/preview-scene`, { method: 'POST', body: JSON.stringify({ sceneId }) }),
  exportEpisode: (projectId) => apiRequest(`/api/projects/${projectId}/export-episode`, { method: 'POST' }),
  oneClick: (projectId) => apiRequest(`/api/projects/${projectId}/one-click`, { method: 'POST' }),
  oneClickEstimate: (projectId) => apiRequest(`/api/projects/${projectId}/one-click-estimate`, { method: 'POST' }),
  designVoice: (input) => apiRequest('/api/voices/design', { method: 'POST', body: JSON.stringify(input) }),
  deleteAsset: (url) => apiRequest(`/api/assets?url=${encodeURIComponent(url)}`, { method: 'DELETE' }),
  uploadAsset: async (file) => {
    const response = await fetch('/api/assets/upload', { method: 'POST', headers: { 'Content-Type': file.type || 'audio/wav', 'X-File-Name': encodeURIComponent(file.name) }, body: await file.arrayBuffer() });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '素材上传失败');
    return payload;
  },
};

// Poll with backoff (350ms → 2s cap) and an overall deadline so a stuck
// server-side task surfaces as an error instead of spinning forever.
// getTask/sleep are injectable so node:test can drive the state machine.
export async function waitForTask(taskId, onProgress, { timeoutMs = 30 * 60 * 1000, getTask = () => api.getTask(taskId), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const deadline = Date.now() + timeoutMs;
  let delay = 350;
  for (;;) {
    const task = await getTask();
    onProgress?.(task);
    if (task.status === 'completed') return task;
    if (task.status === 'failed') throw new Error(task.error || '生成失败');
    if (task.status === 'cancelled') throw new Error('任务已取消');
    if (Date.now() > deadline) throw new Error('等待任务超时，请在任务列表中查看状态或重试');
    await sleep(delay);
    delay = Math.min(2000, Math.round(delay * 1.5));
  }
}

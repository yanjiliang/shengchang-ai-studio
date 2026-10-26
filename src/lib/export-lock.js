// 一键成片在跑（queued / running）时，所有导出入口都停用，旁边写「正在配音，配完再导出」。
// 状态以服务端任务为准（GET /api/projects/{id}/tasks?limit=100 里 kind=one-click 的那条），
// 刷新页面后照样能看出来；本地只补「刚点开始、任务列表还没刷新到」这一小段。
export const EXPORT_LOCK_TEXT = '正在配音，配完再导出';
const ACTIVE = ['queued', 'running'];
const FINAL = ['completed', 'failed', 'cancelled'];

export function activeOneClickTask(tasks) {
  return (Array.isArray(tasks) ? tasks : []).find((task) => task?.kind === 'one-click' && ACTIVE.includes(task.status)) || null;
}

// tasks：最近一次从服务端读到的任务列表（null = 还没读到）。
// pendingTaskId：本页刚开始的一键成片任务 id；列表里还没有它、或它还没结束，就当它在跑。
export function exportLockState({ tasks = null, pendingTaskId = '' } = {}) {
  const active = activeOneClickTask(tasks);
  if (active) return { locked: true, reason: EXPORT_LOCK_TEXT, taskId: active.id };
  if (pendingTaskId) {
    const own = (Array.isArray(tasks) ? tasks : []).find((task) => task?.id === pendingTaskId);
    if (!own || !FINAL.includes(own.status)) return { locked: true, reason: EXPORT_LOCK_TEXT, taskId: pendingTaskId };
  }
  return { locked: false, reason: '', taskId: '' };
}

// 竞态下服务端仍可能 409（例如导出前自动保存撞上一键成片：「一键成片运行中，完成后可继续编辑」）。
// 导出路径上的 409 一律换成人话，不把原始报错丢给用户。
export function exportErrorText(error) {
  if (Number(error?.status) === 409) return EXPORT_LOCK_TEXT;
  return error?.message || '导出失败';
}

import { activeOneClickTask } from './export-lock.js';

// 「一键成片」按钮在任务进行中的样子（fe-0011）。来源和导出锁一样：GET /api/projects/{id}/tasks 里
// kind=one-click、status=queued/running 的那条，所以刷新页面也认得。
// 服务端一键成片任务没有整集的「已配 / 总数」字段：只有 task.progress（0–99 的整体百分比）和
// task.message（「生成 · 场景名 · 正在处理 3 / 12 句」只是当前场景内的计数）。所以配音阶段写「配音中 N%」。
// 阶段按 message 前缀（server/one-click.js 的「拆解 · / 音色 · / 生成 · / 体检 · / 导出 ·」）和 payload.completedStages 判断。
export const ONE_CLICK_IDLE_LABEL = '一键成片';
export const ONE_CLICK_QUEUED_LABEL = '排队中';
export const ONE_CLICK_EXPORTING_LABEL = '正在导出';
export const ONE_CLICK_BUSY_TITLE = '一键成片进行中，点开任务历史看进度';

const percentOf = (task) => {
  if (task?.progress === null || task?.progress === undefined || task?.progress === '') return null;
  const value = Number(task.progress);
  if (!Number.isFinite(value)) return null;
  // 旧任务可能存 0–1 的小数。
  return Math.max(0, Math.min(99, Math.round(value < 1 && value > 0 ? value * 100 : value)));
};

export function oneClickStage(task) {
  const message = String(task?.message || '');
  const stages = Array.isArray(task?.payload?.completedStages) ? task.payload.completedStages : [];
  if (message.startsWith('导出') || stages.includes('体检')) return 'export';
  if (message.startsWith('拆解')) return 'analyze';
  return 'voice';
}

// task：activeOneClickTask(tasks) 的结果，或 null。返回 null = 没在跑（显示原来的「一键成片」）。
export function oneClickButtonState(task) {
  if (!task || !['queued', 'running'].includes(task.status)) return null;
  if (task.status === 'queued') return { taskId: task.id, label: ONE_CLICK_QUEUED_LABEL, stage: 'queued' };
  const stage = oneClickStage(task);
  if (stage === 'export') return { taskId: task.id, label: ONE_CLICK_EXPORTING_LABEL, stage };
  const percent = percentOf(task);
  const word = stage === 'analyze' ? '拆解中' : '配音中';
  return { taskId: task.id, label: percent === null ? word : `${word} ${percent}%`, stage };
}

// lock：exportLockState 的结果。列表里还没有刚开始的那条（pendingTaskId）时也算「排队中」。
export function oneClickButtonFromTasks(tasks, lock = null) {
  const active = activeOneClickTask(tasks);
  if (active) return oneClickButtonState(active);
  if (lock?.locked && lock.taskId) return { taskId: lock.taskId, label: ONE_CLICK_QUEUED_LABEL, stage: 'queued' };
  return null;
}

// B1：一键成片从「在跑」变成「完成」时要重新读项目 / 混音 / 时间轴。
// previousActiveId：上一次轮询时在跑的一键成片 id；tasks：这一次的任务列表。
// 返回刚结束的那条任务（completed / failed / cancelled 都算，部分句子可能已经写进作品），否则 null。
export function finishedOneClick(previousActiveId, tasks) {
  if (!previousActiveId || !Array.isArray(tasks)) return null;
  const task = tasks.find((item) => item?.id === previousActiveId);
  return task && ['completed', 'failed', 'cancelled'].includes(task.status) ? task : null;
}

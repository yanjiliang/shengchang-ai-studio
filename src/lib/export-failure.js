// 导出失败的人话（fe-0010，Product item 2 + Design）。0045 起服务端把 ffmpeg 最后几行 stderr 原样带回来
// （状态码、返回结构不变）。界面上不直接摆这些原文：主文案固定一句，原文收进可展开的「详情」，等宽、可复制。
// 409（一键成片在跑）仍沿用 fe-0009 的「正在配音，配完再导出」，不算失败，也不给详情。
import { EXPORT_LOCK_TEXT } from './export-lock.js';

export const EXPORT_FAILED_TEXT = '导出失败，音频没能合成。可以重试一次';
export const EXPORT_DETAIL_LABEL = '详情';

const raw = (value) => String(value ?? '').trim();

// error：fetch 抛出的 Error（带 status）、任务失败抛出的 Error，或直接一段文字。
export function exportFailureView(error) {
  if (Number(error?.status) === 409) return { locked: true, text: EXPORT_LOCK_TEXT, detail: '' };
  const detail = raw(typeof error === 'string' ? error : error?.message);
  return { locked: false, text: EXPORT_FAILED_TEXT, detail };
}

// 一键成片的哪一步：payload.completedStages 里有「体检」没有「导出」= 卡在导出这一步。
const ONE_CLICK_SPECIAL = ['BREEZE_UNREACHABLE', 'VOICE_NOT_READY'];
const codeOf = (task) => task?.code || task?.errorCode || task?.payload?.code || task?.result?.code || '';
export function oneClickFailedAtExport(task) {
  if (task?.kind !== 'one-click' || task.status !== 'failed') return false;
  if (ONE_CLICK_SPECIAL.includes(codeOf(task))) return false;
  const stages = Array.isArray(task.payload?.completedStages) ? task.payload.completedStages : [];
  return stages.includes('体检') && !stages.includes('导出');
}

// 任务历史里的一行：是导出失败就返回 { text, detail }，否则 null（照旧显示 task.error / task.message）。
export function exportTaskFailure(task) {
  if (!task || task.status !== 'failed') return null;
  if (task.kind !== 'export-project' && !oneClickFailedAtExport(task)) return null;
  return { text: EXPORT_FAILED_TEXT, detail: raw(task.error) || raw(task.message) };
}

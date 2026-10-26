// 导出失败的人话（fe-0010，Product item 2 + Design）。0045 起服务端把 ffmpeg 最后几行 stderr 原样带回来
// （状态码、返回结构不变）。界面上不直接摆这些原文：主文案固定一句，原文收进可展开的「详情」，等宽、可复制。
// 409（一键成片在跑）仍沿用 fe-0009 的「正在配音，配完再导出」，不算失败，也不给详情。
import { EXPORT_LOCK_TEXT } from './export-lock.js';

export const EXPORT_FAILED_TEXT = '导出失败，音频没能合成。可以重试一次';
export const EXPORT_DETAIL_LABEL = '详情';

const raw = (value) => String(value ?? '').trim();

// 0049（e2e6 B4）：有台词的音频文件不在磁盘上时，导出直接拒绝：
//   同步导出（本场 / 试听）→ 409 { code: 'AUDIO_FILE_MISSING', error: '有 N 句台词的音频文件不见了（…），请先重新生成这几句再导出',
//                                 details: { missingFileLines: [{ sceneId, lineId, speaker, text }] } }
//   整集导出任务 → status failed，task.error 是同一句话（任务里没有 code / details，句子从 export-precheck 的 missingFileLines 补）。
// 这种失败重试没用：主文案用服务端那句（已经写了是哪几句），列出句子，给「重新生成这几句」，原文仍收在「详情」。
// 409 ONE_CLICK_RUNNING（0049 B2，服务端也锁导出）和以前的 409 一样，归到「正在配音，配完再导出」。
export const AUDIO_FILE_MISSING = 'AUDIO_FILE_MISSING';
export const MISSING_FILES_ACTION = '重新生成这几句';
const MISSING_PATTERN = /音频文件不见了/;
const codeOfError = (error) => error?.code || error?.payload?.code || '';
export function isAudioFileMissing(error) {
  if (!error) return false;
  if (codeOfError(error) === AUDIO_FILE_MISSING) return true;
  return MISSING_PATTERN.test(typeof error === 'string' ? error : String(error?.message || error?.error || ''));
}
export function missingFileLinesOf(error) {
  const lines = error?.payload?.details?.missingFileLines ?? error?.details?.missingFileLines;
  return Array.isArray(lines) ? lines.filter((item) => item?.lineId) : [];
}
// 句子补上角色和开头几个字（precheck 的 missingFileLines 只有 sceneId / lineId）。
export function resolveMissingLines(items = [], scenes = []) {
  const byId = new Map(scenes.flatMap((scene) => (scene.lines || []).map((line) => [line.id, { line, sceneId: scene.id }])));
  return items.filter((item) => item?.lineId).map((item) => {
    const found = byId.get(item.lineId);
    return { lineId: item.lineId, sceneId: item.sceneId || found?.sceneId || '', speaker: item.speaker || found?.line.speaker || '', text: String(item.text || found?.line.text || '').slice(0, 20) };
  });
}
export const missingLineLabel = (item) => `${item.speaker ? `${item.speaker}：` : ''}「${item.text || item.lineId}」`;
function missingView(message, lines) {
  const text = raw(message) || '有台词的音频文件不见了，请先重新生成这几句再导出';
  const detail = [text, ...lines.map((item) => `${item.lineId}  ${missingLineLabel(item)}`)].join('\n');
  return { locked: false, missing: true, text, detail, lines };
}

// error：fetch 抛出的 Error（带 status）、任务失败抛出的 Error，或直接一段文字。
export function exportFailureView(error) {
  if (isAudioFileMissing(error)) return missingView(typeof error === 'string' ? error : error?.message, missingFileLinesOf(error));
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
  if (isAudioFileMissing(task.error)) return missingView(task.error, []);
  return { text: EXPORT_FAILED_TEXT, detail: raw(task.error) || raw(task.message) };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPORT_FAILED_TEXT, exportFailureView, exportTaskFailure, oneClickFailedAtExport } from './export-failure.js';
import { EXPORT_LOCK_TEXT } from './export-lock.js';

const FFMPEG = '[aac @ 0x1] Invalid data found when processing input\n/tmp/x/line-3.wav: Invalid data found when processing input';

test('exportFailureView：普通失败给固定文案，原文进详情', () => {
  const error = Object.assign(new Error(FFMPEG), { status: 500 });
  assert.deepEqual(exportFailureView(error), { locked: false, text: EXPORT_FAILED_TEXT, detail: FFMPEG });
  assert.equal(EXPORT_FAILED_TEXT, '导出失败，音频没能合成。可以重试一次');
});

test('exportFailureView：409 仍是「正在配音，配完再导出」，没有详情', () => {
  const error = Object.assign(new Error('一键成片运行中，完成后可继续编辑'), { status: 409 });
  assert.deepEqual(exportFailureView(error), { locked: true, text: EXPORT_LOCK_TEXT, detail: '' });
  assert.equal(exportFailureView({ status: '409', message: 'x' }).locked, true);
});

test('exportFailureView：没有原文时详情为空；直接传一段文本也能用', () => {
  assert.equal(exportFailureView(new Error('')).detail, '');
  assert.equal(exportFailureView(undefined).text, EXPORT_FAILED_TEXT);
  assert.equal(exportFailureView('  ffmpeg执行失败 ').detail, 'ffmpeg执行失败');
});

test('exportTaskFailure：失败的整集导出任务换成人话，原文进详情', () => {
  const task = { kind: 'export-project', status: 'failed', message: '整集导出失败', error: FFMPEG };
  assert.deepEqual(exportTaskFailure(task), { text: EXPORT_FAILED_TEXT, detail: FFMPEG });
  assert.deepEqual(exportTaskFailure({ ...task, error: '' }), { text: EXPORT_FAILED_TEXT, detail: '整集导出失败' });
});

test('exportTaskFailure：没失败、或不是导出的任务不处理', () => {
  assert.equal(exportTaskFailure({ kind: 'export-project', status: 'completed' }), null);
  assert.equal(exportTaskFailure({ kind: 'export-project', status: 'cancelled', error: 'x' }), null);
  assert.equal(exportTaskFailure({ kind: 'generate-scene', status: 'failed', error: 'x' }), null);
  assert.equal(exportTaskFailure(null), null);
});

test('一键成片：卡在导出这一步才算导出失败', () => {
  const base = { kind: 'one-click', status: 'failed', message: '一键成片失败', error: FFMPEG };
  const atExport = { ...base, payload: { completedStages: ['拆解', '音色', '生成', '体检'] } };
  assert.equal(oneClickFailedAtExport(atExport), true);
  assert.deepEqual(exportTaskFailure(atExport), { text: EXPORT_FAILED_TEXT, detail: FFMPEG });
  assert.equal(exportTaskFailure({ ...base, payload: { completedStages: ['拆解', '音色'] } }), null);
  assert.equal(exportTaskFailure({ ...base, payload: {} }), null);
  assert.equal(exportTaskFailure({ ...base, payload: { completedStages: ['拆解', '音色', '生成', '体检', '导出'] } }), null);
});

test('一键成片：Breeze 断开 / 音色没定有自己的提示，不当成导出失败', () => {
  const stages = { completedStages: ['拆解', '音色', '生成', '体检'] };
  assert.equal(exportTaskFailure({ kind: 'one-click', status: 'failed', code: 'BREEZE_UNREACHABLE', payload: stages }), null);
  assert.equal(exportTaskFailure({ kind: 'one-click', status: 'failed', payload: { ...stages, code: 'VOICE_NOT_READY' } }), null);
});

// ---- 0049 B4：音频文件丢了 / B2：一键成片在跑 ----
import { isAudioFileMissing, missingLineLabel, resolveMissingLines } from './export-failure.js';
const MISSING_TEXT = '有 1 句台词的音频文件不见了（老陈：「你又来了」），请先重新生成这几句再导出';

test('AUDIO_FILE_MISSING（同步 409）：主文案用服务端那句，列出句子，不给重试', () => {
  const error = Object.assign(new Error(MISSING_TEXT), { status: 409, code: 'AUDIO_FILE_MISSING', payload: { code: 'AUDIO_FILE_MISSING', error: MISSING_TEXT, details: { missingFileLines: [{ sceneId: 's1', lineId: 'l2', speaker: '老陈', text: '你又来了' }] } } });
  const view = exportFailureView(error);
  assert.equal(view.locked, false);
  assert.equal(view.missing, true);
  assert.equal(view.text, MISSING_TEXT);
  assert.notEqual(view.text, EXPORT_FAILED_TEXT);
  assert.deepEqual(view.lines, [{ sceneId: 's1', lineId: 'l2', speaker: '老陈', text: '你又来了' }]);
  assert.match(view.detail, /l2 {2}老陈：「你又来了」/);
  assert.equal(isAudioFileMissing(error), true);
});

test('整集导出任务因文件丢失失败：认 task.error 那句话（任务里没有 code）', () => {
  const view = exportTaskFailure({ kind: 'export-project', status: 'failed', message: '整集导出失败', error: MISSING_TEXT });
  assert.equal(view.missing, true);
  assert.equal(view.text, MISSING_TEXT);
  assert.deepEqual(view.lines, []);
  assert.equal(exportFailureView(new Error(MISSING_TEXT)).missing, true);
});

test('409 ONE_CLICK_RUNNING → 「正在配音，配完再导出」', () => {
  const view = exportFailureView(Object.assign(new Error('正在配音，配完再导出'), { status: 409, code: 'ONE_CLICK_RUNNING' }));
  assert.equal(view.locked, true);
  assert.equal(view.text, EXPORT_LOCK_TEXT);
});

test('precheck 的 missingFileLines 只有 id：从作品里补角色和台词开头', () => {
  const scenes = [{ id: 's1', lines: [{ id: 'l1', speaker: '林舟', text: '灯塔今晚又亮了一整夜，海上什么都没有。' }] }];
  const lines = resolveMissingLines([{ sceneId: 's1', lineId: 'l1' }, { lineId: '' }], scenes);
  assert.deepEqual(lines, [{ lineId: 'l1', sceneId: 's1', speaker: '林舟', text: '灯塔今晚又亮了一整夜，海上什么都没有。'.slice(0, 20) }]);
  assert.equal(missingLineLabel(lines[0]).startsWith('林舟：「灯塔'), true);
  assert.equal(missingLineLabel({ lineId: 'x' }), '「x」');
});

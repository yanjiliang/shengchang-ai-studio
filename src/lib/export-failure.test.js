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

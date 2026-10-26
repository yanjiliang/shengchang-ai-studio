import test from 'node:test';
import assert from 'node:assert/strict';
import { EXPORT_LOCK_TEXT, activeOneClickTask, exportErrorText, exportLockState } from './export-lock.js';

const task = (id, kind, status) => ({ id, kind, status });

test('一键成片 queued / running → 导出停用，写「正在配音，配完再导出」', () => {
  for (const status of ['queued', 'running']) {
    const state = exportLockState({ tasks: [task('x', 'export-project', 'completed'), task('oc', 'one-click', status)] });
    assert.deepEqual(state, { locked: true, reason: '正在配音，配完再导出', taskId: 'oc' });
  }
  assert.equal(EXPORT_LOCK_TEXT, '正在配音，配完再导出');
});

test('一键成片 completed / failed / cancelled → 导出恢复', () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    assert.deepEqual(exportLockState({ tasks: [task('oc', 'one-click', status)] }), { locked: false, reason: '', taskId: '' });
  }
});

test('别的任务在跑（单句、导出、拆解）不锁导出；没有任务、还没读到列表也不锁', () => {
  assert.equal(exportLockState({ tasks: [task('a', 'line-take', 'running'), task('b', 'export-project', 'running'), task('c', 'analyze-novel', 'queued')] }).locked, false);
  assert.equal(exportLockState({ tasks: [] }).locked, false);
  assert.equal(exportLockState({ tasks: null }).locked, false);
  assert.equal(exportLockState().locked, false);
  assert.equal(activeOneClickTask('garbage'), null);
});

test('刷新页面后：只看服务端列表，本地没有 pendingTaskId 也照样锁', () => {
  assert.equal(exportLockState({ tasks: [task('old', 'one-click', 'running')], pendingTaskId: '' }).locked, true);
});

test('刚点开始、列表还没刷到这条任务 → 先锁；列表里它结束了 → 解锁', () => {
  assert.equal(exportLockState({ tasks: null, pendingTaskId: 'new' }).locked, true);
  assert.equal(exportLockState({ tasks: [task('old', 'one-click', 'completed')], pendingTaskId: 'new' }).locked, true);
  assert.equal(exportLockState({ tasks: [task('new', 'one-click', 'running')], pendingTaskId: 'new' }).taskId, 'new');
  for (const status of ['completed', 'failed', 'cancelled']) assert.equal(exportLockState({ tasks: [task('new', 'one-click', status)], pendingTaskId: 'new' }).locked, false);
});

test('旧的一键成片结束了，新的一条又在跑 → 仍锁（以在跑的那条为准）', () => {
  const state = exportLockState({ tasks: [task('b', 'one-click', 'queued'), task('a', 'one-click', 'completed')], pendingTaskId: 'a' });
  assert.deepEqual(state, { locked: true, reason: EXPORT_LOCK_TEXT, taskId: 'b' });
});

test('导出路径上的 409 换成人话，其它错误原样', () => {
  assert.equal(exportErrorText(Object.assign(new Error('一键成片运行中，完成后可继续编辑'), { status: 409 })), '正在配音，配完再导出');
  assert.equal(exportErrorText({ status: '409', message: 'x' }), '正在配音，配完再导出');
  assert.equal(exportErrorText(Object.assign(new Error('磁盘满了'), { status: 500 })), '磁盘满了');
  assert.equal(exportErrorText(null), '导出失败');
});

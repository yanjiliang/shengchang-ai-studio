import test from 'node:test';
import assert from 'node:assert/strict';
import { finishedOneClick, oneClickButtonFromTasks, oneClickButtonState, oneClickStage } from './one-click-progress.js';

const task = (over) => ({ id: 't1', kind: 'one-click', status: 'running', progress: 0, message: '', payload: {}, ...over });

test('一键成片按钮：排队中 / 拆解中 N% / 配音中 N% / 正在导出', () => {
  assert.equal(oneClickButtonState(null), null);
  assert.equal(oneClickButtonState(task({ status: 'completed' })), null);
  assert.deepEqual(oneClickButtonState(task({ status: 'queued' })), { taskId: 't1', label: '排队中', stage: 'queued' });
  assert.equal(oneClickButtonState(task({ progress: 4, message: '拆解 · 正在拆解原文' })).label, '拆解中 4%');
  assert.equal(oneClickButtonState(task({ progress: 37, message: '生成 · 第一场 · 正在处理 3 / 12 句', payload: { completedStages: ['拆解', '音色'] } })).label, '配音中 37%');
  assert.equal(oneClickButtonState(task({ progress: 1, message: '音色 · 检查' })).label, '配音中 1%');
  assert.equal(oneClickButtonState(task({ progress: 0.42, message: '生成 · x' })).label, '配音中 42%');
  assert.equal(oneClickButtonState(task({ progress: 120, message: '生成 · x' })).label, '配音中 99%');
  assert.equal(oneClickButtonState(task({ progress: null, message: '生成 · x' })).label, '配音中');
  assert.equal(oneClickButtonState(task({ progress: 92, message: '导出 · 正在渲染整集' })).label, '正在导出');
  assert.equal(oneClickStage(task({ message: '', payload: { completedStages: ['拆解', '音色', '生成', '体检'] } })), 'export');
});

test('按钮状态来自任务列表（刷新页面也在），刚开始还没进列表 = 排队中', () => {
  const tasks = [{ id: 'x', kind: 'export-project', status: 'running' }, task({ id: 't9', progress: 50, message: '生成 · a' })];
  assert.deepEqual(oneClickButtonFromTasks(tasks), { taskId: 't9', label: '配音中 50%', stage: 'voice' });
  assert.equal(oneClickButtonFromTasks([{ id: 'x', kind: 'export-project', status: 'running' }]), null);
  assert.deepEqual(oneClickButtonFromTasks([], { locked: true, taskId: 'new' }), { taskId: 'new', label: '排队中', stage: 'queued' });
  assert.equal(oneClickButtonFromTasks(null, { locked: false, taskId: '' }), null);
});

test('B1：在跑的一键成片结束（完成 / 失败 / 取消）才算刚结束', () => {
  assert.equal(finishedOneClick('', [task({ status: 'completed' })]), null);
  assert.equal(finishedOneClick('t1', [task({ status: 'running' })]), null);
  assert.equal(finishedOneClick('t1', null), null);
  assert.equal(finishedOneClick('t1', [task({ status: 'completed' })]).id, 't1');
  assert.equal(finishedOneClick('t1', [task({ status: 'failed' })]).status, 'failed');
  assert.equal(finishedOneClick('t1', [task({ id: 't2', status: 'completed' })]), null);
});

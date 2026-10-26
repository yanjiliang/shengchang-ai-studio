import test from 'node:test';
import assert from 'node:assert/strict';
import { breezeOutage, steadyBreezeStatus, doubaoSwitchConfirm, outageCounts, BEFORE_START_TEXT } from './breeze-outage.js';

test('开始前连不上：不开始、不花额度，只给重试和去设置', () => {
  const error = Object.assign(new Error('Breeze 连不上'), { status: 503, code: 'BREEZE_UNREACHABLE', payload: { code: 'BREEZE_UNREACHABLE' } });
  assert.deepEqual(breezeOutage(error), { phase: 'before', text: BEFORE_START_TEXT, actions: ['retry', 'settings'] });
  assert.equal(breezeOutage({ status: 'failed', result: { code: 'BREEZE_UNREACHABLE', freshCount: 0, cacheHits: 0 } }).phase, 'before');
});

test('中途断开：一条横幅，已配好 N 句、还剩 M 句', () => {
  const task = { status: 'failed', result: { code: 'BREEZE_UNREACHABLE', freshCount: 12, cacheHits: 3, totalCount: 40 } };
  assert.deepEqual(breezeOutage(task), { phase: 'midrun', done: 15, remaining: 25, text: 'Breeze 中途断开，已配好 15 句，还剩 25 句', actions: ['resume'] });
  assert.deepEqual(outageCounts({ doneCount: 5, remainingCount: 2 }), { done: 5, remaining: 2 });
  assert.equal(breezeOutage({ status: 'failed', result: { code: 'X' } }), null);
});

test('硬规则：Breeze 不可用时绝不自动改用豆包', () => {
  for (const source of [{ code: 'BREEZE_UNREACHABLE' }, { status: 'failed', result: { code: 'BREEZE_UNREACHABLE', freshCount: 3 } }]) {
    const outage = breezeOutage(source);
    assert.ok(outage.actions.every((action) => ['retry', 'settings', 'resume'].includes(action)));
    assert.equal(JSON.stringify(outage).includes('豆包'), false);
    assert.equal('provider' in outage, false);
  }
});

test('生成中健康检查失败不显示断开', () => {
  const connected = { state: 'connected', label: '已连接' };
  const down = { state: 'disconnected', label: '未连接' };
  assert.equal(steadyBreezeStatus(connected, down, { generating: true }).state, 'connected');
  assert.equal(steadyBreezeStatus(connected, down, { generating: false }).state, 'disconnected');
});

test('换到豆包后第一次生成的确认文案', () => {
  assert.equal(doubaoSwitchConfirm({ requestCount: 30, estimatedBillableCharacters: 1200 }), '接下来 30 句会用豆包生成，约扣 1200 字额度，声音也会和 Breeze 不一样');
  assert.equal(doubaoSwitchConfirm({ requestCount: 19, estimatedBillableCharacters: null, characters: 640 }), '接下来 19 句会用豆包生成，约扣 640 字额度，声音也会和 Breeze 不一样');
  assert.equal(doubaoSwitchConfirm({ requestCount: 0 }), '');
});

test('0036/0037 字段：skippedCount 推出 N，completedLineCount 优先', () => {
  const task = { status: 'failed', result: { code: 'BREEZE_UNREACHABLE', causeCode: 'BREEZE_TIMEOUT', skippedCount: 25 } };
  assert.equal(breezeOutage(task, { requestCount: 40 }).text, 'Breeze 中途断开，已配好 15 句，还剩 25 句');
  assert.equal(breezeOutage({ status: 'failed', result: { code: 'BREEZE_UNREACHABLE', skippedCount: 40 } }, { requestCount: 40 }).phase, 'before');
  assert.deepEqual(outageCounts({ completedLineCount: 7, remainingLineCount: 3, skippedCount: 99 }), { done: 7, remaining: 3 });
  assert.equal(breezeOutage({ status: 'failed', result: { code: 'BREEZE_UNREACHABLE', completedLineCount: 0, remainingLineCount: 40 } }).phase, 'before');
});

test('0037：causeCode BREEZE_TIMEOUT 仍是一条横幅，多一行原因；单句失败只在这句上说', async () => {
  const { lineTakeError, TIMEOUT_DETAIL } = await import('./breeze-outage.js');
  const o = breezeOutage({ status: 'failed', result: { code: 'BREEZE_UNREACHABLE', causeCode: 'BREEZE_TIMEOUT', completedLineCount: 7, remainingLineCount: 5 } });
  assert.equal(o.phase, 'midrun'); assert.equal(o.text, 'Breeze 中途断开，已配好 7 句，还剩 5 句'); assert.equal(o.detail, TIMEOUT_DETAIL);
  assert.equal(breezeOutage({ status: 'failed', result: { code: 'BREEZE_UNREACHABLE', causeCode: 'BREEZE_UNREACHABLE', completedLineCount: 0, remainingLineCount: 12 } }).phase, 'before');
  assert.match(lineTakeError({ code: 'BREEZE_UNREACHABLE', causeCode: 'BREEZE_TIMEOUT' }), /太久没有响应/);
  assert.match(lineTakeError({ code: 'BREEZE_UNREACHABLE' }), /^Breeze 连不上/);
  assert.equal(lineTakeError({ code: 'X', error: '别的错' }), '别的错');
  assert.doesNotMatch(lineTakeError({ code: 'BREEZE_UNREACHABLE' }), /豆包/);
});

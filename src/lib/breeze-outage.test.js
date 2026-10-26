import test from 'node:test';
import assert from 'node:assert/strict';
import { breezeOutage, steadyBreezeStatus, doubaoSwitchConfirm, doubaoSwitchDialog, outageCounts, BEFORE_START_TEXT } from './breeze-outage.js';

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

test('doubaoSwitchDialog：标题只写上限「最多约扣 X 字额度」，X 取全部待生成字数', () => {
  assert.deepEqual(doubaoSwitchDialog({ requestCount: 19, estimatedBillableCharacters: null, characters: 390 }), { title: '最多约扣 390 字额度', detail: '接下来 19 句会用豆包生成，声音也会和 Breeze 不一样' });
  assert.equal(doubaoSwitchDialog({ requestCount: 30, estimatedBillableCharacters: 1200, characters: 1500 }).title, '最多约扣 1500 字额度');
  assert.equal(doubaoSwitchDialog({ requestCount: 30, estimatedBillableCharacters: 1200 }).title, '最多约扣 1200 字额度');
  assert.equal(doubaoSwitchDialog({ requestCount: 3 }).title, '会按字扣豆包额度');
  assert.equal(doubaoSwitchDialog({ requestCount: 0, characters: 10 }), null);
  assert.ok(!JSON.stringify(doubaoSwitchDialog({ requestCount: 19, characters: 390 })).includes('缓存'));
});

test('N4：健康检查超时 = 没有响应横幅（同样的重试 / 去设置），连不上照旧', async () => {
  const { breezeHealthOutage, NO_RESPONSE_TEXT } = await import('./breeze-outage.js');
  const { normalizeBreezeStatus } = await import('./engine.js');
  const { breezeHealthPayload } = await import('./chain-api.js');
  assert.equal(NO_RESPONSE_TEXT, 'Breeze 没有响应，可能正忙或卡住了。可以在 Mac 上重启 Breeze，再点重试。');
  const timedOut = normalizeBreezeStatus(breezeHealthPayload({ status: 'timeout', reachable: false, error: 'Breeze 超时' }));
  assert.equal(timedOut.state, 'disconnected');
  assert.equal(timedOut.cause, 'timeout');
  assert.equal(timedOut.label, '没有响应');
  assert.deepEqual(breezeHealthOutage(timedOut), { phase: 'before', causeCode: 'BREEZE_TIMEOUT', text: NO_RESPONSE_TEXT, actions: ['retry', 'settings'] });
  assert.ok(!/自动/.test(NO_RESPONSE_TEXT));
  const down = normalizeBreezeStatus(breezeHealthPayload({ status: 'unreachable', reachable: false }));
  assert.equal(down.cause, undefined);
  assert.equal(breezeHealthOutage(down).text, BEFORE_START_TEXT);
  assert.equal(breezeHealthOutage(normalizeBreezeStatus(breezeHealthPayload({ status: 'ok', reachable: true }))), null);
});

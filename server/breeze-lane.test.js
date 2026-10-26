// 引擎生成通道：单飞、优先级插队、queuePosition、取消排队 / 在飞。纯内存，不发请求。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createLane, laneFor, normalizeEngineConcurrency, PRIORITY } from './breeze-lane.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe('createLane', () => {
  test('concurrency 1 一次只跑一个；interactive 插到 batch 前面，同档按到达顺序', async () => {
    const lane = createLane({ concurrency: 1 });
    const order = [];
    let inFlight = 0;
    let peak = 0;
    const gate = deferred();
    const job = (name, wait) => async () => {
      inFlight += 1; peak = Math.max(peak, inFlight); order.push(name);
      if (wait) await wait;
      inFlight -= 1;
      return name;
    };
    const runs = [
      lane.run({ jobId: 'b1', priority: PRIORITY.batch, fn: job('b1', gate.promise) }),
      lane.run({ jobId: 'b2', priority: PRIORITY.batch, fn: job('b2') }),
      lane.run({ jobId: 'b3', priority: PRIORITY.batch, fn: job('b3') }),
      lane.run({ jobId: 'p1', priority: PRIORITY.interactive, fn: job('p1') }),
      lane.run({ jobId: 'p2', priority: PRIORITY.interactive, fn: job('p2') }),
    ];
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(lane.positionOf('b1'), 0);
    assert.equal(lane.positionOf('p1'), 1);
    assert.equal(lane.positionOf('p2'), 2);
    assert.equal(lane.positionOf('b2'), 3);
    assert.equal(lane.positionOf('b3'), 4);
    assert.equal(lane.positionOf('nope'), null);
    gate.resolve();
    assert.deepEqual(await Promise.all(runs), ['b1', 'b2', 'b3', 'p1', 'p2']);
    assert.deepEqual(order, ['b1', 'p1', 'p2', 'b2', 'b3']);
    assert.equal(peak, 1);
  });

  test('concurrency 2 同时两个在飞', async () => {
    const lane = createLane({ concurrency: 2 });
    let inFlight = 0;
    let peak = 0;
    const fn = async () => { inFlight += 1; peak = Math.max(peak, inFlight); await new Promise((resolve) => setTimeout(resolve, 10)); inFlight -= 1; };
    await Promise.all([1, 2, 3, 4].map((index) => lane.run({ jobId: `j${index}`, fn })));
    assert.equal(peak, 2);
  });

  test('取消：排队项直接移除；在飞项立刻拒绝但槽位等上游结束才释放、结果丢弃', async () => {
    const lane = createLane({ concurrency: 1 });
    const gate = deferred();
    let laterStarted = false;
    const inFlight = lane.run({ jobId: 'a', fn: () => gate.promise.then(() => 'a-result') });
    const queued = lane.run({ jobId: 'b', fn: () => 'b' });
    const later = lane.run({ jobId: 'c', fn: () => { laterStarted = true; return 'c'; } });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(lane.cancelJob('b'), { removed: 1, discardedInFlight: 0 });
    await assert.rejects(queued, { code: 'TASK_CANCELLED' });
    assert.equal(lane.positionOf('c'), 1);

    assert.deepEqual(lane.cancelJob('a'), { removed: 0, discardedInFlight: 1 });
    await assert.rejects(inFlight, { code: 'TASK_CANCELLED' });
    assert.equal(lane.positionOf('a'), null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(laterStarted, false, '上游还在算时不能把下一个塞进去');
    assert.equal(lane.snapshot().inFlight, 'a');

    gate.resolve();
    assert.equal(await later, 'c');
    assert.deepEqual(lane.cancelJob('a'), { removed: 0, discardedInFlight: 0 });
  });

  test('fn 抛错只拒绝自己，通道继续', async () => {
    const lane = createLane();
    await assert.rejects(lane.run({ jobId: 'x', fn: () => { throw new Error('boom'); } }), /boom/);
    assert.equal(await lane.run({ jobId: 'y', fn: () => 'ok' }), 'ok');
  });
});

describe('引擎并发配置', () => {
  test('默认 Breeze 1，非法值回落默认', () => {
    assert.deepEqual(normalizeEngineConcurrency(), { breeze: 1, 'volcengine-api-key': 2, custom: 2, demo: 4 });
    assert.equal(normalizeEngineConcurrency({ breeze: 0, custom: 3, demo: 99 }).breeze, 1);
    assert.equal(normalizeEngineConcurrency({ custom: 3 }).custom, 3);
    assert.equal(normalizeEngineConcurrency({ demo: 99 }).demo, 4);
  });
  test('laneFor 按配置同步并发', () => {
    assert.equal(laneFor('custom', {}).concurrency, 2);
    assert.equal(laneFor('custom', { engineConcurrency: { custom: 3 } }).concurrency, 3);
    assert.equal(laneFor('custom', {}).concurrency, 2);
  });
});

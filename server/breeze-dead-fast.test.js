// 0042（e2e4 Bug 1）：Breeze 刚成功过、随后挂掉——一次连接失败就清掉“刚成功过 / 忙”，
// 健康检查与预检不再报 busy / 可达，任务 1 次 /tts 后立即停（不再白等 2 s + 5 s 退避、打 3 次 /tts）。
// 只用 127.0.0.1 上的模拟 Breeze。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { startMockBreeze } from './test-support/mock-breeze.js';

const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-dead-fast-test-'));
process.env.HOME = scratch;
process.env.SHENGCHANG_RUNTIME_DIR = path.join(scratch, 'runtime');
const { breezeHealth, BreezeError, listBreezeVoices } = await import('./breeze.js');
const { createLane, laneFor, breezeLane } = await import('./breeze-lane.js');
const { createProject } = await import('./database.js');
const { ensureRuntime } = await import('./media-store.js');
const { runGenerationRequests, BREEZE_RETRY_DELAYS_MS } = await import('./task-manager.js');

let projectId;
let counter = 0;
const line = () => ({ lineId: `d${++counter}`, sceneId: 's1', speakerId: 'nobody', text: `挂掉测试第${counter}句。`, voiceId: 'preset-x' });
const ttsCalls = (mock, from) => mock.state.requests.slice(from).filter((item) => item.path === '/tts').length;

before(async () => {
  await ensureRuntime();
  projectId = createProject({ name: '挂掉', state: { scenes: [], characters: [] } }).id;
});
after(() => rmSync(scratch, { recursive: true, force: true }));

describe('通道：连接类失败清掉“刚成功过”', () => {
  test('成功 → lastSuccessAt；BREEZE_UNREACHABLE / BREEZE_TIMEOUT → 清空并记 lastConnectionFailureAt；其他错误不清', async () => {
    for (const code of ['BREEZE_UNREACHABLE', 'BREEZE_TIMEOUT']) {
      const lane = createLane();
      await lane.run({ jobId: 'j', fn: async () => 'ok' });
      assert.ok(Number.isFinite(lane.activity().lastSuccessAt));
      await assert.rejects(lane.run({ jobId: 'j', fn: async () => { throw new BreezeError('x', { code: 'BREEZE_UPSTREAM' }); } }));
      assert.ok(Number.isFinite(lane.activity().lastSuccessAt), 'Breeze 500 说明服务活着，不清');
      await assert.rejects(lane.run({ jobId: 'j', fn: async () => { throw new BreezeError('x', { code }); } }));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(lane.activity().lastSuccessAt, null, code);
      assert.ok(Number.isFinite(lane.activity().lastConnectionFailureAt));
    }
  });

  test('清空后 breezeHealth 不再报 busy，真的探测 → unreachable', async () => {
    const lane = createLane();
    await lane.run({ jobId: 'j', fn: async () => 'ok' });
    assert.equal((await breezeHealth({ breezeEndpoint: 'http://127.0.0.1:1' }, { lane })).via, 'busy');
    await assert.rejects(lane.run({ jobId: 'j', fn: async () => { throw new BreezeError('x', { code: 'BREEZE_UNREACHABLE' }); } }));
    const health = await breezeHealth({ breezeEndpoint: 'http://127.0.0.1:1' }, { lane });
    assert.equal(health.via, 'probe');
    assert.equal(health.status, 'unreachable');
    assert.equal(health.reachable, false);
  });

  test('通道外的 Breeze 请求（GET /voices）连不上也清全局 Breeze 通道', async () => {
    await breezeLane.run({ jobId: 'j', fn: async () => 'ok' });
    assert.ok(Number.isFinite(breezeLane.activity().lastSuccessAt));
    await assert.rejects(listBreezeVoices({ breezeEndpoint: 'http://127.0.0.1:1' }), { code: 'BREEZE_UNREACHABLE' });
    assert.equal(breezeLane.activity().lastSuccessAt, null);
  });
});

// 复现 Tavi 的步骤：成功一句 → 杀掉 Breeze → 新任务（缓存未命中）。默认退避 [2 s, 5 s]、默认预检。
for (const [label, kill, cause] of [
  ['进程被杀（连接被拒 ECONNREFUSED）', (mock) => mock.close(), 'BREEZE_UNREACHABLE'],
  ['进程卡死断连（连接被重置）', async (mock) => { mock.state.down = true; }, 'BREEZE_UNREACHABLE'],
]) {
  describe(`端到端：刚成功过的 Breeze ${label}`, () => {
    let mock;
    before(async () => { mock = await startMockBreeze(); });
    after(async () => { await mock.close().catch(() => {}); });

    test('任务 1 次 /tts 后立即 unreachable；之后健康检查 via probe、不可达', async () => {
      assert.deepEqual(BREEZE_RETRY_DELAYS_MS, [2_000, 5_000], '用默认退避，证明没有白等');
      const config = { provider: 'breeze', breezeEndpoint: mock.endpoint };
      const first = await runGenerationRequests(config, [line()], { projectId, sceneId: 's1' });
      assert.equal(first.status, 'done', JSON.stringify(first));
      const lane = laneFor('breeze', config);
      assert.equal((await breezeHealth(config, { lane })).via, 'busy', '前提：刚成功过 → busy');

      await kill(mock);
      const before = mock.state.requests.length;
      const started = Date.now();
      const requests = [line(), line()];
      const outcome = await runGenerationRequests(config, requests, { projectId, sceneId: 's1' });
      const elapsed = Date.now() - started;
      assert.equal(outcome.status, 'unreachable');
      assert.equal(outcome.code, 'BREEZE_UNREACHABLE');
      assert.equal(outcome.causeCode, cause);
      assert.equal(outcome.skippedCount, 2);
      assert.ok(elapsed < 1_500, `没有退避重试（用时 ${elapsed} ms）`);
      if (mock.state.down) assert.equal(ttsCalls(mock, before), 1, '只打了 1 次 /tts');

      assert.equal(lane.activity().lastSuccessAt, null);
      const health = await breezeHealth(config, { lane });
      assert.equal(health.via, 'probe');
      assert.equal(health.reachable, false);
      assert.equal(health.status, 'unreachable');
    });
  });
}

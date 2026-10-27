import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGenerationRequest } from '../../shared/generation-requests.mjs';
import { generationMissingRoles, generationVoiceMap, missingRolesToast } from './voice-readiness.js';

const breeze = { provider: 'breeze' };
const doubao = { provider: 'volcengine-api-key' };
const characters = [{ id: 'r1', name: '林舟' }, { id: 'r2', name: '老陈' }];
const state = {
  voiceMap: { r1: 'zh_doubao_old', r2: 'zh_doubao_b' },
  voiceReferences: { r1: { breezeVoiceId: 'bz_lin', status: 'locked' }, r2: { status: 'draft' } },
};
const line = (id, speakerId) => ({ id, type: 'dialogue', speakerId, text: '好' });

test('Breeze：生成用锁定参考音的 breezeVoiceId，不用 voiceMap 里残留的豆包 id（B3）', () => {
  assert.deepEqual(generationVoiceMap(breeze, state), { r1: 'bz_lin' });
  const requests = [line('l1', 'r1'), line('l2', 'r2')].map((item) => buildGenerationRequest(item, generationVoiceMap(breeze, state)));
  assert.equal(requests[0].voiceId, 'bz_lin');
  assert.equal(requests[1].voiceId, '');
  assert.deepEqual(generationMissingRoles({ requests, characters }), [{ roleId: 'r2', name: '老陈' }]);
  assert.equal(missingRolesToast([{ roleId: 'r2', name: '老陈' }], true), '老陈还没定声音，先在角色音色页锁定参考音色');
  assert.equal(missingRolesToast([{ roleId: 'r1', name: 'a' }, { roleId: 'r2', name: 'b' }], true), '还有 2 个角色没定声音');
});

test('Breeze：服务端 voice-readiness 读得到就以它为准，只看这批台词的角色', () => {
  const requests = [line('l1', 'r1')].map((item) => buildGenerationRequest(item, {}));
  // 本地 state 还没刷新（另一个标签页刚锁了 r1）：服务端说 ready → 放行
  assert.deepEqual(generationMissingRoles({ requests, readiness: { ready: true, missingRoles: [] }, characters }), []);
  // 服务端说 r2 没定，但这批只有 r1 → 放行
  assert.deepEqual(generationMissingRoles({ requests, readiness: { ready: false, missingRoles: [{ roleId: 'r2', name: '老陈' }] }, characters }), []);
  const both = [line('l1', 'r1'), line('l2', 'r2')].map((item) => buildGenerationRequest(item, { r1: 'bz', r2: 'bz2' }));
  assert.deepEqual(generationMissingRoles({ requests: both, readiness: { ready: false, missingRoles: [{ roleId: 'r2', name: '老陈（服务端）' }] }, characters }), [{ roleId: 'r2', name: '老陈（服务端）' }]);
  // 读不到（null / 旧服务端没有 missingRoles）→ 按本地算
  assert.deepEqual(generationMissingRoles({ requests, readiness: { ok: true }, characters }), [{ roleId: 'r1', name: '林舟' }]);
});

test('豆包：照旧用 voiceMap', () => {
  assert.deepEqual(generationVoiceMap(doubao, state), state.voiceMap);
  const requests = [line('l1', 'r1'), line('l2', 'r3')].map((item) => buildGenerationRequest(item, generationVoiceMap(doubao, state)));
  assert.equal(requests[0].voiceId, 'zh_doubao_old');
  assert.deepEqual(generationMissingRoles({ requests, characters }), [{ roleId: 'r3', name: 'r3' }]);
  assert.equal(missingRolesToast([{ roleId: 'r3', name: 'r3' }], false), '有 1 个角色尚未绑定 voice_id');
  assert.equal(missingRolesToast([], false), '');
});

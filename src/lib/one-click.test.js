import test from 'node:test';
import assert from 'node:assert/strict';
import { exportOnlyDialogue, goFixText, missingDetail, missingText, missingVoiceRoles } from './one-click.js';
import { breezePreset, DOUBAO_PRESET } from './engine.js';

const breeze = breezePreset();
const scenes = [{ lines: [{ type: 'dialogue', speakerId: 'a' }, { type: 'dialogue', speakerId: 'b' }, { type: 'sfx' }] }];
const characters = [{ id: 'a', name: '孙悟空', voice: { referenceId: 'vr_1' } }, { id: 'b', name: '唐僧' }, { id: 'c', name: '路人' }];

test('没定声音：先用 estimate.missingVoiceRoles，其次 voice-readiness，最后本地算', () => {
  assert.deepEqual(missingVoiceRoles({ estimate: { missingVoiceRoles: [{ roleId: 'b', reason: '自动设计没成功：Breeze 返回错误' }] }, config: breeze, characters }), [{ roleId: 'b', name: '唐僧', reason: '自动设计没成功：Breeze 返回错误' }]);
  assert.deepEqual(missingVoiceRoles({ estimate: {}, readiness: { ready: false, missingRoles: [{ roleId: 'b' }] }, config: breeze, characters }), [{ roleId: 'b', name: '唐僧', reason: '' }]);
  assert.deepEqual(missingVoiceRoles({ readiness: { ready: true, missingRoles: [{ roleId: 'b' }] }, config: breeze, characters }), []);
  assert.deepEqual(missingVoiceRoles({ config: breeze, characters, scenes }), [{ roleId: 'b', name: '唐僧', reason: '' }]);
  // 豆包：服务端 estimate 也给 missingVoiceRoles（自动配不上音色的角色），照样拦；没有 estimate 就不本地算。
  assert.deepEqual(missingVoiceRoles({ estimate: { missingVoiceRoles: [{ roleId: 'b', name: '唐僧' }], voiceReady: false }, config: DOUBAO_PRESET, characters, scenes }).map((role) => role.roleId), ['b']);
  assert.deepEqual(missingVoiceRoles({ estimate: { missingVoiceRoles: [], voiceReady: true }, config: breeze, characters, scenes }), []);
  assert.deepEqual(missingVoiceRoles({ config: DOUBAO_PRESET, characters, scenes }), []);
  // 本地兜底以服务端的 state.voiceReferences 为准（角色上残留的 voice 不算）。
  assert.deepEqual(missingVoiceRoles({ config: breeze, characters, scenes, voiceReferences: { b: { referenceId: 'r' } } }).map((role) => role.roleId), ['a']);
});

test('没定声音的文案：名单带原因，跳到第一个', () => {
  const roles = [{ roleId: 'b', name: '老妪', reason: '自动设计没成功：Breeze 返回错误' }, { roleId: 'c', name: '旁白', reason: '' }];
  assert.equal(missingText(roles), '还有 2 个角色没定声音');
  assert.equal(missingDetail(roles), '老妪（自动设计没成功：Breeze 返回错误）、旁白。一键配音不会生成这些角色的台词，先给它们定好声音。');
  assert.equal(goFixText(roles), '去给老妪定声音');
  assert.doesNotMatch(missingDetail(roles), /字符/);
});

test('导出只有对白：有音效行但都没素材才提示', () => {
  assert.equal(exportOnlyDialogue(scenes), true);
  assert.equal(exportOnlyDialogue([{ lines: [{ type: 'sfx', assetUrl: '/x' }] }]), false);
  assert.equal(exportOnlyDialogue([{ lines: [{ type: 'dialogue' }] }]), false);
});

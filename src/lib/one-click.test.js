import test from 'node:test';
import assert from 'node:assert/strict';
import { exportOnlyDialogue, goFixText, missingDetail, missingText, missingVoiceRoles, oneClickNothingPending } from './one-click.js';
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

test('oneClickNothingPending：0 句要配且有场景才直接导出整集', () => {
  assert.equal(oneClickNothingPending({ sceneCount: 8, requestCount: 0 }), true);
  assert.equal(oneClickNothingPending({ sceneCount: 8, requestCount: 3 }), false);
  assert.equal(oneClickNothingPending({ sceneCount: 0, requestCount: 0, needsLlm: true }), false);
  assert.equal(oneClickNothingPending({ sceneCount: 8, requestCount: 0, needsLlm: true }), false);
  assert.equal(oneClickNothingPending({ sceneCount: 8, requestCount: null }), false);
  assert.equal(oneClickNothingPending(null), false);
});

test('N1：待配句数只用 export-precheck 的 pendingLineCount，K = pending − 没音频', async () => {
  const { oneClickPlan, pendingFromPrecheck, mixFreshText, pendingLinesText } = await import('./one-click.js');
  const estimate = { sceneCount: 2, requestCount: 3 };
  const precheck = { pendingLineCount: 3, missingAudioLineCount: 0, staleLineCount: 2, missingFileLineCount: 1 };
  assert.deepEqual(pendingFromPrecheck(precheck), { pending: 3, redub: 3 });
  const plan = oneClickPlan(estimate, precheck);
  assert.equal(plan.linesText, '3 句待生成（其中 3 句要重配）');
  assert.equal(plan.confirmLabel, '先配完这 3 句');
  assert.equal(plan.nothingPending, false);
  // 只有没音频的：不写括号。
  assert.equal(oneClickPlan(estimate, { pendingLineCount: 4, missingAudioLineCount: 4 }).linesText, '4 句待生成');
  assert.equal(pendingLinesText({ pending: 5, redub: 2 }), '5 句待生成（其中 2 句要重配）');
  // 0：台词都已配好，主按钮导出整集（即使老 estimate 还说有句子要配，也以 precheck 为准）。
  const zero = oneClickPlan({ sceneCount: 2, requestCount: 1 }, { pendingLineCount: 0, missingAudioLineCount: 0 });
  assert.equal(zero.nothingPending, true);
  assert.equal(zero.confirmLabel, '导出整集');
  // precheck 读不到：退回 estimate.requestCount。
  assert.equal(oneClickPlan({ sceneCount: 2, requestCount: 0 }, null).confirmLabel, '导出整集');
  assert.equal(oneClickPlan({ sceneCount: 2, requestCount: 2 }, null).confirmLabel, '先配完这 2 句');
  // 还要先拆解：不看 precheck。
  assert.equal(oneClickPlan({ sceneCount: 0, requestCount: 0, needsLlm: true }, { pendingLineCount: 0 }).confirmLabel, '开始');
  assert.equal(mixFreshText(0), '整集混音是最新的');
  assert.equal(mixFreshText(3), '有 3 句改过，整集混音不是最新的');
});

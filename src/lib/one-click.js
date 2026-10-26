import { isBreeze } from './engine.js';

// 「角色有没有定声音」检查，单独放这里：以后加「按描述自动设计」（handoff v4 的「自动设计」状态）只改这一处。
// 服务端来源（Back-end 已确认）：
//   GET /api/projects/{id}/voice-readiness → { ready, missingRoles: [{ roleId, reason? }] }
//   POST /api/projects/{id}/one-click-estimate 里的 missingVoiceRoles[]（同样的形状）
// 都没有时按项目自己算（有台词、但没有 voice.referenceId 的角色）。Breeze 下绝不自动套用预设音色。
const normalize = (roles, characters) => roles.map((role) => {
  const character = characters.find((item) => item.id === role.roleId);
  const reason = typeof role.reason === 'string' && role.reason.trim() ? role.reason.trim() : character?.voiceAutoError || '';
  return { roleId: role.roleId, name: role.name || character?.name || role.roleId, reason };
});

export function localMissingRoles({ characters = [], scenes = [], voiceReferences = null }) {
  const speaking = new Set(scenes.flatMap((scene) => (scene.lines || []).filter((line) => line.type === 'dialogue').map((line) => line.speakerId)));
  const locked = (character) => voiceReferences ? Boolean(voiceReferences[character.id]?.referenceId) : Boolean(character.voice?.referenceId);
  return characters.filter((character) => speaking.has(character.id) && !locked(character)).map((character) => ({ roleId: character.id, reason: character.voiceAutoError || '' }));
}

// 服务端的 estimate.missingVoiceRoles / 409 VOICE_NOT_READY 两个引擎都有（豆包是自动配不上音色的角色），优先用。
export function missingVoiceRoles({ estimate, readiness, config, characters = [], scenes = [], voiceReferences = null }) {
  if (Array.isArray(estimate?.missingVoiceRoles)) return normalize(estimate.voiceReady === true ? [] : estimate.missingVoiceRoles, characters);
  if (!isBreeze(config)) return [];
  if (readiness && Array.isArray(readiness.missingRoles)) return normalize(readiness.ready === true ? [] : readiness.missingRoles, characters);
  return normalize(localMissingRoles({ characters, scenes, voiceReferences }), characters);
}

export const missingText = (roles) => `还有 ${roles.length} 个角色没定声音`;
const roleWithReason = (role) => role.reason ? `${role.name}（${role.reason}）` : role.name;
export const missingNames = (roles) => roles.map(roleWithReason).join('、');
export const missingDetail = (roles) => `${missingNames(roles)}。一键配音不会生成这些角色的台词，先给它们定好声音。`;
export const goFixText = (roles) => roles.length ? `去给${roles[0].name}定声音` : '';

// 导出提示：剧本里有音效 / 环境声 / 音乐，但都没有素材 → 导出只有对白（不拦）。
export function exportOnlyDialogue(scenes = []) {
  const sounds = scenes.flatMap((scene) => (scene.lines || []).filter((line) => line.type !== 'dialogue'));
  return sounds.length > 0 && sounds.every((line) => !line.assetUrl);
}
export const EXPORT_ONLY_DIALOGUE = '导出只有对白';
export const EXPORT_ONLY_DIALOGUE_DETAIL = '音效和背景音乐都还没有素材，导出的 mp3 里只有台词。';

// 一键成片预估里 0 句要配（全部已有音频、也不用先拆解）：确认框主按钮改成「导出整集」，直接走整集导出。
export function oneClickNothingPending(estimate) {
  if (!estimate || estimate.needsLlm) return false;
  return Number(estimate.requestCount) === 0 && estimate.requestCount !== null && estimate.requestCount !== '' && Number(estimate.sceneCount) > 0;
}

// N1 + N2：「还剩几句没配好」只有一个来源 —— GET export-precheck 的 pendingLineCount
// （过期 + 没音频 + 文件丢了，去重，只算有字的台词）。一键成片确认框、审听页顶部、导出前检查都用它。
// 前端不自己数：N = pendingLineCount；K（要重配 = 已有音频但过期 / 文件丢了）= pendingLineCount − missingAudioLineCount，
// 都是服务端给的数。0051 起 one-click-estimate.requestCount 和 N 相等，一键成片本身就会重配这些句子。
// precheck 读不到时退回 estimate.requestCount（老行为），K 不显示。
export function pendingFromPrecheck(precheck) {
  if (!precheck || typeof precheck !== 'object' || precheck.pendingLineCount === null || precheck.pendingLineCount === undefined) return null;
  const pending = Math.max(0, Number(precheck.pendingLineCount) || 0);
  const redub = Math.min(pending, Math.max(0, pending - (Number(precheck.missingAudioLineCount) || 0)));
  return { pending, redub };
}

export const pendingLinesText = ({ pending, redub }) => redub > 0 ? `${pending} 句待生成（其中 ${redub} 句要重配）` : `${pending} 句待生成`;
export const finishPendingLabel = (pending) => `先配完这 ${pending} 句`;
export const mixFreshText = (pending) => pending > 0 ? `有 ${pending} 句改过，整集混音不是最新的` : '整集混音是最新的';

// 确认框：pending 为 0 → 「台词都已配好」，主按钮「导出整集」（直接整集导出）；
// 否则主按钮「先配完这 N 句」= 开始一键成片（服务端按同样的判断重配 / 补配，再体检、导出）。
export function oneClickPlan(estimate, precheck) {
  const fromPrecheck = estimate?.needsLlm ? null : pendingFromPrecheck(precheck);
  if (!fromPrecheck) {
    const nothingPending = oneClickNothingPending(estimate);
    const pending = Math.max(0, Number(estimate?.requestCount) || 0);
    return { pending, redub: 0, nothingPending, linesText: pendingLinesText({ pending, redub: 0 }), confirmLabel: nothingPending ? '导出整集' : estimate?.needsLlm ? '开始' : finishPendingLabel(pending), source: 'estimate' };
  }
  const nothingPending = fromPrecheck.pending === 0 && Number(estimate?.sceneCount) > 0;
  return { ...fromPrecheck, nothingPending, linesText: pendingLinesText(fromPrecheck), confirmLabel: nothingPending ? '导出整集' : finishPendingLabel(fromPrecheck.pending), source: 'precheck' };
}

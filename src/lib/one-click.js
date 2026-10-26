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

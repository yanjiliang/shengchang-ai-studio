import { isBreeze } from './engine.js';

// 手动生成（重新生成本句 / 场景生成 / 补全缺失 / 重配过期 / 导出前「先重配这 N 句」 / 方向对比）
// 共用的「这个角色能不能生成」判断（fe-0011，e2e6 B3）。跟服务端 server/voice-references.js 一致：
//   Breeze：只认 voiceReferences[roleId].breezeVoiceId（锁定的参考音）；voiceMap 在 Breeze 下是空的或残留豆包 id，不能用。
//   其他引擎（豆包 / 演示 / 自定义）：voiceMap[roleId]。
// 服务端 GET /api/projects/{id}/voice-readiness 读得到就以它为准（另一个标签页刚锁的也认）；读不到就按本地算。
export function generationVoiceMap(config, state) {
  if (!isBreeze(config)) return { ...(state?.voiceMap || {}) };
  return Object.fromEntries(Object.entries(state?.voiceReferences || {})
    .filter(([, reference]) => reference?.breezeVoiceId)
    .map(([roleId, reference]) => [roleId, reference.breezeVoiceId]));
}

// requests：buildGenerationRequest(line, generationVoiceMap(...)) 的结果（带 speakerId / voiceId）。
// readiness：GET voice-readiness 的结果 { ready, missingRoles: [{ roleId, name? }] }，没有就传 null。
// 返回这批请求里还没定声音的角色 [{ roleId, name }]（按出现顺序，不重复）；空数组 = 可以生成。
export function generationMissingRoles({ requests = [], readiness = null, characters = [] }) {
  const speakers = [...new Set(requests.map((request) => request.speakerId).filter(Boolean))];
  const serverMissing = readiness && Array.isArray(readiness.missingRoles)
    ? new Map((readiness.ready === true ? [] : readiness.missingRoles).map((role) => [role.roleId, role]))
    : null;
  const missing = serverMissing
    ? speakers.filter((roleId) => serverMissing.has(roleId))
    : [...new Set(requests.filter((request) => !request.voiceId).map((request) => request.speakerId))];
  return missing.map((roleId) => ({ roleId, name: serverMissing?.get(roleId)?.name || characters.find((item) => item.id === roleId)?.name || roleId }));
}

export const missingRolesToast = (roles, breeze) => {
  if (!roles.length) return '';
  if (!breeze) return `有 ${roles.length} 个角色尚未绑定 voice_id`;
  return roles.length === 1 ? `${roles[0].name}还没定声音，先在角色音色页锁定参考音色` : `还有 ${roles.length} 个角色没定声音`;
};

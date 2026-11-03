// 逐章导入用的合并：把一章的拆解结果追加到现有项目上。
// - 角色按 id 或姓名复用旧 id（文本模型每章可能给出不同的 id），场景里的 speakerId 跟着改；
// - 没在本章出现的旧角色保留，否则前面章节的台词会失去角色/音色绑定；
// - 旁白始终是 narrator；
// - 用户改过的角色字段由 mergeAnalyzedCharacters 保留。
import { mergeAnalyzedCharacters } from './character-meta.js';

export function mergeAppendedAnalysis(state, analyzed) {
  const previousCharacters = state?.characters || [];
  const byId = new Map(previousCharacters.map((character) => [character.id, character]));
  const byName = new Map(previousCharacters.map((character) => [character.name, character]));
  const characters = [...previousCharacters];
  const idMap = new Map();
  const nameMap = new Map();

  for (const character of analyzed.characters || []) {
    const existing = byId.get(character.id) || byName.get(character.name);
    if (existing) {
      idMap.set(character.id, existing.id);
      nameMap.set(character.name, existing.id);
      continue;
    }
    const fresh = { ...character };
    characters.push(fresh);
    byId.set(fresh.id, fresh);
    byName.set(fresh.name, fresh);
    idMap.set(character.id, fresh.id);
    nameMap.set(character.name, fresh.id);
  }

  // 已有角色的字段更新走同一套“用户手改优先”的规则。
  for (const character of mergeAnalyzedCharacters(previousCharacters, analyzed.characters || [])) {
    const canonicalId = idMap.get(character.id) || character.id;
    const index = characters.findIndex((item) => item.id === canonicalId);
    if (index >= 0) characters[index] = { ...characters[index], ...character, id: canonicalId };
    else characters.push({ ...character, id: canonicalId });
  }

  const scenes = (analyzed.scenes || []).map((scene) => ({
    ...scene,
    lines: (scene.lines || []).map((line) => {
      if (line.type !== 'dialogue') return line;
      if (line.speakerId === 'narrator' || line.speaker === '旁白') return { ...line, speakerId: 'narrator' };
      const mapped = idMap.get(line.speakerId) || nameMap.get(line.speaker);
      return mapped ? { ...line, speakerId: mapped } : line;
    }),
  }));

  return { characters, scenes };
}

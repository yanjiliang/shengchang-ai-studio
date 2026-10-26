import { readFileSync } from 'node:fs';

// 可导戏音色白名单。数据在 directable-voices.json，复测后只改数据文件。
const catalog = JSON.parse(readFileSync(new URL('./directable-voices.json', import.meta.url), 'utf8'));

// true = 实测可导戏；false = 实测不可导戏；null = 未验证。
// 不在白名单里的音色照样能用，只是会被标记出来。
export function voiceDirectability(voiceId) {
  const entry = catalog.voices?.[voiceId];
  return typeof entry?.directable === 'boolean' ? entry.directable : null;
}

export function directableVoiceIds() {
  return Object.entries(catalog.voices || {}).filter(([, entry]) => entry.directable === true).map(([id]) => id);
}

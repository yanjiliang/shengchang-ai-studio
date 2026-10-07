// Rule-based sound-event ↔ asset matching. Zero dependencies, fully offline:
// the sound event's text description is matched against each asset's tags,
// name, and mood through a synonym table tuned to how novels describe sounds.
// v2 can plug an embedding service in behind the same interface.

// primary tag -> novel-style variants that imply it. Keys double as the
// canonical vocabulary the builtin manifest tags are curated against.
const SYNONYM_GROUPS = [
  ['雨', '下雨', '雨天', '雨点', '雨水', '细雨', '大雨', '淋雨', '雨幕'],
  ['暴雨', '倾盆', '瓢泼', '骤雨'],
  ['海', '大海', '海边', '海上', '浪', '波涛', '潮', '海面', '涛声'],
  ['城市', '都市', '街头', '马路', '车流', '市声'],
  ['森林', '树林', '林间', '山林'],
  ['鸟', '鸟鸣', '鸟叫', '雀'],
  ['篝火', '火堆', '柴火', '营火', '炉火', '火光'],
  ['风', '刮风', '起风', '风声', '狂风', '夜风', '山风', '呼啸'],
  ['室内', '房间', '屋内', '屋里', '房中'],
  ['敲门', '叩门', '拍门', '叩响'],
  ['门', '开门', '推门', '关门', '门轴', '吱呀'],
  ['脚步', '脚步声', '走近', '踏入', '迈步', '踏'],
  ['转场', '切换', '掠过', '划过', '风声'],
  ['雷', '打雷', '雷声', '雷鸣', '闷雷', '雷雨'],
  ['玻璃', '杯', '酒杯', '杯盏', '碰杯'],
  ['人群', '人声', '众人', '嘈杂', '喧哗', '集市', '街市', '低语'],
  ['心跳', '心脏', '胸口', '心口', '心悸'],
  ['悬疑', '诡异', '阴森', '不祥', '谜'],
  ['温暖', '温馨', '柔和', '暖'],
  ['悲伤', '哀', '悲', '伤心', '泪', '哀伤', '离别'],
  ['紧张', '惊', '惧', '危机', '危险', '紧绷', '恐惧'],
  ['夜', '夜晚', '深夜', '夜里', '午夜', '夜色'],
  ['晨', '清晨', '黎明', '拂晓', '天亮'],
  ['码头', '港口', '渡轮', '船', '汽笛'],
];

const CATEGORY_TO_TYPES = {
  环境: ['ambient'], 动作: ['sfx'], 关键音效: ['sfx'], 音乐: ['music'], 人物主题: ['music'],
};

function assetTypes(asset) {
  if (asset.type && ['ambient', 'sfx', 'music'].includes(asset.type)) return [asset.type];
  return CATEGORY_TO_TYPES[asset.category] || [];
}

// Which canonical primaries a text mentions, weighted by how often: novels
// repeat the sounds that matter, so frequency is signal (substring match).
function primariesIn(text) {
  const haystack = String(text || '');
  const hits = new Map();
  for (const [primary, ...variants] of SYNONYM_GROUPS) {
    let count = 0;
    for (const term of [primary, ...variants]) {
      let cursor = haystack.indexOf(term);
      while (cursor !== -1) { count += 1; cursor = haystack.indexOf(term, cursor + term.length); }
    }
    if (count > 0) hits.set(primary, Math.min(count, 3));
  }
  return hits;
}

function scoreAsset(asset, eventPrimaries, usageCount) {
  const tags = new Set(asset.tags || []);
  const name = String(asset.name || '');
  const mood = String(asset.mood || '');
  let score = 0;
  const matched = [];
  for (const [primary, count] of eventPrimaries) {
    if (tags.has(primary)) { score += 4 * count; matched.push(primary); }
    else if (mood.includes(primary)) { score += 3 * count; matched.push(primary); }
    else if (name.includes(primary)) { score += 2 * count; matched.push(primary); }
  }
  // Sounds already used elsewhere in the project get a small nudge: a
  // consistent sound world reuses its palette.
  score += Math.min(2, usageCount || 0);
  return { score, matched };
}

// Pure: rank candidates for one sound event. candidates are builtin entries
// plus the project's own assets (uploads and generated ones alike).
export function recommendForEvent({ line, candidates, usageCounts = {}, limit = 5 } = {}) {
  if (!line || !['ambient', 'sfx', 'music'].includes(line.type)) return [];
  const eventPrimaries = primariesIn(line.text);
  const moodPrimaries = primariesIn(line.mood || '');
  const ranked = [];
  for (const asset of candidates || []) {
    if (!assetTypes(asset).includes(line.type)) continue;
    const usage = scoreAsset(asset, eventPrimaries, usageCounts[asset.id] || 0);
    const mood = scoreAsset(asset, moodPrimaries, 0);
    const score = usage.score + mood.score;
    if (score <= 0) continue;
    const matched = [...new Set([...usage.matched, ...mood.matched])];
    ranked.push({ ...asset, score, matched, reason: matched.length ? `匹配：${matched.join('、')}` : '类型匹配' });
  }
  ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh'));
  return ranked.slice(0, limit);
}

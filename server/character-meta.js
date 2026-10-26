// 角色性别 / 年龄段：和前端角色卡下拉框、拆解提示词共用同一套中文枚举。
// 字段直接存在 character.gender / character.age；来源记在 genderSource /
// ageSource（'user' | 'analyzer'），由服务端维护，浏览器传来的来源一律忽略。
// 没有来源但有值的（示例项目、手工 JSON）视同用户设定。
export const GENDERS = ['男', '女', '未知'];
export const AGES = ['儿童', '少年', '青年', '中年', '老年', '未知'];

const GENDER_ALIASES = { 男: '男', 女: '女', 男性: '男', 女性: '女', male: '男', female: '女', m: '男', f: '女' };
const AGE_ALIASES = { 儿童: '儿童', 少年: '少年', 青年: '青年', 中年: '中年', 老年: '老年', child: '儿童', teen: '少年', young: '青年', middle: '中年', elder: '老年', old: '老年' };

export const normalizeGender = (value) => GENDER_ALIASES[String(value ?? '').trim().toLowerCase()] || '未知';
export const normalizeAge = (value) => AGE_ALIASES[String(value ?? '').trim().toLowerCase()] || '未知';

const FIELDS = [['gender', 'genderSource', normalizeGender], ['age', 'ageSource', normalizeAge]];
const known = (value) => value !== undefined && value !== '未知';
const isAnalyzerValue = (character, field, sourceField) => known(character?.[field]) && character?.[sourceField] === 'analyzer';

// 保存时（含浏览器整项目 PUT）：枚举外的值落成“未知”；只处理出现了的字段，
// 不给老项目凭空加字段。trusted=false 时来源由服务端推断：值和库里一样 →
// 沿用库里的来源；值变了 → 'user'。
export function sanitizeCharacters(characters, currentCharacters = [], { trusted = false } = {}) {
  if (!Array.isArray(characters)) return characters;
  const currentById = new Map((currentCharacters || []).map((item) => [item?.id, item]));
  return characters.map((character) => {
    if (!character || typeof character !== 'object') return character;
    const next = { ...character };
    const current = currentById.get(character.id);
    for (const [field, sourceField, normalize] of FIELDS) {
      if (!trusted) delete next[sourceField];
      if (next[field] === undefined) continue;
      next[field] = normalize(next[field]);
      if (trusted) { if (next[sourceField] !== 'analyzer' && next[sourceField] !== 'user') delete next[sourceField]; continue; }
      if (current && normalize(current[field]) === next[field]) { if (current[sourceField]) next[sourceField] = current[sourceField]; }
      else next[sourceField] = 'user';
    }
    return next;
  });
}

// 重新拆解：角色表以拆解结果为准（和以前一样），但同一角色（按 id、再按
// 名字匹配）上用户设定过的性别/年龄保留；拆解给出的值只填空白或覆盖上次
// 拆解的值，并标成 'analyzer'。
export function mergeAnalyzedCharacters(previous, analyzed) {
  const byId = new Map((previous || []).map((item) => [item?.id, item]));
  const byName = new Map((previous || []).map((item) => [item?.name, item]));
  return (analyzed || []).map((character) => {
    const old = byId.get(character.id) || byName.get(character.name);
    const next = { ...character };
    for (const [field, sourceField, normalize] of FIELDS) {
      delete next[sourceField];
      const fresh = normalize(character[field]);
      const kept = old ? normalize(old[field]) : '未知';
      if (old && known(kept) && !isAnalyzerValue(old, field, sourceField)) {
        next[field] = kept;
        if (old[sourceField]) next[sourceField] = old[sourceField];
      } else if (known(fresh)) {
        next[field] = fresh;
        next[sourceField] = 'analyzer';
      } else if (character[field] !== undefined || (old && old[field] !== undefined)) {
        next[field] = '未知';
      }
    }
    return next;
  });
}

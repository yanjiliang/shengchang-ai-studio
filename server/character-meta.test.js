import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mergeAnalyzedCharacters, normalizeAge, normalizeGender, sanitizeCharacters } from './character-meta.js';

describe('角色性别/年龄枚举', () => {
  test('中英文别名归一，枚举外落成“未知”', () => {
    assert.equal(normalizeGender('男'), '男');
    assert.equal(normalizeGender('Female'), '女');
    assert.equal(normalizeGender('雌雄同体'), '未知');
    assert.equal(normalizeAge('少年'), '少年');
    assert.equal(normalizeAge('teen'), '少年');
    assert.equal(normalizeAge(42), '未知');
  });

  test('浏览器保存：枚举校验，改动的值记为用户来源，伪造来源被忽略', () => {
    const current = [{ id: 'a', name: '甲', gender: '男', genderSource: 'analyzer' }];
    const saved = sanitizeCharacters([
      { id: 'a', name: '甲', gender: '男', age: '老人家' },
      { id: 'b', name: '乙', gender: 'female', genderSource: 'analyzer' },
      { id: 'c', name: '丙' },
    ], current);
    assert.deepEqual(saved[0], { id: 'a', name: '甲', gender: '男', genderSource: 'analyzer', age: '未知' }, '值没变（都是未知）就不改来源');
    assert.deepEqual(saved[1], { id: 'b', name: '乙', gender: '女', genderSource: 'user' });
    assert.deepEqual(saved[2], { id: 'c', name: '丙' }, '没出现的字段不凭空添加');
  });
});

describe('重新拆解合并角色', () => {
  test('用户值保留（按 id），拆解值只填空白或覆盖上次拆解', () => {
    const previous = [
      { id: 'tangseng', name: '唐僧', gender: '男', genderSource: 'user', age: '青年', ageSource: 'analyzer' },
      { id: 'x', name: '路人' },
    ];
    const merged = mergeAnalyzedCharacters(previous, [
      { id: 'tangseng', name: '唐僧', description: '新描述', gender: '女', age: '老年' },
      { id: 'x', name: '路人', gender: '男', age: '未知' },
    ]);
    assert.equal(merged[0].description, '新描述', '其余字段以拆解为准');
    assert.equal(merged[0].gender, '男');
    assert.equal(merged[0].genderSource, 'user');
    assert.equal(merged[0].age, '老年', '上次拆解的值可以被新拆解覆盖');
    assert.equal(merged[0].ageSource, 'analyzer');
    assert.deepEqual([merged[1].gender, merged[1].genderSource, merged[1].age], ['男', 'analyzer', '未知']);
  });

  test('id 变了按名字精确匹配；没有来源的手工值（示例项目）视同用户值', () => {
    const merged = mergeAnalyzedCharacters([{ id: 'laoweng', name: '老翁', gender: '男', age: '老年' }], [{ id: '老翁', name: '老翁', gender: '未知', age: '未知' }]);
    assert.deepEqual([merged[0].id, merged[0].gender, merged[0].age], ['老翁', '男', '老年']);
  });

  test('规则拆解（无性别字段）不会抹掉用户值', () => {
    const merged = mergeAnalyzedCharacters([{ id: '唐僧', name: '唐僧', gender: '男', genderSource: 'user' }], [{ id: '唐僧', name: '唐僧', role: '角色' }]);
    assert.equal(merged[0].gender, '男');
  });
});

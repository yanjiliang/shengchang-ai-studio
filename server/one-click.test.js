import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

// Same pattern as the other server tests: scratch runtime before imports.
const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-oneclick-test-'));
process.env.SHENGCHANG_RUNTIME_DIR = scratch;
const { createProject, createPersistentTask, getPersistentTask, getProject, updateProject } = await import('./database.js');
const { buildSampleState } = await import('./sample-project.js');
const { characterGender, directionDemand, flagUndirectableVoices, mapCharactersToPresets, planCasting, presetVoicesFor, runOneClickPipeline } = await import('./one-click.js');
const { voiceGeneration } = await import('./model-adapters.js');
const { buildGenerationRequests } = await import('../shared/generation-requests.mjs');

after(() => rmSync(scratch, { recursive: true, force: true }));

describe('mapCharactersToPresets', () => {
  test('只为未映射的角色分配预设音色', () => {
    const assignments = mapCharactersToPresets([
      { id: 'narrator', name: '旁白', role: '叙事者' },
      { id: 'linxia', name: '林夏', role: '角色' },
      { id: 'laoren', name: '老人', role: '角色' },
    ], { linxia: 'user_picked_voice' }, 'demo');
    assert.equal(assignments.narrator, 'demo_narrator_warm', '旁白使用旁白预设');
    assert.equal(assignments.linxia, undefined, '用户已选择的音色绝不被覆盖');
    assert.equal(assignments.laoren, 'demo_female_1', '其余角色轮换使用角色预设');
  });

  test('角色数量超过预设时循环复用', () => {
    const characters = Array.from({ length: 8 }, (_unused, index) => ({ id: `c${index}`, name: `角色${index}`, role: '角色' }));
    const assignments = mapCharactersToPresets(characters, {}, 'demo');
    assert.equal(Object.keys(assignments).length, 8);
    assert.notEqual(assignments.c0, assignments.c1, '不同角色默认不同预设');
    assert.equal(assignments.c6, assignments.c0, '第 7 个角色循环回第一个预设');
  });
});

describe('豆包预设按 resourceId 分组', () => {
  test('seed-tts-2.0 预设全部是 2.0 音色', () => {
    const presets = presetVoicesFor('volcengine-api-key', 'seed-tts-2.0');
    for (const { voiceId } of [presets.narrator, ...presets.cast]) assert.equal(voiceGeneration(voiceId), '2.0', voiceId);
  });

  test('预设音色的性别与 voice id 前缀一致', () => {
    const presets = presetVoicesFor('volcengine-api-key', 'seed-tts-2.0');
    for (const voice of [presets.narrator, ...presets.cast]) assert.equal(voice.gender, voice.voiceId.startsWith('zh_female_') ? 'female' : 'male', voice.voiceId);
  });

  test('seed-tts-2.0 自动映射使用 2.0 音色（无性别信息时保持旧行为）', () => {
    const assignments = mapCharactersToPresets([{ id: 'narrator', name: '旁白' }, { id: 'wukong', name: '悟空' }], {}, 'volcengine-api-key', 'seed-tts-2.0');
    assert.equal(assignments.narrator, 'zh_female_cancan_uranus_bigtts');
    assert.equal(assignments.wukong, 'zh_female_vv_uranus_bigtts', '实测可导戏的音色优先分给第一个角色');
  });

  test('标记未确认可导戏的 2.0 音色，demo/克隆音色不标记', () => {
    const flagged = flagUndirectableVoices({ a: 'zh_female_vv_uranus_bigtts', b: 'zh_male_sunwukong_uranus_bigtts', c: 'zh_male_qingcang_uranus_bigtts', d: 'demo_male_1', e: 'S_abc' });
    assert.deepEqual(flagged.map((item) => [item.characterId, item.directable]), [['b', false], ['c', null]]);
  });

  test('seed-icl-2.0（克隆音色）没有通用预设，不自动映射', () => {
    assert.deepEqual(mapCharactersToPresets([{ id: 'c1', name: '甲' }], {}, 'volcengine-api-key', 'seed-icl-2.0'), {});
  });
});

describe('按性别/年龄与戏份选角', () => {
  const tts2 = ['volcengine-api-key', 'seed-tts-2.0'];
  const voiceGender = (voiceId) => (voiceId.startsWith('zh_female_') ? 'female' : 'male');
  const scenes = [{ id: 's1', lines: [
    { id: 'a1', type: 'dialogue', speakerId: 'tangseng', text: '悟空', emotion: '平静' },
    { id: 'a2', type: 'dialogue', speakerId: 'tangseng', text: '去吧', emotion: '平静' },
    { id: 'a3', type: 'dialogue', speakerId: 'tangseng', text: '去吧', emotion: '平静' },
    { id: 'b1', type: 'dialogue', speakerId: 'baigujing', text: '长老', emotion: '妩媚' },
    { id: 'b2', type: 'dialogue', speakerId: 'baigujing', text: '救命', emotion: '惊恐', subtext: '装可怜' },
    { id: 'c1', type: 'dialogue', speakerId: 'cunfu', text: '我的儿', emotion: '悲伤' },
  ] }];

  test('拆解结果的性别字段中英文都认，认不出为 null', () => {
    assert.equal(characterGender({ gender: '男' }), 'male');
    assert.equal(characterGender({ gender: 'Female' }), 'female');
    assert.equal(characterGender({ gender: '未知' }), null);
    assert.equal(characterGender({ description: '一个温和的男人' }), null, '不从描述里猜');
  });

  test('复现：唐僧（男）是第一个角色也不会拿到女声 vv', () => {
    const { assignments } = planCasting([
      { id: 'narrator', name: '旁白', role: '叙事者' },
      { id: 'tangseng', name: '唐僧', gender: '男' },
      { id: 'baigujing', name: '白骨精', gender: '女' },
    ], {}, ...tts2, { scenes });
    assert.equal(voiceGender(assignments.tangseng), 'male');
    assert.notEqual(assignments.tangseng, 'zh_female_vv_uranus_bigtts');
    assert.equal(assignments.baigujing, 'zh_female_vv_uranus_bigtts');
  });

  test('性别已知时绝不跨性别分配，即使角色多于同性别音色', () => {
    const characters = Array.from({ length: 7 }, (_unused, index) => ({ id: `m${index}`, name: `男${index}`, gender: 'male' }));
    const { assignments } = planCasting(characters, {}, ...tts2, { scenes: [] });
    assert.equal(Object.keys(assignments).length, 7);
    for (const voiceId of Object.values(assignments)) assert.equal(voiceGender(voiceId), 'male', voiceId);
  });

  test('同性别内，可导戏音色给带表演指示台词最多的角色', () => {
    const { assignments } = planCasting([
      { id: 'cunfu', name: '村妇', gender: 'female' },
      { id: 'baigujing', name: '白骨精', gender: 'female' },
    ], {}, ...tts2, { scenes });
    assert.equal(assignments.baigujing, 'zh_female_vv_uranus_bigtts', '白骨精有 2 句带指示，村妇 1 句');
    assert.notEqual(assignments.cunfu, 'zh_female_vv_uranus_bigtts');
  });

  test('表演指示持平时按台词总数', () => {
    const demand = directionDemand(scenes);
    assert.deepEqual(demand.tangseng, { directed: 0, lines: 3 });
    assert.deepEqual(demand.baigujing, { directed: 2, lines: 2 });
    const tie = [{ id: 's', lines: [
      { id: '1', type: 'dialogue', speakerId: 'x', text: '.', emotion: '愤怒' },
      { id: '2', type: 'dialogue', speakerId: 'y', text: '.', emotion: '愤怒' },
      { id: '3', type: 'dialogue', speakerId: 'y', text: '.' },
    ] }];
    const { assignments } = planCasting([{ id: 'x', gender: '女' }, { id: 'y', gender: '女' }], {}, ...tts2, { scenes: tie });
    assert.equal(assignments.y, 'zh_female_vv_uranus_bigtts');
  });

  test('年龄已知时排除年龄明确不符的音色', () => {
    const { assignments } = planCasting([
      { id: 'laofuren', name: '老夫人', gender: '女', age: '老年' },
      { id: 'xiaojie', name: '小姐', gender: '女', age: '青年' },
    ], {}, ...tts2, { scenes: [] });
    assert.equal(assignments.laofuren, 'zh_female_popo_uranus_bigtts');
    assert.notEqual(assignments.xiaojie, 'zh_female_popo_uranus_bigtts');
  });

  test('年龄明确不符的音色不分给该角色（儿童不配大叔音）', () => {
    const { assignments, notes } = planCasting([{ id: 'wa', name: '娃娃', gender: '男', age: '儿童' }], {}, ...tts2, { scenes: [] });
    assert.equal(voiceGender(assignments.wa), 'male');
    assert.notEqual(assignments.wa, 'zh_male_qingcang_uranus_bigtts');
    assert.deepEqual(notes, [], '还有年龄未知的同性别音色可用，不需要退回');
  });

  test('少年优先少年音色，退到青年/未知，绝不用中年/老年', () => {
    const teens = Array.from({ length: 6 }, (_unused, index) => ({ id: `t${index}`, name: `少年${index}`, gender: '男', age: '少年' }));
    const { assignments } = planCasting(teens, {}, ...tts2, { scenes: [] });
    const presets = presetVoicesFor(...tts2);
    const ageOf = Object.fromEntries(presets.cast.map((voice) => [voice.voiceId, voice.age]));
    assert.equal(assignments.t0, 'zh_male_shaonianzixin_uranus_bigtts');
    for (const voiceId of Object.values(assignments)) assert.ok(!['middle', 'elder', 'child'].includes(ageOf[voiceId]), voiceId);
    assert.equal(ageOf[assignments.t1], 'young', '少年音色用完后先退到青年');
  });

  test('西游记示例：男角色各拿不同音色，八戒拿中年音色', () => {
    const state = buildSampleState();
    const { assignments, notes } = planCasting(state.characters, {}, ...tts2, { scenes: state.scenes });
    const male = ['tangseng', 'sunwukong', 'zhubajie', 'laoweng'];
    for (const id of male) assert.equal(voiceGender(assignments[id]), 'male', id);
    for (const id of ['shaonv', 'laoyu']) assert.equal(voiceGender(assignments[id]), 'female', id);
    assert.equal(new Set(male.map((id) => assignments[id])).size, 4, JSON.stringify(assignments));
    assert.equal(assignments.zhubajie, 'zh_male_qingcang_uranus_bigtts');
    assert.equal(assignments.laoyu, 'zh_female_popo_uranus_bigtts');
    assert.deepEqual(notes, []);
  });

  test('用户已绑定的音色不改，但性别冲突进注意事项', () => {
    const { assignments, notes } = planCasting([
      { id: 'tangseng', name: '唐僧', gender: '男' },
      { id: 'laoyu', name: '老妪', gender: '女' },
      { id: 'clone', name: '克隆', gender: '男' },
    ], { tangseng: 'zh_female_vv_uranus_bigtts', laoyu: 'zh_female_popo_uranus_bigtts', clone: 'S_abc123' }, ...tts2, { scenes: [] });
    assert.deepEqual(assignments, {});
    assert.equal(notes.length, 1);
    assert.match(notes[0], /1 个角色已绑定的音色与角色性别不符.*唐僧（男）→ zh_female_vv_uranus_bigtts/);
  });

  test('完全没有性别信息：保持旧的轮换行为，并在注意事项说明', () => {
    const { assignments, notes } = planCasting([{ id: 'narrator', name: '旁白' }, { id: 'tangseng', name: '唐僧' }], {}, ...tts2, { scenes });
    assert.equal(assignments.tangseng, 'zh_female_vv_uranus_bigtts');
    assert.match(notes.join(), /缺少性别\/年龄信息.*唐僧/);
  });

  test('部分角色缺性别：已知的先分，缺的标记出来', () => {
    const { assignments, notes } = planCasting([{ id: 'x', name: '路人' }, { id: 'baigujing', name: '白骨精', gender: '女' }], {}, ...tts2, { scenes });
    assert.equal(assignments.baigujing, 'zh_female_vv_uranus_bigtts');
    assert.match(notes.join(), /缺少性别信息.*路人/);
  });

  test('用户已绑定的角色不参与；demo 不产生选角注意事项', () => {
    const { assignments, notes } = planCasting([{ id: 'a', name: '甲', gender: '男' }, { id: 'b', name: '乙' }], { a: 'mine' }, 'demo', undefined, { scenes: [] });
    assert.equal(assignments.a, undefined);
    assert.ok(assignments.b);
    assert.deepEqual(notes, []);
  });
});

describe('buildGenerationRequests（共享请求构建）', () => {
  const state = {
    scenes: [
      { id: 's1', lines: [
        { id: 'l1', type: 'dialogue', speakerId: 'narrator', text: '有音频且不过期', audioUrl: '/media/a.wav', intensity: 60, pace: 100 },
        { id: 'l2', type: 'dialogue', speakerId: 'linxia', text: '没有音频' },
        { id: 'l3', type: 'dialogue', speakerId: 'linxia', text: '过期音频', audioUrl: '/media/b.wav', audioStale: true },
        { id: 'l4', type: 'sfx', label: '音效', text: '非对白不生成', audioUrl: '' },
      ] },
      { id: 's2', lines: [{ id: 'l5', type: 'dialogue', speakerId: 'narrator', text: '第二场' }] },
    ],
    voiceMap: { narrator: 'v_narr', linxia: 'v_lin' },
  };

  test('默认收集缺失与过期对白并携带场景', () => {
    const requests = buildGenerationRequests(state);
    assert.deepEqual(requests.map((item) => item.lineId), ['l2', 'l3', 'l5']);
    assert.ok(requests.every((item) => item.sceneId));
  });

  test('表演参数换算与手动工作台一致', () => {
    const [request] = buildGenerationRequests(state, { needGeneration: () => true, sceneIds: ['s1'] }).filter((item) => item.lineId === 'l1');
    assert.equal(request.emotionScale, 0.6);
    assert.equal(request.speed, 1);
    assert.equal(request.voiceId, 'v_narr');
  });
});

describe('runOneClickPipeline 阶段断点', () => {
  const sceneState = {
    scenes: [{ id: 's1', title: '场景', status: 'pending', lines: [{ id: 'l1', type: 'dialogue', speaker: '林夏', speakerId: 'linxia', text: '你好。' }] }],
    assets: [], characters: [{ id: 'linxia', name: '林夏', role: '角色', description: '' }], voiceMap: { linxia: 'demo_voice' },
  };

  test('已完成阶段被跳过，从断点续跑（design A2 关键用例）', async () => {
    const project = createProject({ name: '断点续跑', state: sceneState });
    const task = createPersistentTask({ kind: 'one-click', projectId: project.id, payload: { completedStages: ['拆解', '音色', '生成'] } });
    const calls = { analyze: 0, generate: 0, export: 0, inspect: 0 };
    await runOneClickPipeline(task, { provider: 'demo' }, {
      analyze: async () => { calls.analyze += 1; return { name: 'n', genre: '', characters: [], scenes: [] }; },
      runGeneration: async () => { calls.generate += 1; return { status: 'done', results: [], failures: [] }; },
      inspectMedia: async (p) => { calls.inspect += 1; return { scenes: [{ sceneId: 's1', invalidFileCount: 0, durationMs: 1000, files: [] }], projectDurationMs: 1000 }; },
      exportTimeline: async () => { calls.export += 1; return { url: '/media/exports/demo.mp3', name: 'demo.mp3', sceneCount: 1, durationMs: 1000 }; },
    });
    assert.equal(calls.analyze, 0, '拆解已完成，不应重跑');
    assert.equal(calls.generate, 0, '生成已完成，不应重新付费');
    assert.ok(calls.inspect >= 1, '体检仍应执行');
    assert.equal(calls.export, 1);
    const finished = getPersistentTask(task.id);
    assert.equal(finished.status, 'completed');
    assert.equal(finished.result.sceneCount, 1);
    assert.ok(finished.result.attention.length, '角色有台词但未生成音频应进入注意事项');
  });

  test('选角注意事项写入 payload 并进入最终“需注意”', async () => {
    const project = createProject({ name: '选角提示', state: { characters: [{ id: 'narrator', name: '旁白' }, { id: 'tangseng', name: '唐僧' }], scenes: [], voiceMap: {} } });
    const task = createPersistentTask({ kind: 'one-click', projectId: project.id, payload: { completedStages: ['拆解', '生成'] } });
    await runOneClickPipeline(task, { provider: 'volcengine-api-key', resourceId: 'seed-tts-2.0' }, {
      inspectMedia: async () => ({ scenes: [], projectDurationMs: 0 }),
      exportTimeline: async () => ({ url: '/media/exports/x.mp3', name: 'x.mp3', sceneCount: 0, durationMs: 0 }),
    });
    const finished = getPersistentTask(task.id);
    assert.match(finished.payload.castingNotes.join(), /唐僧/);
    assert.ok(finished.result.attention.some((item) => /缺少性别\/年龄信息/.test(item)), JSON.stringify(finished.result.attention));
  });

  test('一键成片重新拆解时保留用户设的性别/年龄（id 变了按名字匹配）', async () => {
    const project = createProject({ name: '重拆', sourceText: '“走吧。”唐僧说。', state: { characters: [{ id: 'old-ts', name: '唐僧', gender: '男', genderSource: 'user', age: '青年' }], scenes: [], voiceMap: {} } });
    const task = createPersistentTask({ kind: 'one-click', projectId: project.id, payload: { completedStages: ['音色', '生成'] } });
    await runOneClickPipeline(task, { provider: 'demo' }, {
      analyze: async () => ({ name: '重拆', genre: '', breakdown: 'heuristic', characters: [{ id: 'narrator', name: '旁白', role: '叙事者', gender: '未知', age: '未知' }, { id: '唐僧', name: '唐僧', role: '角色', gender: '女', age: '未知' }], scenes: [{ id: 's1', lines: [{ id: 'l1', type: 'dialogue', speaker: '唐僧', speakerId: '唐僧', text: '走吧。' }] }] }),
      inspectMedia: async () => ({ scenes: [], projectDurationMs: 0 }),
      exportTimeline: async () => ({ url: '/media/exports/x.mp3', name: 'x.mp3', sceneCount: 1, durationMs: 0 }),
    });
    const tangseng = getProject(project.id).state.characters.find((item) => item.name === '唐僧');
    assert.deepEqual([tangseng.id, tangseng.gender, tangseng.genderSource, tangseng.age], ['唐僧', '男', 'user', '青年']);
  });

  test('生成阶段失败时保留断点，成功句写入项目', async () => {
    const project = createProject({ name: '失败重试', state: sceneState });
    const task = createPersistentTask({ kind: 'one-click', projectId: project.id, payload: { completedStages: [] } });
    const fakeAudio = { lineId: 'l1', sceneId: 's1', url: '/media/fake.wav', mime: 'audio/wav', text: '你好。', synthesizedText: '你好。', contentHash: 'h', createdAt: 1 };
    await assert.rejects(
      runOneClickPipeline(task, { provider: 'demo' }, {
        runGeneration: async () => ({ status: 'done', results: [fakeAudio], failures: [{ lineId: 'l2', text: 'x', error: '合成失败' }] }),
        inspectMedia: async () => ({}), exportTimeline: async () => { throw new Error('不应到达导出'); },
      }),
      /生成阶段有 1 句失败/,
    );
    const after = getPersistentTask(task.id);
    assert.equal(after.payload.completedStages.includes('生成'), false, '生成未完成不写断点');
    // 失败前已成功的句子必须写进项目，重试才会跳过它们。
    assert.equal(getProject(project.id).state.scenes[0].lines[0].audioUrl, '/media/fake.wav');
  });

  test('音色阶段只为未映射角色写入 voiceMap', async () => {
    const project = createProject({ name: '自动音色', state: sceneState });
    updateProject(project.id, { state: { ...sceneState, voiceMap: {} } });
    const task = createPersistentTask({ kind: 'one-click', projectId: project.id, payload: { completedStages: [] } });
    await runOneClickPipeline(task, { provider: 'demo' }, {
      runGeneration: async () => ({ status: 'done', results: [], failures: [] }),
      inspectMedia: async () => ({ scenes: [] }),
      exportTimeline: async () => ({ url: '/media/exports/e.mp3', name: 'e.mp3', sceneCount: 1, durationMs: 1 }),
    });
    const voiceMap = getProject(project.id).state.voiceMap;
    assert.equal(voiceMap.linxia, 'demo_female_1');
    assert.ok(getPersistentTask(task.id).payload.completedStages.includes('音色'));
  });
  test('计费诚实：缓存命中与缺 usage 的句数进入结果，缺 usage 进入“需注意”', async () => {
    const project = createProject({ name: '计费诚实', state: sceneState });
    const task = createPersistentTask({ kind: 'one-click', projectId: project.id, payload: { completedStages: ['拆解', '音色'] } });
    const base = { sceneId: 's1', url: '/media/fake.wav', mime: 'audio/wav', text: '你好。', synthesizedText: '你好。', contentHash: 'h', createdAt: 1 };
    await runOneClickPipeline(task, { provider: 'volcengine-api-key', resourceId: 'seed-tts-2.0' }, {
      runGeneration: async () => ({ status: 'done', failures: [], results: [
        { ...base, lineId: 'l1', cached: false, usageExpected: true, usage: { billedCharacters: 3 } },
        { ...base, lineId: 'l2', cached: false, usageExpected: true, usage: null },
        { ...base, lineId: 'l3', cached: true },
      ] }),
      inspectMedia: async () => ({ scenes: [], projectDurationMs: 0 }),
      exportTimeline: async () => ({ url: '/media/exports/b.mp3', name: 'b.mp3', sceneCount: 1, durationMs: 1 }),
    });
    const finished = getPersistentTask(task.id);
    assert.deepEqual([finished.result.billedCharacters, finished.result.freshCount, finished.result.cacheHits, finished.result.missingUsageCount], [3, 2, 1, 1]);
    assert.ok(finished.result.attention.some((item) => /1 句新生成的语音没有返回计费字数.*已知部分/.test(item)), JSON.stringify(finished.result.attention));
    assert.match(finished.message, /1 句复用缓存/);
  });
});

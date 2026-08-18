import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

// Same pattern as the other server tests: scratch runtime before imports.
const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-oneclick-test-'));
process.env.SHENGCHANG_RUNTIME_DIR = scratch;
const { createProject, createPersistentTask, getPersistentTask, getProject, updateProject } = await import('./database.js');
const { mapCharactersToPresets, runOneClickPipeline } = await import('./one-click.js');
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
});

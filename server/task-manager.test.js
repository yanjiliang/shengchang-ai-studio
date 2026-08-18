import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

// Same pattern as database.test.js: point the runtime at a scratch directory
// before importing anything that resolves media-store paths.
const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-task-test-'));
process.env.SHENGCHANG_RUNTIME_DIR = scratch;
const { createProject, getProject } = await import('./database.js');
const { applyResultsToProject, recoverCachedAudioFromDisk, runGenerationRequests } = await import('./task-manager.js');

after(() => rmSync(scratch, { recursive: true, force: true }));

const stateWith = (lines) => ({ scenes: [{ id: 'scene-1', title: '测试场景', lines }], assets: [], characters: [] });
const staleLine = (id, text) => ({ id, type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text, audioUrl: '/media/old.wav', audioMime: 'audio/wav', audioStale: true });
const resultFor = (lineId, text, url = '/media/new.wav') => ({ lineId, sceneId: 'scene-1', url, mime: 'audio/wav', text, synthesizedText: text, contentHash: 'hash-1', createdAt: 123 });

describe('生成结果写回项目', () => {
  test('重新生成后清除过期标记并记录合成文本', () => {
    const project = createProject({ name: '写回测试', state: stateWith([staleLine('l1', '当前台词')]) });

    applyResultsToProject(project.id, 'scene-1', [resultFor('l1', '当前台词')]);

    const line = getProject(project.id).state.scenes[0].lines[0];
    assert.equal(line.audioUrl, '/media/new.wav');
    assert.equal(line.audioStale, false, '音频与台词一致时不应保留过期标记');
    assert.equal(line.synthesizedText, '当前台词');
  });

  test('生成期间被改过的台词保持过期标记', () => {
    const project = createProject({ name: '竞争测试', state: stateWith([staleLine('l1', '生成期间又改了的台词')]) });

    applyResultsToProject(project.id, 'scene-1', [resultFor('l1', '任务提交时的台词')]);

    const line = getProject(project.id).state.scenes[0].lines[0];
    assert.equal(line.audioUrl, '/media/new.wav', '新音频仍应写入');
    assert.equal(line.audioStale, true, '音频对应的是旧文本，必须保持过期');
  });

  test('未被任务覆盖的台词保持原样', () => {
    const project = createProject({ name: '保留测试', state: stateWith([staleLine('l1', '第一句'), staleLine('l2', '第二句')]) });

    applyResultsToProject(project.id, 'scene-1', [resultFor('l1', '第一句')]);

    const lines = getProject(project.id).state.scenes[0].lines;
    assert.equal(lines[1].audioUrl, '/media/old.wav');
    assert.equal(lines[1].audioStale, true);
  });
});

describe('runGenerationRequests 逐句容错', () => {
  const okAudio = { mime: 'audio/wav', buffer: Buffer.from('RIFF-payload') };
  const requestFor = (lineId, text) => ({ lineId, sceneId: 'scene-1', voiceId: 'v', text });

  test('单句失败不中断整批，失败句记录原因', async () => {
    const project = createProject({ name: '容错测试', state: stateWith([]) });
    const failingSynth = async (_config, request) => {
      if (request.text.includes('坏句')) throw new Error('合成失败');
      return okAudio;
    };
    const outcome = await runGenerationRequests({ provider: 'demo' }, [
      requestFor('a', '第一句'), requestFor('b', '包含坏句的台词'), requestFor('c', '第三句'),
    ], { projectId: project.id, synthesize: failingSynth });
    assert.equal(outcome.status, 'done');
    assert.deepEqual(outcome.results.map((item) => item.lineId), ['a', 'c'], '失败句之后的句子必须继续生成');
    assert.equal(outcome.failures.length, 1);
    assert.equal(outcome.failures[0].lineId, 'b');
    assert.match(outcome.failures[0].error, /合成失败/);
  });

  test('AbortError 报告为超时而不是原始名称', async () => {
    const project = createProject({ name: '超时测试', state: stateWith([]) });
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const outcome = await runGenerationRequests({ provider: 'demo' }, [requestFor('a', '会超时的一句')], {
      projectId: project.id,
      synthesize: async () => { throw abortError; },
    });
    assert.equal(outcome.failures[0].error, '模型请求超时');
  });

  test('取消后立即停止并保留已完成的结果', async () => {
    const project = createProject({ name: '取消测试', state: stateWith([]) });
    const outcome = await runGenerationRequests({ provider: 'demo' }, [requestFor('a', '第一句'), requestFor('b', '第二句')], {
      projectId: project.id,
      shouldCancel: () => true,
      synthesize: async () => okAudio,
    });
    assert.equal(outcome.status, 'cancelled');
    assert.equal(outcome.results.length, 0, '取消后不应继续合成');
  });

  test('发音词典在合成前生效', async () => {
    const project = createProject({ name: '词典测试', state: { scenes: [], assets: [], characters: [], pronunciationDictionary: [{ id: 'd1', term: '重庆', replacement: '重 庆' }] } });
    const seen = [];
    await runGenerationRequests({ provider: 'demo' }, [requestFor('a', '去了重庆。')], {
      projectId: project.id,
      synthesize: async (_config, request) => { seen.push(request.text); return okAudio; },
    });
    assert.deepEqual(seen, ['去了重 庆。']);
  });
});

describe('音频缓存磁盘恢复', () => {
  test('缓存行被清理后仍能从磁盘找回文件', async () => {
    mkdirSync(path.join(scratch, 'media'), { recursive: true });
    writeFileSync(path.join(scratch, 'media', 'deadbeef.wav'), Buffer.from('RIFF'));

    const recovered = await recoverCachedAudioFromDisk('deadbeef');
    assert.deepEqual(recovered, { url: '/media/deadbeef.wav', mime: 'audio/wav' });
  });

  test('磁盘上不存在时返回 null', async () => {
    assert.equal(await recoverCachedAudioFromDisk('not-on-disk'), null);
  });
});

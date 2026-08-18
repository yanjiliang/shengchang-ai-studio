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
const { applyResultsToProject, recoverCachedAudioFromDisk } = await import('./task-manager.js');

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

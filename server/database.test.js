import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

// database.js resolves its file from .runtime next to the module, so point the
// whole module at a scratch directory before importing it.
const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-test-'));
process.env.SHENGCHANG_RUNTIME_DIR = scratch;
const { archiveProject, createProject, getProject, updateProject } = await import('./database.js');

const sceneState = (lines) => ({ scenes: [{ id: 'scene-1', title: '测试场景', lines }], assets: [], characters: [] });
const dialogue = (id, text) => ({ id, type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text });

describe('项目状态写入', () => {
  const created = [];
  const project = (lines) => {
    const item = createProject({ name: '并发测试', state: sceneState(lines) });
    created.push(item.id);
    return item;
  };
  after(() => {
    for (const id of created) archiveProject(id);
    rmSync(scratch, { recursive: true, force: true });
  });

  test('浏览器的过期快照不会抹掉任务写入的音频', () => {
    const item = project([dialogue('l1', '第一句'), dialogue('l2', '第二句')]);
    const staleSnapshot = getProject(item.id).state;

    // 生成任务在浏览器读取之后写入音频
    updateProject(item.id, { trustedAudio: true, state: sceneState([{ ...dialogue('l1', '第一句'), audioUrl: '/media/new.wav', audioMime: 'audio/wav' }, dialogue('l2', '第二句')]) });
    // 浏览器带着旧快照回写（只改了第二句台词）
    updateProject(item.id, { state: { ...staleSnapshot, scenes: staleSnapshot.scenes.map((scene) => ({ ...scene, lines: scene.lines.map((line) => line.id === 'l2' ? { ...line, text: '改过的第二句' } : line) })) } });

    const lines = getProject(item.id).state.scenes[0].lines;
    assert.equal(lines[0].audioUrl, '/media/new.wav', '任务写入的音频被过期快照覆盖了');
    assert.equal(lines[0].audioMime, 'audio/wav');
    assert.equal(lines[1].text, '改过的第二句', '用户的文本编辑应当保留');
  });

  test('改台词把音频标记为过期而不是删除', () => {
    const item = project([dialogue('l1', '原始台词')]);
    updateProject(item.id, { trustedAudio: true, state: sceneState([{ ...dialogue('l1', '原始台词'), audioUrl: '/media/a.wav' }]) });
    updateProject(item.id, { state: sceneState([dialogue('l1', '换过的台词')]) });

    const line = getProject(item.id).state.scenes[0].lines[0];
    assert.equal(line.audioUrl, '/media/a.wav', '音频不应被静默删除');
    assert.equal(line.audioStale, true, '文本变化后音频应标记为过期');
  });

  test('改台词再改回原文：过期标记清掉（对照音频原文 audioText，不是上一次保存的文本）', () => {
    const item = project([dialogue('l1', '原始台词')]);
    updateProject(item.id, { trustedAudio: true, state: sceneState([{ ...dialogue('l1', '原始台词'), audioUrl: '/media/a.wav', audioText: '原始台词' }]) });
    updateProject(item.id, { state: sceneState([dialogue('l1', '换过的台词')]) });
    assert.equal(getProject(item.id).state.scenes[0].lines[0].audioStale, true);
    updateProject(item.id, { state: sceneState([dialogue('l1', '又换了一次')]) });
    assert.equal(getProject(item.id).state.scenes[0].lines[0].audioStale, true);
    updateProject(item.id, { state: sceneState([dialogue('l1', '原始台词')]) });
    const line = getProject(item.id).state.scenes[0].lines[0];
    assert.equal(line.audioStale, false);
    assert.equal(line.audioText, '原始台词', 'audioText 是服务端字段，浏览器回存不能改它');
  });

  test('旧数据没有 audioText：未过期的以当前文本为原文，改回也能清掉', () => {
    const item = project([dialogue('l1', '原始台词')]);
    updateProject(item.id, { trustedAudio: true, state: sceneState([{ ...dialogue('l1', '原始台词'), audioUrl: '/media/a.wav' }]) });
    updateProject(item.id, { state: sceneState([dialogue('l1', '原始台词')]) });
    assert.equal(getProject(item.id).state.scenes[0].lines[0].audioStale, false);
  });

  test('台词未变时音频不被标记过期', () => {
    const item = project([dialogue('l1', '原始台词')]);
    updateProject(item.id, { trustedAudio: true, state: sceneState([{ ...dialogue('l1', '原始台词'), audioUrl: '/media/a.wav' }]) });
    updateProject(item.id, { state: sceneState([{ ...dialogue('l1', '原始台词'), emotion: '愤怒' }]) });

    const line = getProject(item.id).state.scenes[0].lines[0];
    assert.equal(line.audioStale, false);
    assert.equal(line.emotion, '愤怒', '其他字段的编辑应当生效');
  });

  test('删除台词后音频合并不会把它复活', () => {
    const item = project([dialogue('l1', '第一句'), dialogue('l2', '第二句')]);
    updateProject(item.id, { trustedAudio: true, state: sceneState([{ ...dialogue('l1', '第一句'), audioUrl: '/media/a.wav' }, { ...dialogue('l2', '第二句'), audioUrl: '/media/b.wav' }]) });
    updateProject(item.id, { state: sceneState([dialogue('l1', '第一句')]) });

    const lines = getProject(item.id).state.scenes[0].lines;
    assert.equal(lines.length, 1, '被删除的台词不应复活');
    assert.equal(lines[0].audioUrl, '/media/a.wav');
  });
});

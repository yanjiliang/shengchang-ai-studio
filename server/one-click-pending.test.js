// N1（e2e6）：一键成片的预估 / 执行要配的句子 = 导出预检的 pendingLineCount（没音频 + 过期 + 文件丢了）。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const scratch = mkdtempSync(path.join(tmpdir(), 'shengchang-pending-'));
process.env.SHENGCHANG_RUNTIME_DIR = scratch;
const { createProject, createPersistentTask, getProject } = await import('./database.js');
const { runtimePaths } = await import('./media-store.js');
const { expectedAudioHash, exportPrecheck, needsGenerationPredicate } = await import('./voice-references.js');
const { runOneClickPipeline } = await import('./one-click.js');
const { buildGenerationRequests } = await import('../shared/generation-requests.mjs');
after(() => rmSync(scratch, { recursive: true, force: true }));

const config = { provider: 'demo' };
function buildState() {
  mkdirSync(runtimePaths.MEDIA_DIR, { recursive: true });
  for (const name of ['l2.wav', 'l3.wav']) writeFileSync(path.join(runtimePaths.MEDIA_DIR, name), 'x');
  const base = { id: '', type: 'dialogue', speaker: '林夏', speakerId: 'linxia', emotion: '平静' };
  const state = { assets: [], characters: [{ id: 'linxia', name: '林夏', role: '角色' }], voiceMap: { linxia: 'demo_voice' }, scenes: [{ id: 's1', title: '场景', lines: [
    { ...base, id: 'l1', text: '没配过。' },
    { ...base, id: 'l2', text: '改了情绪。', audioUrl: '/media/l2.wav', audioText: '改了情绪。' },
    { ...base, id: 'l3', text: '没变。', audioUrl: '/media/l3.wav', audioText: '没变。' },
    { ...base, id: 'l4', text: '文件丢了。', audioUrl: '/media/l4-gone.wav', audioText: '文件丢了。' },
  ] }] };
  // 按“当时”的参数记下 audioHash（与真实生成后一致），再改 l2 的情绪让它过期。
  for (const line of state.scenes[0].lines) if (line.audioUrl) Object.assign(line, { audioHash: expectedAudioHash(config, state, line), audioEngine: 'demo' });
  state.scenes[0].lines[1].emotion = '愤怒';
  return state;
}

test('predicate matches export precheck: missing, stale (params) and missing-file lines; fresh line excluded', () => {
  const state = buildState();
  const ids = buildGenerationRequests(state, { needGeneration: needsGenerationPredicate(config, state) }).map((item) => item.lineId);
  assert.deepEqual(ids, ['l1', 'l2', 'l4']);
  const old = buildGenerationRequests(state).map((item) => item.lineId);
  assert.deepEqual(old, ['l1'], '旧判断漏掉了 l2（过期）和 l4（文件丢了）——这就是 N1');
  const project = createProject({ name: 'pending', state });
  assert.equal(exportPrecheck(config, project).pendingLineCount, ids.length);
});

test('one-click actually regenerates the stale and missing-file lines', async () => {
  const project = createProject({ name: 'pending-run', state: buildState() });
  const task = createPersistentTask({ kind: 'one-click', projectId: project.id, payload: { completedStages: ['拆解', '音色'] } });
  const requested = [];
  await runOneClickPipeline(task, config, {
    runGeneration: async (_config, requests) => { requested.push(...requests.map((item) => item.lineId)); return { status: 'done', results: [], failures: [] }; },
    inspectMedia: async () => ({ scenes: [{ sceneId: 's1', invalidFileCount: 0, durationMs: 1000, files: [] }], projectDurationMs: 1000 }),
    exportTimeline: async () => ({ url: '/media/exports/x.mp3', name: 'x.mp3', sceneCount: 1, durationMs: 1000 }),
  });
  assert.deepEqual(requested.sort(), ['l1', 'l2', 'l4']);
  assert.ok(getProject(project.id));
});

test('unchanged lines never become pending: Doubao lines with matching hash, legacy lines without audioHash, lines from another engine', () => {
  mkdirSync(runtimePaths.MEDIA_DIR, { recursive: true });
  for (const name of ['d1.wav', 'd2.wav', 'd3.wav']) writeFileSync(path.join(runtimePaths.MEDIA_DIR, name), 'x');
  const doubao = { provider: 'volcengine-api-key', resourceId: 'seed-tts-2.0' };
  const base = { type: 'dialogue', speaker: '林夏', speakerId: 'linxia', emotion: '开心', intensity: 60, pace: 110 };
  const state = { assets: [], characters: [{ id: 'linxia', name: '林夏', role: '角色' }], voiceMap: { linxia: 'zh_female_vv_uranus_bigtts' }, scenes: [{ id: 's1', title: '场景', lines: [
    { ...base, id: 'd1', text: '豆包配过、没改。', audioUrl: '/media/d1.wav', audioText: '豆包配过、没改。', audioEngine: 'volcengine-api-key' },
    { ...base, id: 'd2', text: '旧数据没有哈希。', audioUrl: '/media/d2.wav', audioText: '旧数据没有哈希。' },
    { ...base, id: 'd3', text: '别的引擎配的。', audioUrl: '/media/d3.wav', audioText: '别的引擎配的。', audioEngine: 'breeze', audioHash: 'from-breeze' },
  ] }] };
  state.scenes[0].lines[0].audioHash = expectedAudioHash(doubao, state, state.scenes[0].lines[0]);
  const ids = buildGenerationRequests(state, { needGeneration: needsGenerationPredicate(doubao, state) }).map((item) => item.lineId);
  assert.deepEqual(ids, [], '没改过的句子一句都不能因为 0051 变成要重配');
  assert.equal(exportPrecheck(doubao, createProject({ name: 'unchanged', state })).pendingLineCount, 0);
});

test('e2e7 upgrade: legacy lines (audioHash but no audioEngine) voiced by another engine are not pending under Doubao; text edits still are', () => {
  mkdirSync(runtimePaths.MEDIA_DIR, { recursive: true });
  for (const name of ['g1.wav', 'g2.wav', 'g3.wav']) writeFileSync(path.join(runtimePaths.MEDIA_DIR, name), 'x');
  const doubao = { provider: 'volcengine-api-key', resourceId: 'seed-tts-2.0' };
  const base = { type: 'dialogue', speaker: '林夏', speakerId: 'linxia', emotion: '平静' };
  const state = { assets: [], characters: [{ id: 'linxia', name: '林夏', role: '角色' }], voiceMap: { linxia: 'zh_female_vv_uranus_bigtts' }, scenes: [{ id: 's1', title: '场景', lines: [
    // 旧代码用 demo 配的：哈希按 demo 算，现在启用豆包复算必然对不上。
    { ...base, id: 'g1', text: '旧 demo 句。', audioUrl: '/media/g1.wav', audioText: '旧 demo 句。', audioHash: 'legacy-demo-hash' },
    { ...base, id: 'g2', text: '旧句改了字。', audioUrl: '/media/g2.wav', audioText: '旧句原文。', audioHash: 'legacy-demo-hash-2' },
    { ...base, id: 'g3', text: '旧豆包句。', audioUrl: '/media/g3.wav', audioText: '旧豆包句。' },
  ] }] };
  state.scenes[0].lines[2].audioHash = expectedAudioHash(doubao, state, state.scenes[0].lines[2]);
  const ids = buildGenerationRequests(state, { needGeneration: needsGenerationPredicate(doubao, state) }).map((item) => item.lineId);
  assert.deepEqual(ids, ['g2'], '只有改过文本的老句子要重配，没改过的不能拿豆包重配');
  const precheck = exportPrecheck(doubao, createProject({ name: 'legacy', state }));
  assert.equal(precheck.pendingLineCount, 1);
});

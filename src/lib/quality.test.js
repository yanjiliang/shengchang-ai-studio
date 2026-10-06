import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, qualityReport, stageProgress } from './quality.js';

const scene = (lines) => ({ id: 's1', title: '场景', lines });

test('formatDuration：分秒格式', () => {
  assert.equal(formatDuration(0), '0分00秒');
  assert.equal(formatDuration(65_000), '1分05秒');
});

test('stageProgress：空项目拆解 0%，其余按总量折算', () => {
  const stages = stageProgress([], {});
  assert.equal(stages[0].progress, 0);
  assert.equal(stages[1].progress, 100);
  const partial = stageProgress([scene([
    { id: 'a', type: 'dialogue', speakerId: 'narrator', audioUrl: '/m/a.wav' },
    { id: 'b', type: 'dialogue', speakerId: 'hero' },
  ])], { narrator: 'v1' });
  assert.equal(partial[1].progress, 50);
  assert.equal(partial[2].progress, 50);
  assert.equal(partial[3].progress, 100);
  assert.equal(partial[4].progress, 100);
});

test('qualityReport：完整场景全部通过且可导出', () => {
  const report = qualityReport(scene([
    { id: 'a', type: 'dialogue', speakerId: 'narrator', text: '台词', audioUrl: '/m/a.wav' },
  ]), { narrator: 'v1' }, null);
  assert.equal(report.metrics.coverage, 100);
  assert.equal(report.issues.length, 0);
  assert.ok(report.passed.some((item) => item.id === 'coverage-ok'));
  assert.equal(report.canExport, true);
  assert.equal(report.score, 100);
});

test('qualityReport：缺音频/缺音色/未绑定素材各自成条并降分', () => {
  const report = qualityReport(scene([
    { id: 'a', type: 'dialogue', speakerId: 'hero', text: '台词', audioUrl: '/m/a.wav' },
    { id: 'b', type: 'dialogue', speakerId: 'hero', text: '台词二' },
    { id: 'c', type: 'music', text: '配乐' },
  ]), {}, null);
  const ids = report.issues.map((issue) => issue.id).sort();
  assert.deepEqual(ids, ['coverage', 'sounds', 'voices']);
  assert.equal(report.canExport, true, '有对白音频即可导出');
  assert.ok(report.score < 100);
});

test('qualityReport：过期台词与坏文件进入问题清单且阻断导出', () => {
  const mediaReport = { scenes: [{ sceneId: 's1', invalidFileCount: 1, healthyDialogueCount: 1, files: [{ lineId: 'a', ok: false }, { lineId: 'b', ok: true }] }] };
  const report = qualityReport(scene([
    { id: 'a', type: 'dialogue', speakerId: 'narrator', text: '旧句', audioUrl: '/m/a.wav', audioStale: true },
    { id: 'b', type: 'dialogue', speakerId: 'narrator', text: '新句', audioUrl: '/m/b.wav' },
  ]), { narrator: 'v1' }, mediaReport);
  const ids = report.issues.map((issue) => issue.id).sort();
  assert.deepEqual(ids, ['media', 'stale']);
  assert.equal(report.issues.find((issue) => issue.id === 'stale').locate, 'a');
  assert.equal(report.canExport, false);
});

test('qualityReport：无场景返回零分空报告', () => {
  const report = qualityReport(null, {}, null);
  assert.equal(report.score, 0);
  assert.equal(report.canExport, false);
  assert.equal(report.issues.length, 0);
});

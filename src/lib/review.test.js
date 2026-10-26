import test from 'node:test';
import assert from 'node:assert/strict';
import { driftBanner, exportNotes, exportPrecheck, exportSummary, filterLines, indexAt, jobText, lineBadges, mixTimeline, pruneTakes, regenHint, rowWindow, staleMixLineIds, stepLine, takeTags } from './review.js';

const drift = { audioUrl: '/a', audioHash: 'h', voiceDrift: { score: 5.2, flagged: true, reasons: ['drift'] } };
const lines = [{ id: 'a', audioUrl: '/a', speaker: '旁白', text: '一' }, { id: 'b', ...drift, speaker: '孙悟空', text: '二' }, { id: 'c', audioUrl: '/c', mark: { reasons: ['情绪不对'], resolved: false } }];

test('时间轴只用服务端 starts / lines，播放头落在最后一个 start <= t 的句子', () => {
  const timeline = mixTimeline({ starts: [0, 5810, 9420], durationMs: 15000 }, lines);
  assert.deepEqual(timeline.map((item) => item.start), [0, 5.81, 9.42]);
  assert.equal(timeline[2].end, 15);
  assert.equal(indexAt(timeline, 6), 1);
  assert.equal(indexAt(timeline, 0), 0);
  const fromExport = mixTimeline({ lines: [{ lineId: 'b', startMs: 1000, endMs: 2000 }] }, lines);
  assert.deepEqual(fromExport[1], { start: 1, end: 2 });
  assert.equal(fromExport[0], null);
  assert.equal(mixTimeline(null, lines), null);
});

test('需重新混音 = 在用的 take 不是混音里的那条', () => {
  const withTakes = [{ id: 'a', activeTakeId: 't1' }, { id: 'b', activeTakeId: 't3' }];
  assert.deepEqual(staleMixLineIds(withTakes, { takeIds: { a: 't1', b: 't2' } }), ['b']);
  assert.deepEqual(staleMixLineIds(withTakes, null), []);
  const now = [{ id: 'a', audioUrl: '/a', audioHash: 'h1' }, { id: 'b', audioUrl: '/b', audioHash: 'h9' }, { id: 'c', audioUrl: '/c' }];
  assert.deepEqual(staleMixLineIds(now, { audio: { a: 'h1', b: 'h2' } }), ['b']);
});

test('mixFromExport：只要对白段，url 带 taskId 防缓存；audioSnapshot 记每句的指纹', async () => {
  const { mixFromExport, audioSnapshot } = await import('./review.js');
  const mix = mixFromExport({ taskId: 't9', url: '/media/exports/p-整集.mp3', durationMs: 9000, lufs: -16.1, segments: [{ lineId: 'a', sceneId: 's', type: 'dialogue', startMs: 0, endMs: 1800 }, { lineId: 'x', sceneId: 's', type: 'sound', startMs: 0, endMs: 9000 }] }, { a: 'h1' });
  assert.deepEqual([mix.mixId, mix.url, mix.lines.length, mix.lines[0].endMs, mix.lufs, mix.audio.a], ['t9', '/media/exports/p-整集.mp3?v=t9', 1, 1800, -16.1, 'h1']);
  assert.deepEqual(audioSnapshot([{ id: 'a', audioUrl: '/a', audioHash: 'h1' }, { id: 'b' }]), { a: 'h1' });
});

test('换人提示只有一条横幅；筛选和 J/K 只在筛选结果里跳', () => {
  const banner = driftBanner(lines);
  assert.equal(banner.count, 1);
  assert.match(banner.text, /^有 1 句可能换人：第 2 句听起来不像本角色/);
  assert.equal(banner.action, '只看这 1 句');
  assert.equal(driftBanner([lines[0]]), null);
  assert.deepEqual(filterLines(lines, 'drift').map((line) => line.id), ['b']);
  assert.deepEqual(filterLines(lines, 'marked').map((line) => line.id), ['c']);
  assert.equal(stepLine(['a', 'c'], 'a', 1), 'c');
  assert.equal(stepLine(['a', 'c'], 'c', 1), 'c');
  assert.equal(stepLine(['a', 'c'], 'b', -1), 'c');
});

test('行徽标：稳定句什么都不显示', () => {
  assert.deepEqual(lineBadges(lines[0]), []);
  assert.deepEqual(lineBadges(lines[1], { pendingTakeId: 't9' }).map((badge) => badge.text), ['可能换人', '新版待确认']);
  assert.deepEqual(lineBadges(lines[2], { mixStaleIds: ['c'] }).map((badge) => badge.text), ['已标记 · 情绪不对', '已换新版 · 待混音']);
});

test('虚拟列表：300 句只渲染可见区域上下 6 行', () => {
  const win = rowWindow({ scrollTop: 84 * 100, viewportHeight: 600, rowHeight: 84, count: 300 });
  assert.equal(win.start, 94);
  assert.ok(win.end - win.start <= 20);
  assert.equal(win.total, 300 * 84);
});

test('换一条：提示、任务文案', () => {
  assert.equal(regenHint({ edited: false, durationSec: 3.2, batchRunning: true }), '台词和情绪没改，换个随机种子也会出一条不一样的。预计约 6 秒。会插到批量配音前面。');
  assert.equal(jobText({ status: 'queued', queuePosition: 0, currentLineEtaSec: 8.2 }).detail, '等当前这句配完，约 9 秒');
  assert.equal(jobText({ status: 'queued', queuePosition: 2 }).title, '排队中，前面还有 2 句');
  assert.equal(jobText({ status: 'queued', queuePosition: 0 }).title, '排队中');
  assert.equal(jobText({ status: 'stopping' }).title, '当前这句完成后停止');
  assert.deepEqual(jobText({ status: 'failed', error: '内存不足' }), { title: '这一条没有生成出来', detail: '原因：内存不足', note: '原版不受影响', retry: '重试' });
});

test('版本记录最多 5 版，不清理在用 / 在混音里 / 待确认', () => {
  const takes = ['t1', 't2', 't3', 't4', 't5', 't6'].map((takeId) => ({ takeId }));
  assert.deepEqual(pruneTakes(takes, { activeTakeId: 't1', mixTakeId: 't2', pendingTakeId: 't6' }).map((take) => take.takeId), ['t1', 't2', 't4', 't5', 't6']);
  assert.deepEqual(takeTags({ takeId: 't1' }, { activeTakeId: 't1', mixTakeId: 't1' }), ['在用', '在混音里']);
});

test('导出前置检查和说明', () => {
  assert.deepEqual(exportPrecheck({ mixStale: true, markedCount: 2 }), { primary: '重新混音并导出', remixFirst: true, warning: null });
  const warn = exportPrecheck({ mixStale: false, markedCount: 1 });
  assert.equal(warn.primary, '仍然导出');
  assert.equal(warn.warning.title, '还有 1 句标了问题，仍要导出？');
  assert.equal(exportPrecheck({}).primary, '导出');
  assert.deepEqual(exportNotes({ sfxUnbound: true, breeze: true }), ['音效未绑定素材，导出只有对白。', 'Breeze-TTS-2 生成，仅限非商业用途。']);
  const summary = exportSummary({ name: 'x.mp3', durationMs: 100224, lufs: -15.7, lineCount: 19, sceneCount: 3 });
  assert.equal(summary.duration, '1:40（100.2 秒）');
  assert.equal(summary.loudness, '−15.7 LUFS');
  assert.equal(summary.counts, '19 句对白 · 3 个场景');
  assert.equal(exportSummary({ durationMs: 1000 }).loudness, '未测量');
  assert.equal(exportSummary({ durationMs: 1000, staleLineCount: 3 }).staleLineCount, 3);
  assert.equal(exportSummary({ durationMs: 1000 }).staleLineCount, 0);
});

test('导出前检查：有过期句时给「先重配这 N 句」/「按现在的版本导出」', () => {
  const check = exportPrecheck({ mixStale: false, staleLineCount: 3 });
  assert.equal(check.stale.title, '还有 3 句改过但没重新配音');
  assert.equal(check.stale.fix, '先重配这 3 句');
  assert.equal(check.primary, '按现在的版本导出');
  assert.equal(exportPrecheck({ mixStale: true, staleLineCount: 2 }).remixFirst, true);
  assert.equal(exportPrecheck({ mixStale: false, staleLineCount: 0 }).stale, undefined);
});

test('0037 export-precheck：还需渲染 N 句，约 X 字（估算）', async () => {
  const { pendingRenderText } = await import('./review.js');
  assert.equal(pendingRenderText(5, 182), '还需渲染 5 句，约 182 字（估算）');
  assert.equal(pendingRenderText(5, null), '还需渲染 5 句');
  assert.equal(pendingRenderText(0, 0), '');
  assert.equal(pendingRenderText(undefined, 10), '');
});

test('0043：换一条 queued → failed（没有 started）不留转圈、不显示「命中缓存」', async () => {
  const { takeJobPatch, takeJobBusy, jobText } = await import('./review.js');
  const { jobEvents } = await import('./chain-api.js');
  const { lineTakeError } = await import('./breeze-outage.js');
  const task = { id: 't1', kind: 'line-take', status: 'failed', progress: 0, message: '命中缓存', error: 'Breeze 连不上',
    result: { events: [{ type: 'queued' }, { type: 'failed', code: 'BREEZE_UNREACHABLE', causeCode: 'BREEZE_UNREACHABLE', error: 'Breeze 连不上' }] } };
  const { events } = jobEvents(task);
  const event = events.at(-1);
  assert.equal(event.status, 'failed');
  assert.equal(event.code, 'BREEZE_UNREACHABLE');
  let job = { status: 'queued', queuePosition: 2, progress: 0 };
  job = { ...job, ...takeJobPatch({ status: 'queued', queuePosition: 2 }) };
  assert.equal(takeJobBusy(job), true);
  job = { ...job, ...takeJobPatch(event, lineTakeError(event)) };
  assert.equal(takeJobBusy(job), false);
  assert.equal(job.queuePosition, null);
  const text = jobText(job);
  assert.equal(text.title, '这一条没有生成出来');
  assert.equal(text.detail, '原因：Breeze 连不上，这一句没生成，没有花额度');
  assert.doesNotMatch(JSON.stringify(text), /命中缓存/);
});

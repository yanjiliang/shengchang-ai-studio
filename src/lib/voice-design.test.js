import test from 'node:test';
import assert from 'node:assert/strict';
import { applyJobEvent, cancelButtonText, designPrompt, dimensionsCovered, draftRemainingSeconds, emptyDraft, impactSummary, isGenerating, lineNeedsRerender, requestCancel, retrySlot, roleVoiceStatus, staleLineCount, startDraft, takeEtaSeconds, takeQueueText, uploadChecks } from './voice-design.js';

const started = () => startDraft(emptyDraft('嗓音清亮'), { jobId: 'job1' });

test('startDraft：三张占位卡排队中', () => {
  const draft = started();
  assert.equal(draft.takes.length, 3);
  assert.deepEqual(draft.takes.map((take) => take.queuePosition), [0, 1, 2]);
  assert.equal(draft.jobStatus, 'running');
  assert.equal(isGenerating(draft), true);
});

test('applyJobEvent：按 takeId 合并，事件先来的占位卡按顺序认领，全部就绪后 done', () => {
  let draft = started();
  draft = applyJobEvent(draft, { takeId: 't1', status: 'running', queuePosition: null, seed: 42 });
  draft = applyJobEvent(draft, { takeId: 't2', status: 'queued', queuePosition: 0 });
  draft = applyJobEvent(draft, { takeId: 't3', status: 'queued', queuePosition: 1 });
  assert.deepEqual(draft.takes.map((take) => take.takeId), ['t1', 't2', 't3']);
  draft = applyJobEvent(draft, { takeId: 't1', status: 'done', audioUrl: '/a.mp3' });
  assert.equal(draft.takes[0].status, 'ready');
  assert.equal(draft.takes[0].seed, 42);
  draft = applyJobEvent(draft, { takeId: 't2', status: 'failed', error: 'Breeze 服务断开了' });
  assert.equal(draft.takes[1].status, 'error');
  assert.equal(draft.takes[1].error, 'Breeze 服务断开了');
  draft = applyJobEvent(draft, { takeId: 't3', status: 'ready', audioUrl: '/c.mp3' });
  assert.equal(draft.jobStatus, 'done');
  assert.equal(isGenerating(draft), false);
});

test('applyJobEvent：lineIndex >= 0 是用台词试听，不占候选卡；其他 job 的事件忽略', () => {
  let draft = started();
  draft = applyJobEvent(draft, { takeId: 'line-0', parentTakeId: 't1', lineIndex: 0, status: 'ready', audioUrl: '/l.mp3' });
  assert.equal(draft.takes.filter((take) => take.takeId).length, 0);
  assert.equal(draft.lineTakes['t1:0'].audioUrl, '/l.mp3');
  assert.equal(applyJobEvent(draft, { jobId: 'other', status: 'cancelled' }), draft);
});

test('全部取消：没有正在生成的 → 立即已取消；有 → 当前这句完成后停止，收到 cancelled 后丢弃那一版', () => {
  const idle = requestCancel(started());
  assert.equal(idle.jobStatus, 'cancelled'); assert.equal(idle.takes.length, 0);
  let draft = applyJobEvent(started(), { takeId: 't1', status: 'running' });
  draft = requestCancel(draft);
  assert.equal(draft.jobStatus, 'cancelling');
  assert.equal(cancelButtonText(draft), '当前这句完成后停止');
  assert.deepEqual(draft.takes.map((take) => take.status), ['running']);
  draft = applyJobEvent(draft, { jobId: 'job1', status: 'cancelled' });
  assert.equal(draft.jobStatus, 'cancelled');
  assert.equal(draft.takes.length, 0);
  assert.equal(cancelButtonText(draft), '全部取消');
});

test('取消前已就绪的版保留；服务端的 cancelling 事件也会移除排队的版', () => {
  let draft = applyJobEvent(started(), { takeId: 't1', status: 'ready', audioUrl: '/a.mp3' });
  draft = applyJobEvent(draft, { takeId: 't2', status: 'running' });
  draft = applyJobEvent(draft, { status: 'cancelling' });
  assert.deepEqual(draft.takes.map((take) => take.takeId), ['t1', 't2']);
  draft = applyJobEvent(draft, { status: 'cancelled' });
  assert.deepEqual(draft.takes.map((take) => take.takeId), ['t1']);
});

test('失败的一版重新生成：替换那张卡，回到排队', () => {
  let draft = applyJobEvent(started(), { takeId: 't1', status: 'error', error: 'x' });
  draft = retrySlot(draft, 0);
  assert.equal(draft.takes[0].status, 'queued');
  assert.equal(draft.takes[0].takeId, null);
  draft = applyJobEvent(draft, { takeId: 't9', slot: 0, status: 'running' });
  assert.equal(draft.takes[0].takeId, 't9');
});

test('排队文案：等当前这句配完 / 前面还有 N 版；全部完成还需约 T 秒', () => {
  let draft = { ...started(), currentLineEtaSec: 7 };
  const ref = '一二三四五六七八九十一二三四五六七八九十'; // 20 字 → 每版 6.65 秒
  assert.equal(takeQueueText(draft.takes[0], draft, { referenceText: ref }).title, '排队中 · 等当前这句配完，约 7 秒');
  assert.equal(takeQueueText(draft.takes[0], draft, { referenceText: ref }).detail, '配完这句就先做试听');
  assert.equal(takeQueueText(draft.takes[2], draft, { referenceText: ref }).title, '排队中 · 前面还有 2 版');
  assert.ok(Math.abs(draftRemainingSeconds(draft, { referenceText: ref }) - (7 + 3 * takeEtaSeconds(ref))) < 1e-9);
  draft = applyJobEvent(draft, { takeId: 't1', status: 'running', etaSec: 4 });
  assert.equal(takeQueueText(draft.takes[0], draft, { referenceText: ref }).detail, '还需约 4 秒');
  assert.equal(takeQueueText({ status: 'queued', queuePosition: 0 }, { currentLineEtaSec: null }).title, '排队中');
});

test('描述：维度打勾、自动追加中性语气句', () => {
  assert.deepEqual(dimensionsCovered('三十岁上下的男声，中低音，略带沙哑，语速偏慢'), ['age', 'gender', 'pitch', 'texture', 'pace']);
  assert.deepEqual(dimensionsCovered(''), []);
  assert.equal(designPrompt('嗓音清亮'), '嗓音清亮。这段话用正常语速、平静中性的语气说，不带情绪。');
  assert.equal(designPrompt('  '), '');
});

test('上传检查：时长 5–30 秒（5–10 秒只提示）、原话必填、每秒字数、授权', () => {
  assert.deepEqual(uploadChecks({ durationSec: 4.9, transcript: '你好', consent: true }).errors.map((item) => item.field), ['file']);
  const short = uploadChecks({ durationSec: 8, transcript: '字'.repeat(30), consent: true });
  assert.equal(short.canLock, true);
  assert.deepEqual(short.warnings.map((item) => item.text), ['录音 8.0 秒，建议 10 到 30 秒，太短可能不稳']);
  assert.equal(uploadChecks({ durationSec: 31, transcript: '你好', consent: true }).canLock, false);
  const empty = uploadChecks({ durationSec: 12, transcript: ' ', consent: true });
  assert.equal(empty.errors[0].text, '请填写录音里说的原话，克隆需要逐字对应');
  assert.equal(uploadChecks({ durationSec: 12, transcript: '短', consent: true }).warnings.length, 1);
  assert.equal(uploadChecks({ durationSec: 12, transcript: '字'.repeat(100), consent: true }).warnings.length, 1);
  const ok = uploadChecks({ durationSec: 12, transcript: '字'.repeat(50), consent: true });
  assert.equal(ok.canLock, true); assert.equal(ok.warnings.length, 0);
  assert.equal(uploadChecks({ durationSec: 12, transcript: '字'.repeat(50), consent: false }).canLock, false);
  assert.equal(uploadChecks({ decodeError: 'x', transcript: 'a', consent: true }).errors[0].field, 'file');
});

test('impactSummary：约定字段 + Design 草案字段；未渲染句数从项目算', () => {
  const lines = [{ id: 'l03', text: 'a', audioUrl: '/x' }, { id: 'l06', text: 'b', audioUrl: '/y' }, { id: 'l20', text: 'c' }];
  const agreed = impactSummary({ affectedLineCount: 2, lineIds: ['l03', 'l06'] }, lines);
  assert.deepEqual([agreed.staleCount, agreed.unrenderedCount, agreed.staleLines.map((line) => line.text)], [2, 1, ['a', 'b']]);
  const draft = impactSummary({ unrenderedCount: 4, staleCount: 1, staleLineIds: ['zz'] }, lines, { beforeLock: false });
  assert.deepEqual([draft.staleCount, draft.unrenderedCount, draft.staleLines[0].text], [1, 4, 'zz']);
  // 锁定前服务端按当前参考音算是 0 句，但换了以后已生成的都会对不上。
  const before = impactSummary({ affectedLineCount: 0, lineIds: [] }, lines);
  assert.deepEqual([before.staleCount, before.staleLines.map((line) => line.id)], [2, ['l03', 'l06']]);
});

test('需重渲：只认服务端 line.stale，前端不自己推断', () => {
  const role = { voice: { audioHash: 'sha256:new' } };
  // 只认服务端的 stale；指纹 / audioStale 不再由前端推断。
  assert.equal(lineNeedsRerender({ audioUrl: '/a', stale: true }, role), true);
  assert.equal(lineNeedsRerender({ audioUrl: '/a', voiceReferenceHash: 'sha256:old' }, role), false);
  assert.equal(lineNeedsRerender({ audioUrl: '/a', audioStale: true }, role), false);
  assert.equal(lineNeedsRerender({ stale: true }, role), false);
  assert.equal(staleLineCount([{ audioUrl: '/a', stale: true }, { audioUrl: '/b', stale: false }]), 1);
});

test('角色列表状态', () => {
  assert.equal(roleVoiceStatus({}, null), '未设计');
  assert.equal(roleVoiceStatus({ voice: { referenceId: 'vr_1', source: 'uploaded' } }, null), '已锁定 · 上传录音');
  assert.equal(roleVoiceStatus({}, { ...started(), currentLineEtaSec: 3 }), '排队中，等当前这句配完');
  assert.equal(roleVoiceStatus({}, applyJobEvent(started(), { takeId: 't', status: 'running' })), '生成中 0/3');
});

test('Breeze 断开：排队和生成中的版变失败卡，已就绪的不动', async () => {
  const { failActiveTakes, lockedVoice } = await import('./voice-design.js');
  let draft = applyJobEvent(started(), { takeId: 't1', status: 'ready', audioUrl: '/a' });
  draft = applyJobEvent(draft, { takeId: 't2', status: 'running' });
  draft = failActiveTakes(draft);
  assert.deepEqual(draft.takes.map((take) => take.status), ['ready', 'error', 'error']);
  assert.equal(draft.takes[1].error, 'Breeze 服务断开了');
  assert.equal(isGenerating(draft), false);
  const voice = lockedVoice({ result: { referenceId: 'vr_1', audioHash: 'sha256:x', source: 'designed' }, take: { seed: 42, audioUrl: '/a' }, draft: { description: 'd', referenceText: 'r' }, previous: { version: 2 } });
  assert.deepEqual([voice.version, voice.seed, voice.refTranscript, voice.source], [3, 42, 'r', 'designed']);
  const uploaded = lockedVoice({ result: { referenceId: 'vr_2', audioHash: 'h', source: 'uploaded' }, transcript: '原话', source: 'uploaded' });
  assert.equal('seed' in uploaded, false); assert.equal(uploaded.refTranscript, '原话');
});

test('VoiceReference（openapi）→ 界面参考音色：source design|upload，version 以服务端为准', async () => {
  const { lockedVoice, voiceFromReference, referenceFromVoice } = await import('./voice-design.js');
  const locked = lockedVoice({ result: { referenceId: 'r1', audioHash: 'h1', source: 'design', version: 4, breezeVoiceId: 'sc-x', audioUrl: '/media/ref-h1.wav', transcript: '测试句' }, take: { seed: 7 }, draft: { description: '低沉' }, previous: { version: 1 } });
  assert.deepEqual([locked.source, locked.version, locked.refAudioUrl, locked.refTranscript, locked.seed], ['designed', 4, '/media/ref-h1.wav', '测试句', 7]);
  const fromServer = voiceFromReference({ referenceId: 'r2', audioHash: 'h2', source: 'upload', version: 2, audioUrl: '/media/ref-h2.wav', transcript: '原话', durationMs: 12000, createdAt: 0 }, { referenceId: 'r2', f0Hz: 180 });
  assert.deepEqual([fromServer.source, fromServer.durationSec, fromServer.f0Hz, 'seed' in fromServer], ['uploaded', 12, 180, false]);
  assert.equal(voiceFromReference(null), null);
  assert.equal(referenceFromVoice(locked).source, 'design');
  assert.equal(voiceFromReference(referenceFromVoice(locked)).referenceId, 'r1');
});

import { AlertTriangle, ChevronLeft, ChevronRight, Download, Flag, LoaderCircle, Pause, Play, RefreshCw, Wrench } from 'lucide-react';
import { EXPORT_LOCK_TEXT } from '../../lib/export-lock.js';
import { exportFailureView, resolveMissingLines } from '../../lib/export-failure.js';
import { ExportFailure } from '../ExportFailure';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { finishPendingLabel, mixFreshText } from '../../lib/one-click.js';
import { chainApi } from '../../lib/chain-api.js';
import {
  OFFLINE_REGEN, OVERSCAN, ROW_HEIGHT, driftBanner, filterLines, formatClock, indexAt, isDrifted, isMarked,
  doubaoRegenConfirm, lineAriaLabel, lineBadges, mixTimeline, randomSeed, readingLinesText, reviewLines, rowWindow, staleMixLineIds, stepLine,
  isTakeExpired,
} from '../../lib/review.js';
import { ModalShell } from '../ModalShell';
import { singleAudio } from '../../lib/single-audio.js';
import { useSingleAudio } from '../../lib/useSingleAudio.js';
import { ReviewExportDialog } from './ReviewExportDialog';
import { ReviewInspector, useDraft } from './ReviewInspector';
import { useEpisodeMix, useLineJobs, useLineTakes, useMediaQuery, useReviewToast, watchToEnd } from './useReview';

const EPISODE = 'episode';
const typing = (target) => target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

function ReviewToast({ toast, onHide }) {
  return (
    <div className="review-toast-region" role="status" aria-live="polite">
      {toast ? <div className="review-toast" key={toast.id}><span>{toast.text}</span>{toast.action ? <button type="button" className="link-button" onClick={() => { onHide(); toast.action.run(); }}>{toast.action.label}</button> : null}</div> : null}
    </div>
  );
}

// 审听修句。一个项目 = 一集，episodeId = projectId。
export function ReviewMode({ project, exportLocked = false, breezeMode, breeze, batchRunning = false, onUpdateAnyLine, onSaveNow, onAccepted, onGoProduce, onRegenerateLines, onFinishPending = null, refreshToken = 0 }) {
  const projectId = project.id;
  const scenes = project.state?.scenes || [];
  const lines = useMemo(() => reviewLines(scenes), [scenes]);
  // 审听页的读取中状态（fe-0010）：项目内容 / 整集时间轴还没读到时写「正在读取 N 句台词」，不留空白。
  // N 取项目已知的台词数（已读到的台词，或项目列表给的 lineCount / dialogueCount），不知道就不写数字。
  const linesLoading = !project.state || project.loading === true;
  const expectedLineCount = lines.length || Number(project.lineCount ?? project.dialogueCount) || 0;
  const indexOf = useMemo(() => new Map(lines.map((line, index) => [line.id, index])), [lines]);
  const nameOf = useCallback((id) => project.state?.characters?.find((role) => role.id === id)?.name || id || '', [project.state?.characters]);
  const emotions = useMemo(() => [...new Set(lines.map((line) => line.emotion).filter(Boolean))], [lines]);
  const hasAudio = lines.some((line) => line.audioUrl);
  const mobile = useMediaQuery('(max-width: 760px)');
  const breezeOnline = !breezeMode || breeze?.status?.state === 'connected';

  const mix = useEpisodeMix(projectId, { hasAudio, lines });
  // B1：一键成片跑完（App 从任务轮询里看到）→ 重新读混音和时间轴。
  const mixRef = useRef(mix);
  mixRef.current = mix;
  useEffect(() => { if (refreshToken) mixRef.current.reload().catch(() => {}); }, [refreshToken]);
  const timeline = useMemo(() => mixTimeline(mix.mix, lines), [mix.mix, lines]);
  const staleIds = useMemo(() => staleMixLineIds(lines, mix.mix), [lines, mix.mix]);
  const totalSec = (mix.mix?.durationMs || 0) / 1000;
  const { toast, show: showToast, hide: hideToast } = useReviewToast();
  const [announce, setAnnounce] = useState('');

  // ---- 播放头 ----
  const audio = useSingleAudio();
  const episodePlaying = audio.id === EPISODE && audio.playing;
  const auditionPlaying = audio.playing && audio.id !== EPISODE;
  const [cursor, setCursor] = useState(0);
  useEffect(() => { if (audio.id === EPISODE && audio.playing) setCursor(audio.currentTime); }, [audio.id, audio.playing, audio.currentTime]);
  useEffect(() => { if (audio.id === EPISODE && audio.ended) setCursor(0); }, [audio.id, audio.ended]);
  useEffect(() => () => singleAudio.stop(), []);
  const currentIndex = indexAt(timeline, cursor);
  const currentLine = lines[currentIndex] || null;

  // ---- 选中句 / 检查面板 ----
  const [filter, setFilter] = useState('all');
  const visible = useMemo(() => filterLines(lines, filter), [lines, filter]);
  const visibleIds = useMemo(() => visible.map((line) => line.id), [visible]);
  const [selectedId, setSelectedId] = useState(null);
  const selected = lines.find((line) => line.id === selectedId) || lines[0] || null;
  const selectedIndex = selected ? indexOf.get(selected.id) : -1;
  const [takesKey, setTakesKey] = useState(0);
  const takes = useLineTakes(projectId, selected?.id, `${takesKey}:${selected?.audioHash}`, selected?.pendingTakeId || null);
  const jobs = useLineJobs(projectId, {
    onCompleted: async (lineId, take) => {
      // reused（0023 起）：命中缓存且这句已有同一段，takeId 是已有那版，不新增、不进对比。
      // 老服务端没有 reused：cached 或音频就是现在这条，也按「没有新增」处理。
      const current = lines.find((line) => line.id === lineId);
      const number = (indexOf.get(lineId) ?? 0) + 1;
      if (take.reused === true || take.cached === true || (take.audioUrl && current?.audioUrl && take.audioUrl === current.audioUrl)) {
        setTakesKey((value) => value + 1);
        const text = `第 ${number} 句：和已有的一版相同，没有新增`;
        setAnnounce(text); showToast(text);
        return;
      }
      // 新版先「待确认」（浏览器字段，随作品保存），对比卡里选用还是保留原版。
      onUpdateAnyLine(lineId, { pendingTakeId: take.takeId });
      setTakesKey((value) => value + 1);
      setAnnounce(`第 ${(indexOf.get(lineId) ?? 0) + 1} 句的新版已生成，可以对比`);
    },
  });
  const selectedJob = selected ? jobs.jobs[selected.id] : null;
  const [panelFocus, setPanelFocus] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const draftState = useDraft(selected, false);
  const pinReason = !selected ? '' : draftState.dirty ? '有没提交的修改' : selectedJob && ['queued', 'running', 'stopping'].includes(selectedJob.status) ? '正在换一条' : (takes.pendingTakeId || selected.pendingTakeId) ? '新版待确认' : panelFocus ? '正在操作' : auditionPlaying ? '正在试听' : (mobile && sheetOpen) ? '正在修这句' : '';
  // 整集播放时检查面板跟着播放头走；有未提交的修改、任务、待确认新版、焦点在面板里或正在试听时固定。
  useEffect(() => { if (episodePlaying && currentLine && !pinReason && currentLine.id !== selectedId) setSelectedId(currentLine.id); }, [episodePlaying, currentLine, pinReason, selectedId]);

  // ---- 列表虚拟化 ----
  const listRef = useRef(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const [rowHeight, setRowHeight] = useState(ROW_HEIGHT.desktop);
  const programmatic = useRef(false);
  const [detached, setDetached] = useState(false);
  useEffect(() => {
    const element = listRef.current; if (!element) return undefined;
    const measure = () => {
      setViewport(element.clientHeight || 600);
      const fromCss = parseFloat(getComputedStyle(element).getPropertyValue('--row-h'));
      setRowHeight(Number.isFinite(fromCss) && fromCss > 0 ? fromCss : mobile ? ROW_HEIGHT.mobile : ROW_HEIGHT.desktop);
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [mobile, hasAudio]);
  const windowRange = rowWindow({ scrollTop, viewportHeight: viewport, rowHeight, count: visible.length, overscan: OVERSCAN });
  const scrollToLine = useCallback((lineId, { align = 'auto' } = {}) => {
    const element = listRef.current; const position = visibleIds.indexOf(lineId);
    if (!element || position < 0) return;
    const top = position * rowHeight;
    const inView = top >= element.scrollTop && top + rowHeight <= element.scrollTop + element.clientHeight;
    if (inView && align === 'auto') return;
    programmatic.current = true;
    element.scrollTop = Math.max(0, top - (align === 'center' || !inView ? element.clientHeight / 2 - rowHeight / 2 : 0));
    setScrollTop(element.scrollTop);
  }, [visibleIds, rowHeight]);
  // 播放时自动滚到正在播的句子；用户手动滚动后停下，出现「回到正在播放的句子」。
  useEffect(() => { if (episodePlaying && currentLine && !detached) scrollToLine(currentLine.id); }, [episodePlaying, currentLine, detached, scrollToLine]);
  const onScroll = (event) => {
    setScrollTop(event.currentTarget.scrollTop);
    if (programmatic.current) { programmatic.current = false; return; }
    if (episodePlaying) setDetached(true);
  };
  const backToCurrent = () => { setDetached(false); if (currentLine) scrollToLine(currentLine.id, { align: 'center' }); };

  // ---- 播放控制 ----
  const startOf = (line) => timeline?.[indexOf.get(line?.id)]?.start;
  const playFrom = (sec) => { if (mix.mix?.url) { setCursor(sec); singleAudio.playAt(EPISODE, mix.mix.url, sec); } };
  const togglePlay = () => {
    if (!mix.mix?.url) return;
    if (episodePlaying) { singleAudio.pause(); return; }
    setDetached(false);
    playFrom(cursor >= totalSec - 0.05 ? 0 : cursor);
  };
  const goTo = (line, { play } = {}) => {
    if (!line) return;
    setSelectedId(line.id);
    const sec = startOf(line);
    if (Number.isFinite(sec)) { if (episodePlaying || play) playFrom(sec); else setCursor(sec); }
    scrollToLine(line.id);
  };
  const step = (direction) => {
    const anchor = episodePlaying ? currentLine?.id : selected?.id;
    const nextId = stepLine(visibleIds, anchor, direction);
    // 焦点在列表里时跟着走，不然键盘用户按 J/K 后 Tab 会从旧的那句接着走。
    const follow = document.activeElement instanceof HTMLElement && document.activeElement.closest('.review-list');
    goTo(lines.find((line) => line.id === nextId));
    if (follow && nextId) {
      const focusRow = (tries) => {
        const target = document.querySelector(`.review-row[data-line-id="${CSS.escape(nextId)}"] .review-row-main`);
        if (target) target.focus({ preventScroll: true });
        else if (tries > 0) requestAnimationFrame(() => focusRow(tries - 1));
      };
      requestAnimationFrame(() => focusRow(5));
    }
  };
  const seekBar = (event) => {
    if (!totalSec) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const sec = Math.max(0, Math.min(totalSec, ((event.clientX - rect.left) / rect.width) * totalSec));
    if (episodePlaying) playFrom(sec); else { setCursor(sec); const index = indexAt(timeline, sec); if (lines[index]) setSelectedId(lines[index].id); }
  };

  // ---- 标记 ----（服务端没有标记接口：存在台词上，随作品保存）
  const setMark = (line, mark) => { onUpdateAnyLine(line.id, { mark }); };
  const toggleMark = (line) => {
    if (!line) return;
    const previous = line.mark || null;
    const number = indexOf.get(line.id) + 1;
    if (isMarked(line)) { setMark(line, null); showToast(`已取消第 ${number} 句的标记`, { label: '撤销', run: () => setMark(line, previous) }); }
    else { setMark(line, { reasons: [], resolved: false, at: new Date().toISOString() }); showToast(mobile ? `已标记第 ${number} 句` : `已标记第 ${number} 句，可以在右侧补充原因`, { label: '撤销', run: () => setMark(line, previous) }); }
  };
  const toggleReason = (line, reason) => {
    const reasons = isMarked(line) ? line.mark.reasons || [] : [];
    const next = reasons.includes(reason) ? reasons.filter((item) => item !== reason) : [...reasons, reason];
    setMark(line, { reasons: next, resolved: false, at: line.mark?.at || new Date().toISOString() });
  };

  // ---- 换一条 / 对比 / 版本 ----
  const [busy, setBusy] = useState(false);
  // 「换一条」：服务端按已保存的台词生成，所以先把面板里改的文字 / 情绪 / 潜台词存下来。
  // Breeze 换一个随机种子；豆包不支持种子，而且按字扣费，先确认。
  const [regenConfirm, setRegenConfirm] = useState(null);
  const runRegen = async (line) => {
    const edits = Object.fromEntries(['text', 'emotion', 'subtext'].filter((key) => (draftState.draft[key] ?? '') !== (line[key] || '')).map((key) => [key, draftState.draft[key]]));
    try {
      if (Object.keys(edits).length) { onUpdateAnyLine(line.id, edits); await onSaveNow?.(); }
      jobs.start({ ...line, ...edits }, breezeMode ? { seed: randomSeed() } : {});
    } catch (error) { showToast(`没能保存修改：${error.message}`); }
  };
  const regen = (line) => {
    if (breezeMode) { runRegen(line); return; }
    setRegenConfirm({ line, text: doubaoRegenConfirm(draftState.draft.text ?? line.text) });
  };
  // 对比卡片用完就消失，焦点交回这句的标题，免得落到 body。
  const focusInspector = () => requestAnimationFrame(() => document.querySelector('.review-inspector .inspector-title')?.focus());
  const switchTake = async (line, take, previous, { fromCompare }) => {
    setBusy(true);
    const number = indexOf.get(line.id) + 1;
    const before = { mark: line.mark || null, pendingTakeId: line.pendingTakeId || null };
    try {
      await chainApi.acceptLineTake(line.id, take.takeId, { projectId });
      onUpdateAnyLine(line.id, { pendingTakeId: null, ...(isMarked(line) ? { mark: { ...line.mark, resolved: true } } : {}) });
      await onAccepted?.();
      setTakesKey((value) => value + 1);
      draftState.reset();
      // 第一次换新版前的原音频不是一条 take，服务端没法换回去，所以只有原来就是 take 时才给「撤销」。
      const undo = previous?.takeId && !previous.original ? { label: '撤销', run: async () => {
        try { await chainApi.acceptLineTake(line.id, previous.takeId, { projectId }); }
        catch (error) { showToast(`没能撤销：${error.message}`); if (isTakeExpired(error)) setTakesKey((value) => value + 1); return; }
        onUpdateAnyLine(line.id, { ...before, ...(fromCompare ? { pendingTakeId: take.takeId } : {}) });
        await onAccepted?.(); setTakesKey((value) => value + 1);
      } } : null;
      showToast(`第 ${number} 句已换成新版，整集需要重新混音`, undo);
    } catch (error) {
      showToast(`没能换成新版：${error.message}`);
      // 0046：410 TAKE_EXPIRED = 这条试听文件已经没了。重新读这句的版本列表，待定的那条也撤掉，免得一直挂着点不动的「换成新版」。
      if (isTakeExpired(error)) {
        if (line.pendingTakeId && line.pendingTakeId === take.takeId) onUpdateAnyLine(line.id, { pendingTakeId: null });
        setTakesKey((value) => value + 1);
      }
    }
    setBusy(false);
    focusInspector();
  };
  const keepOriginal = (line, take) => {
    onUpdateAnyLine(line.id, { pendingTakeId: null });
    setTakesKey((value) => value + 1);
    focusInspector();
    showToast(`已保留第 ${indexOf.get(line.id) + 1} 句原版，新版留在版本记录里`, { label: '撤销', run: () => { onUpdateAnyLine(line.id, { pendingTakeId: take.takeId }); setTakesKey((value) => value + 1); } });
  };

  // ---- 重新混音（只拼接 + 统一响度）。撤销回到上一版混音；播放位置保持在同一句的同一偏移。 ----
  const keepPosition = (nextMix, play) => {
    const index = currentIndex; const offset = index >= 0 ? cursor - timeline[index].start : 0;
    const nextTimeline = mixTimeline(nextMix, lines);
    const sec = index >= 0 && nextTimeline?.[index] ? nextTimeline[index].start + Math.max(0, offset) : 0;
    setCursor(sec);
    if (play) singleAudio.playAt(EPISODE, nextMix.url, sec);
  };
  // 重新混音失败（fe-0010）：固定文案 + 重试 + 详情（服务端原文），留在播放条下面直到重试成功或关掉。
  const [remixFailure, setRemixFailure] = useState(null);
  const doRemix = async () => {
    const wasPlaying = episodePlaying;
    setRemixFailure(null);
    if (wasPlaying) singleAudio.pause();
    const previousId = mix.mix?.mixId;
    const count = staleIds.length;
    try {
      const next = await mix.remix();
      keepPosition(next, wasPlaying);
      // 服务端只留最新一份成片（同名覆盖），chainApi.capabilities.undoRemix 为 false 时不给「撤销」。
      showToast(count ? `已重新混音，换上了 ${count} 句新版` : '已重新混音', previousId && chainApi.capabilities.undoRemix ? { label: '撤销', run: async () => { const restored = await mix.restore(previousId); keepPosition(restored, singleAudio.state.id === EPISODE && singleAudio.state.playing); } } : null);
      return next;
    } catch (error) {
      const view = exportFailureView(error);
      if (view.locked) showToast(view.text); else setRemixFailure(view);
      throw error;
    }
  };

  // ---- 导出 ----
  const [exportState, setExportState] = useState({ open: false, phase: 'check', progress: 0, message: '', result: null, error: '' });
  const exportOpenRef = useRef(false);
  exportOpenRef.current = exportState.open;
  const issueCount = lines.filter((line) => isMarked(line) || isDrifted(line)).length;
  const sfxUnbound = scenes.some((scene) => (scene.lines || []).some((line) => line.type !== 'dialogue' && !line.assetId && !line.audioUrl));
  const breezeNote = breezeMode || lines.some((line) => line.engine === 'breeze' || line.voiceEngine === 'breeze');
  // 打开窗口就问服务端还有几句过期（GET /export-precheck，只读）。取不到不拦导出。
  const [precheck, setPrecheck] = useState(null);
  const loadPrecheck = useCallback(async () => {
    setPrecheck({ loading: true });
    try {
      const result = await chainApi.exportPrecheck(projectId);
      // 0049：missingFileLines = 有 audioUrl 但文件丢了的句子（导出会被拒绝），补上角色和台词开头。
      const missingFileLines = resolveMissingLines(result.missingFileLines || [], scenesRef.current);
      if (result.pendingLineCount !== undefined) setHeadPending(result.pendingLineCount);
      setPrecheck({ loading: false, staleLineCount: Number(result.staleLineCount) || 0, missingAudioLineCount: Number(result.missingAudioLineCount) || 0, missingFileLineCount: Number(result.missingFileLineCount) || missingFileLines.length, missingFileLines, pendingLineCount: result.pendingLineCount ?? null, pendingCharCount: result.pendingCharCount ?? null, staleLineIds: (result.staleLines || []).map((item) => item.lineId) });
      return missingFileLines;
    } catch (error) { setPrecheck({ loading: false, staleLineCount: 0, missingAudioLineCount: 0, missingFileLineCount: 0, missingFileLines: [], staleLineIds: [], error: error.message }); return []; }
  }, [projectId]);
  const scenesRef = useRef(scenes);
  scenesRef.current = scenes;
  // N2：顶部「整集混音是不是最新的」也以 export-precheck 的 pendingLineCount 为准（服务端的判断：
  // 过期 + 没音频 + 文件丢了）。打开审听、台词有变化（改了情绪 / 文本 / 重配完）、一键成片结束后都重新问一次。
  const [headPending, setHeadPending] = useState(null);
  const linesKey = useMemo(() => lines.map((line) => `${line.id}:${line.audioUrl || ''}:${line.audioHash || ''}:${line.stale ? 1 : 0}:${line.emotion || ''}:${line.intensity ?? ''}:${line.text || ''}`).join('|'), [lines]);
  useEffect(() => {
    if (!projectId) return undefined;
    let alive = true;
    const timer = window.setTimeout(() => {
      chainApi.exportPrecheck(projectId).then((result) => { if (alive) setHeadPending(result.pendingLineCount ?? null); }).catch(() => { if (alive) setHeadPending(null); });
    }, 400);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [projectId, refreshToken, linesKey]);
  const openExport = () => {
    if (exportState.phase !== 'running') loadPrecheck();
    setExportState((current) => ({ ...current, open: true, phase: current.phase === 'running' ? 'running' : 'check' }));
  };
  // 「先重配这 N 句」= 过期的 + 文件丢了的（走 App 的手动生成，B3 修过的音色判断）。
  const fixStale = () => {
    const ids = [...new Set([...(precheck?.staleLineIds || []), ...(precheck?.missingFileLines || []).map((item) => item.lineId)])];
    setExportState((current) => ({ ...current, open: false }));
    // 只有要重配的句子（没有缺音频的）时，precheck 的 pendingCharCount 正好就是这几句的字数（豆包确认用）。
    const charCount = precheck?.missingAudioLineCount === 0 && precheck?.pendingCharCount !== null ? precheck?.pendingCharCount : null;
    if (onRegenerateLines && ids.length) onRegenerateLines(ids, { charCount });
    else setFilter('all');
  };
  const startExport = async (remixFirst) => {
    if (exportLocked) return;
    singleAudio.pause();
    // 导出就是按当前每句的音频重新拼一遍整集（服务端没有单独的「混音」），所以先混音和直接导出是同一件事。
    setExportState((current) => ({ ...current, phase: 'running', progress: 0, message: remixFirst ? '正在重新混音' : '正在准备', error: '', failure: null }));
    try {
      const { jobId } = await chainApi.exportEpisode(projectId);
      const result = await watchToEnd(jobId, (progress, message) => setExportState((current) => ({ ...current, progress, message })));
      setExportState((current) => ({ ...current, phase: 'done', result, progress: 1 }));
      // 时间轴（整集长度、换过的句子）随后再刷新；不要让它拖住「导出完成」。
      mix.reload().catch(() => {});
      setAnnounce('整集已导出');
      if (!exportOpenRef.current) showToast('整集已导出', { label: '查看', run: () => setExportState((current) => ({ ...current, open: true })) });
    } catch (error) {
      const view = exportFailureView(error);
      setExportState((current) => ({ ...current, phase: 'failed', error: view.detail, failure: view }));
      // 整集导出任务失败只带一句话，丢了文件的是哪几句从 export-precheck 补。
      if (view.missing && !view.lines.length) loadPrecheck().then((found) => { if (found.length) setExportState((current) => current.failure?.missing ? { ...current, failure: { ...current.failure, lines: found } } : current); });
      if (!exportOpenRef.current) showToast(view.text, { label: '查看', run: () => setExportState((current) => ({ ...current, open: true })) });
    }
  };

  // 手机抽屉收起后，焦点回到这句的「修」按钮（不然落到 body，读屏会从页面开头读起）。
  const sheetWasOpen = useRef(false);
  useEffect(() => {
    if (sheetOpen) { sheetWasOpen.current = true; return; }
    if (!sheetWasOpen.current) return;
    sheetWasOpen.current = false;
    if (document.activeElement && document.activeElement !== document.body && document.body.contains(document.activeElement)) return;
    const row = selected?.id ? document.querySelector(`.review-row[data-line-id="${CSS.escape(selected.id)}"]`) : null;
    (row?.querySelector('.row-actions button:last-child') || row?.querySelector('.review-row-main'))?.focus({ preventScroll: true });
  }, [sheetOpen, selected?.id]);

  // ---- 键盘：Space 播放/暂停（输入框里不触发）；J/K 上一句/下一句（在当前筛选里）；M 标记；Esc 停止试听 / 收起抽屉 ----
  const keyRef = useRef(null);
  keyRef.current = (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (document.querySelector('.modal-overlay')) return;
    if (typing(event.target)) return;
    const inPanel = event.target instanceof HTMLElement && event.target.closest('.review-inspector');
    const key = event.key.toLowerCase();
    if (event.key === ' ' && !(inPanel && event.target.tagName === 'BUTTON')) { event.preventDefault(); togglePlay(); }
    else if (key === 'j') { event.preventDefault(); step(-1); }
    else if (key === 'k') { event.preventDefault(); step(1); }
    else if (key === 'm') { event.preventDefault(); toggleMark(episodePlaying && !pinReason ? currentLine : selected); }
    else if (event.key === 'Escape') {
      if (auditionPlaying) { event.preventDefault(); singleAudio.stop(); }
      else if (sheetOpen) { event.preventDefault(); setSheetOpen(false); }
    }
  };
  useEffect(() => {
    const onKey = (event) => keyRef.current?.(event);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- 空状态 ----
  if (!hasAudio) {
    return (
      <section className="review-mode is-empty" aria-label="审听修句">
        <div className="review-empty">
          <h3>还没有可以审听的音频</h3>
          <p className="muted">先在「场景导演」里给台词配音，生成后这里可以连着听、标记问题、换一条。</p>
          <button type="button" className="button primary-button" onClick={onGoProduce}>去「场景导演」生成整集</button>
        </div>
      </section>
    );
  }

  const banner = driftBanner(lines);
  const counts = { all: lines.length, marked: lines.filter(isMarked).length, drift: lines.filter(isDrifted).length };
  const playIndex = currentIndex >= 0 ? currentIndex : selectedIndex;
  const playLine = lines[playIndex];
  const remixing = mix.status === 'remixing';
  const mixStatus = remixing ? `正在重新混音 ${Math.round((mix.progress || 0) * 100)}%` : !mix.mix ? (remixFailure ? '还没有整集混音' : mix.error ? `还没有整集混音：${mix.error}` : (mix.status === 'loading' ? readingLinesText(lines.length) : '正在准备整集混音')) : headPending > 0 ? mixFreshText(headPending) : staleIds.length ? `需重新混音 · 已换 ${staleIds.length} 句` : mixFreshText(0);
  const prevLine = selectedIndex > 0 ? lines[selectedIndex - 1] : null;
  const selectedStart = startOf(selected);
  const tailSegment = mix.mix?.url && Number.isFinite(selectedStart) && prevLine ? { url: mix.mix.url, from: Math.max(0, selectedStart - 2), to: selectedStart } : null;

  const inspector = (
    <div className="review-inspector-wrap" onFocus={() => setPanelFocus(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPanelFocus(false); }}>
      {pinReason && episodePlaying && currentLine && currentLine.id !== selected?.id ? <p className="inspector-pin" role="note">{pinReason}，面板停在第 {selectedIndex + 1} 句，不跟着播放走</p> : null}
      <ReviewInspector
        line={selected} index={selectedIndex} prevLine={prevLine} timelineItem={timeline?.[selectedIndex]} sceneNumber={(selected?.sceneIndex ?? 0) + 1}
        nameOf={nameOf} emotions={emotions} takes={takes} job={selectedJob} breezeOnline={breezeOnline} batchRunning={batchRunning} busy={busy}
        tailSegment={tailSegment} draft={draftState.draft} onDraft={draftState.update} breezeMode={breezeMode}
        onPlayFrom={() => { setDetached(false); goTo(selected, { play: true }); }}
        onToggleMark={() => toggleMark(selected)} onToggleReason={(reason) => toggleReason(selected, reason)}
        onRegen={() => regen(selected)} onCancelJob={() => jobs.cancel(selected)}
        onAccept={(fresh, original) => switchTake(selected, fresh, original, { fromCompare: true })}
        onKeep={(fresh) => keepOriginal(selected, fresh)}
        onUse={(take, original) => switchTake(selected, take, original, { fromCompare: false })}
        onClose={mobile ? () => setSheetOpen(false) : null}
      />
    </div>
  );

  return (
    <section className={`review-mode ${mobile ? 'is-mobile' : ''}`} aria-label="审听修句">
      <div className="review-playbar" role="group" aria-label="整集播放">
        <div className="playbar-controls">
          <button type="button" className="icon-button round" aria-label="上一句（J）" onClick={() => step(-1)}><ChevronLeft size={16} /></button>
          <button type="button" className="icon-button round is-primary" aria-label={episodePlaying ? '暂停（空格）' : '播放整集（空格）'} disabled={!mix.mix?.url} onClick={togglePlay}>{episodePlaying ? <Pause size={16} /> : <Play size={16} />}</button>
          <button type="button" className="icon-button round" aria-label="下一句（K）" onClick={() => step(1)}><ChevronRight size={16} /></button>
        </div>
        <div className="playbar-main">
          <p className="playbar-now">{playLine ? <><strong>第 {playIndex + 1} 句 · {playLine.speaker || nameOf(playLine.speakerId)}</strong><span>{playLine.text}</span></> : '—'}</p>
          <div className="playbar-track">
            <div className="review-timeline" role="progressbar" aria-label="整集播放进度" aria-valuemin={0} aria-valuemax={Math.round(totalSec)} aria-valuenow={Math.round(cursor)} aria-valuetext={`${formatClock(cursor)} / ${formatClock(totalSec)}`} onClick={seekBar}>
              <span className="review-timeline-fill" style={{ width: `${totalSec ? Math.min(100, (cursor / totalSec) * 100) : 0}%` }} />
              {timeline ? lines.map((line, index) => {
                const item = timeline[index]; if (!item || !totalSec) return null;
                const tone = isMarked(line) ? 'mark' : isDrifted(line) ? 'drift' : staleIds.includes(line.id) ? 'remix' : null;
                return tone ? <span key={line.id} className={`timeline-marker is-${tone}`} style={{ left: `${(item.start / totalSec) * 100}%` }} aria-hidden="true" /> : null;
              }) : null}
            </div>
            <span className="playbar-time">{formatClock(cursor)} / {formatClock(totalSec)}</span>
          </div>
        </div>
        <div className="playbar-mix">
          <span className={`mix-status ${staleIds.length || headPending > 0 ? 'is-stale' : ''}`} aria-live="polite">{remixing ? <LoaderCircle size={13} className="spin" aria-hidden="true" /> : null}{mixStatus}</span>
          {staleIds.length || (!mix.mix && !remixing) ? <button type="button" className="button secondary-button" disabled={remixing || exportLocked} aria-describedby={exportLocked ? 'review-export-lock' : undefined} onClick={() => doRemix().catch(() => {})}><RefreshCw size={13} />重新混音</button> : null}
          {headPending > 0 && onFinishPending ? <button type="button" className="button secondary-button review-finish-pending" disabled={remixing || exportLocked} onClick={onFinishPending} title="打开一键成片：先把这些句子配好，再体检、导出整集">{finishPendingLabel(headPending)}</button> : null}
          <button type="button" className="button primary-button" disabled={!mix.mix || remixing || (exportLocked && exportState.phase !== 'running')} aria-describedby={exportLocked ? 'review-export-lock' : undefined} onClick={openExport}>{exportState.phase === 'running' ? <LoaderCircle size={13} className="spin" /> : <Download size={13} />}导出 mp3</button>
          {exportLocked ? <span id="review-export-lock" className="export-lock-note" role="status">{EXPORT_LOCK_TEXT}</span> : null}
        </div>
        {remixFailure ? <ExportFailure className="review-remix-failure" text={remixFailure.text} detail={remixFailure.detail} retryDisabled={remixing || exportLocked} onRetry={() => doRemix().catch(() => {})} onClose={() => setRemixFailure(null)} /> : null}
        <p className="playbar-keys muted" aria-hidden="true">空格 播放/暂停 · J/K 上一句/下一句 · M 标记</p>
      </div>

      {breezeMode && !breezeOnline ? (
        <div className="review-banner is-offline" role="status">
          <AlertTriangle size={14} aria-hidden="true" />
          <div><strong>{OFFLINE_REGEN}</strong>{breeze?.status?.detail ? <p>{breeze.status.detail}</p> : null}<p className="muted">Breeze 需要 Apple 芯片的 Mac，建议 24 GB 以上内存。</p></div>
          <button type="button" className="button ghost-button" disabled={breeze?.checking} onClick={() => breeze?.refresh?.()}>重新连接</button>
        </div>
      ) : null}
      {banner ? (
        <div className="review-banner is-drift" role="note">
          <AlertTriangle size={14} aria-hidden="true" />
          <p>{banner.text}</p>
          {filter !== 'drift' ? <button type="button" className="button ghost-button" onClick={() => setFilter('drift')}>{banner.action}</button> : null}
        </div>
      ) : null}

      <div className="review-body">
        <div className="review-list-column">
          <div className="review-filters" role="tablist" aria-label="筛选">
            {/* fe-0010：没有音色相似度数据（可能换人 0）就不显示这个筛选，免得一个「0」看着像查过了。 */}
            {[['all', '全部'], ['marked', '已标记'], ['drift', '可能换人']].filter(([key]) => key !== 'drift' || counts.drift > 0 || filter === 'drift').map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={filter === key} aria-controls="review-list" className={`filter-tab ${filter === key ? 'is-active' : ''}`} onClick={() => setFilter(key)}>{label} <span>{counts[key]}</span></button>
            ))}
          </div>
          <div id="review-list" ref={listRef} className="review-list" role="list" aria-label={`台词（${visible.length} 句）`} onScroll={onScroll}>
            {!visible.length && !lines.length && linesLoading ? <p className="review-list-loading" role="status"><LoaderCircle size={14} className="spin" aria-hidden="true" />{readingLinesText(expectedLineCount)}</p> : null}
            {!visible.length && !(linesLoading && !lines.length) ? <p className="review-list-empty muted">{filter === 'marked' ? '没有标记的句子。' : filter === 'drift' ? '没有可能换人的句子。' : '还没有台词。'}</p> : null}
            <div className="review-list-spacer" style={{ height: windowRange.total }}>
              {visible.slice(windowRange.start, windowRange.end).map((line, offset) => {
                const position = windowRange.start + offset;
                const index = indexOf.get(line.id);
                const item = timeline?.[index];
                const marked = isMarked(line); const drifted = isDrifted(line);
                const badges = lineBadges(line, { pendingTakeId: line.pendingTakeId, mixStaleIds: staleIds, job: jobs.jobs[line.id] });
                const playing = currentLine?.id === line.id && (episodePlaying || cursor > 0);
                return (
                  <div key={line.id} data-line-id={line.id} role="listitem" aria-setsize={visible.length} aria-posinset={position + 1}
                    className={`review-row ${selected?.id === line.id ? 'is-selected' : ''} ${playing ? 'is-playing' : ''} ${marked ? 'is-marked' : ''}`}
                    style={{ transform: `translateY(${position * rowHeight}px)` }}>
                    <button type="button" className="review-row-main" aria-current={playing ? 'true' : undefined} aria-label={lineAriaLabel(line, index, { start: item?.start, drifted, marked })}
                      onClick={() => { goTo(line); if (mobile) setSheetOpen(false); }}>
                      <span className="row-meta"><span className="row-number">{index + 1}</span><span>{item ? formatClock(item.start) : '—'}</span></span>
                      <span className="row-body">
                        <span className="row-speaker">{line.speaker || nameOf(line.speakerId)}{line.emotion ? <small> · {line.emotion}</small> : null}</span>
                        <span className="row-text">{line.text}</span>
                        {badges.length ? <span className="row-badges">{badges.map((badge) => <span key={badge.text} className={`row-badge is-${badge.tone}`} title={badge.title || undefined}>{badge.text}{badge.title ? <span className="sr-only">：{badge.title}</span> : null}</span>)}</span> : null}
                      </span>
                    </button>
                    <span className="row-actions">
                      <button type="button" className={`button ghost-button row-mark ${marked ? 'is-on' : ''}`} aria-pressed={marked} aria-label={marked ? `取消标记第 ${index + 1} 句` : `标记第 ${index + 1} 句`} onClick={() => toggleMark(line)}><Flag size={13} />{mobile ? '标记' : null}</button>
                      {mobile ? <button type="button" className="button ghost-button" aria-label={`修第 ${index + 1} 句`} onClick={() => { setSelectedId(line.id); setSheetOpen(true); }}><Wrench size={13} />修</button> : null}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
          {detached && episodePlaying ? <button type="button" className="button secondary-button review-back" onClick={backToCurrent}>回到正在播放的句子</button> : null}
        </div>
        {!mobile ? inspector : null}
      </div>

      {mobile && sheetOpen ? <div className="review-sheet-backdrop" onClick={() => setSheetOpen(false)} aria-hidden="true" /> : null}
      {mobile && sheetOpen ? <div className="review-sheet" role="dialog" aria-modal="false" aria-label={`修第 ${selectedIndex + 1} 句`}>{inspector}</div> : null}

      {regenConfirm ? (
        <ModalShell title={`重新生成第 ${(indexOf.get(regenConfirm.line.id) ?? 0) + 1} 句`} onClose={() => setRegenConfirm(null)} className="regen-confirm">
          <p>{regenConfirm.text}</p>
          <div className="dialog-actions">
            <button type="button" className="button secondary-button" onClick={() => setRegenConfirm(null)}>不生成了</button>
            <button type="button" className="button primary-button" onClick={() => { const { line } = regenConfirm; setRegenConfirm(null); runRegen(line); }}>仍然重新生成</button>
          </div>
        </ModalShell>
      ) : null}
      <p className="sr-only" aria-live="polite">{announce}</p>
      <ReviewToast toast={toast} onHide={hideToast} />
      {exportState.open ? (
        <ReviewExportDialog
          episodeLabel={project.name || project.title || '本集'} phase={exportState.phase} mixStale={staleIds.length > 0} markedCount={issueCount} driftCount={0}
          sfxUnbound={sfxUnbound} breeze={breezeNote} progress={exportState.progress} message={exportState.message} result={exportState.result} error={exportState.error} failure={exportState.failure || null}
          precheck={precheck} locked={exportLocked} onStart={startExport} onFixStale={onRegenerateLines ? fixStale : null}
          onRegenerateLines={onRegenerateLines ? (ids) => { setExportState((current) => ({ ...current, open: false })); onRegenerateLines(ids); } : null}
          onLocateLine={(item) => { setExportState((current) => ({ ...current, open: false })); setFilter('all'); goTo(lines.find((line) => line.id === item.lineId)); }}
          onReview={() => { setExportState((current) => ({ ...current, open: false })); setFilter(counts.marked ? 'marked' : 'drift'); }}
          onClose={() => setExportState((current) => ({ ...current, open: false }))}
        />
      ) : null}
    </section>
  );
}

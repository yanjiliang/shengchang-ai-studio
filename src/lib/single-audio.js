// 全局只有一个 Audio：开始播放新的会停掉旧的（声音设计、审听修句共用）。
// 切换角色、标签页、打开对话框时调用 stop()。订阅者拿到 { id, playing, currentTime, duration }。
let audio = null;
let state = { id: null, playing: false, currentTime: 0, duration: 0 };
let queue = [];
let segment = null; // { from, to }：只播一段（A/B 带上一句结尾、从整集里切出原版）
const listeners = new Set();
const emit = (patch) => { state = { ...state, ...patch }; for (const listener of listeners) listener(state); };

function element() {
  if (audio || typeof Audio === 'undefined') return audio;
  audio = new Audio();
  audio.preload = 'auto';
  audio.addEventListener('timeupdate', () => {
    emit({ currentTime: audio.currentTime, duration: Number.isFinite(audio.duration) ? audio.duration : 0 });
    if (segment && Number.isFinite(segment.to) && audio.currentTime >= segment.to) finish();
  });
  audio.addEventListener('ended', finish);
  audio.addEventListener('pause', () => { if (!audio.ended) emit({ playing: false }); });
  audio.addEventListener('error', () => emit({ playing: false, error: '这段音频无法播放' }));
  return audio;
}

function finish() {
  const next = queue.shift();
  if (next) { start(next); return; }
  segment = null; audio.pause(); emit({ playing: false, currentTime: 0, ended: true });
}

function start({ id, url, onStart, from, to }) {
  const el = element(); if (!el) return Promise.resolve();
  el.pause();
  // 页面上其他 <audio>（播放条、预混试听）也停掉，保证同时只有一段在响。
  if (typeof document !== 'undefined') for (const other of document.querySelectorAll('audio')) other.pause();
  segment = Number.isFinite(from) || Number.isFinite(to) ? { from: from || 0, to } : null;
  if (el.getAttribute('src') !== url) el.src = url;
  el.currentTime = segment?.from || 0;
  emit({ id, playing: true, currentTime: segment?.from || 0, duration: 0, error: '', ended: false });
  onStart?.(id);
  return el.play().catch((error) => { if (error?.name !== 'AbortError') emit({ playing: false, error: '这段音频无法播放' }); });
}

export const singleAudio = {
  // 播放一段；同一个 id 正在播放时再点 = 暂停。
  toggle(id, url) {
    if (state.id === id && state.playing) { this.stop(); return Promise.resolve(); }
    queue = [];
    return start({ id, url });
  },
  // 连着听（先候选再对方 / 整集连续播放）。items: [{ id, url, onStart }]
  playSequence(items) {
    const list = items.filter((item) => item?.url);
    if (!list.length) return Promise.resolve();
    queue = list.slice(1);
    return start(list[0]);
  },
  // 整集播放：从 sec 开始（同一个 id + url 只跳转，不重新加载）。
  playAt(id, url, sec = 0) {
    const el = element(); if (!el) return Promise.resolve();
    queue = []; segment = null;
    if (typeof document !== 'undefined') for (const other of document.querySelectorAll('audio')) if (other !== el) other.pause();
    if (el.getAttribute('src') !== url) el.src = url;
    el.currentTime = Math.max(0, sec);
    emit({ id, playing: true, currentTime: sec, error: '', ended: false });
    return el.play().catch((error) => { if (error?.name !== 'AbortError') emit({ playing: false, error: '这段音频无法播放' }); });
  },
  // 暂停但保留位置（整集播放条）。
  pause() { if (audio) audio.pause(); emit({ playing: false }); },
  seek(sec) { if (audio) audio.currentTime = Math.max(0, sec); emit({ currentTime: sec }); },
  stop() { segment = null; queue = []; if (audio) { audio.pause(); } emit({ playing: false, currentTime: 0 }); },
  subscribe(listener) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
  get state() { return state; },
};

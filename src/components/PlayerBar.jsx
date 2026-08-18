import { Download, ListMusic, Pause, Play, RotateCcw, RotateCw, SlidersHorizontal, Volume2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '00:00';
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

export function PlayerBar({ scene, requestedLineId, reviewToken, onOpenMix, onExport, exporting }) {
  const audioRef = useRef(null);
  const clips = useMemo(() => scene.lines.filter((line) => line.audioUrl), [scene.lines]);
  const [clipIndex, setClipIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const activeClip = clips[clipIndex];

  useEffect(() => { setClipIndex(0); setPlaying(false); setCurrentTime(0); }, [scene.id]);
  useEffect(() => {
    if (!requestedLineId) return;
    const index = clips.findIndex((clip) => clip.id === requestedLineId);
    if (index >= 0) { setClipIndex(index); setPlaying(true); }
  }, [requestedLineId, clips]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !activeClip) return;
    audio.load(); setCurrentTime(0); setDuration(0);
  }, [activeClip?.audioUrl]);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !activeClip) return;
    if (playing) audio.play().catch(() => setPlaying(false)); else audio.pause();
  }, [playing, activeClip]);
  useEffect(() => {
    if (!reviewToken || !clips.length) return;
    setClipIndex(0); setPlaying(true);
  }, [reviewToken, clips.length]);

  const seekBy = (seconds) => {
    const audio = audioRef.current;
    if (audio) audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + seconds));
  };
  const handleEnded = () => {
    if (clipIndex < clips.length - 1) setClipIndex((index) => index + 1);
    else setPlaying(false);
  };
  const togglePlayback = () => {
    if (!activeClip) return;
    setPlaying((value) => !value);
  };

  return (
    <footer className="player-bar">
      <audio ref={audioRef} src={activeClip?.audioUrl || undefined} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onDurationChange={(event) => setDuration(event.currentTarget.duration)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={handleEnded} />
      <div className="now-playing"><div className="cover-art"><span>{scene.number}</span></div><div className="now-copy"><strong>{activeClip ? `${activeClip.speaker} · ${scene.title}` : scene.title}</strong><span>{clips.length ? `${clipIndex + 1} / ${clips.length} 个对白片段` : '生成场景后可审听真实音频'}</span></div></div>
      <div className="transport">
        <button type="button" aria-label="后退 10 秒" title="后退 10 秒" onClick={() => seekBy(-10)}><RotateCcw size={17} /></button>
        <button className="main-play" type="button" aria-label={playing ? '暂停' : '播放'} disabled={!activeClip} onClick={togglePlayback}>{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}</button>
        <button type="button" aria-label="前进 10 秒" title="前进 10 秒" onClick={() => seekBy(10)}><RotateCw size={17} /></button>
        <span className="player-time">{formatTime(currentTime)}</span>
        <button className="progress-track" type="button" aria-label="播放进度" disabled={!activeClip} onClick={(event) => { const audio = audioRef.current; if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return; const rect = event.currentTarget.getBoundingClientRect(); const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)); audio.currentTime = ratio * audio.duration; }}><span style={{ width: `${duration ? (currentTime / duration) * 100 : 0}%` }} /></button>
        <span className="player-time">{formatTime(duration)}</span>
      </div>
      <div className="player-tools"><span className="mix-tag">-16 LUFS</span><button type="button" aria-label="音量" title="音量"><Volume2 size={17} /></button><button type="button" aria-label="播放队列" title="播放队列"><ListMusic size={17} /></button><button type="button" aria-label="混音设置" title="混音设置" onClick={onOpenMix}><SlidersHorizontal size={17} /></button><button type="button" aria-label="导出本场" title="导出本场" disabled={!clips.length || exporting} onClick={onExport}><Download size={17} /></button></div>
    </footer>
  );
}

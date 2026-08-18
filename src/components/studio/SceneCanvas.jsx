import { FileStack, MessageSquarePlus, Music2, Plus, Volume2, WandSparkles, X, Zap } from 'lucide-react';
import { useState } from 'react';
import { ScriptLine } from './ScriptLine';

function formatMs(milliseconds) {
  const seconds = Math.max(0, Math.round((milliseconds || 0) / 1000));
  return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`;
}

export function SceneCanvas({ scene, durationMs, sourceText, characters, selectedLineId, onSelectLine, onUpdateLine, onRegenerate, onPlayLine, onAddLine, onDeleteLine, generationProgress, generationMessage, onCancelTask }) {
  const [showSource, setShowSource] = useState(false);
  return (
    <main className="scene-canvas">
      <header className="scene-header">
        <div className="scene-heading-copy">
          <div className="scene-location">场景 {scene.number} · {scene.location}</div>
          <div className="scene-title-row"><h2>{scene.title}</h2></div>
          <p>{scene.synopsis}</p>
          <div className="scene-meta-row"><span>气氛：{scene.mood}</span><span>{durationMs ? `对白时长 ${formatMs(durationMs)}` : `预计 ${scene.duration}`}</span></div>
        </div>
        <div className="emotion-arc" aria-label="场景情绪曲线">
          <div className="arc-copy"><span>克制</span><strong>情绪曲线</strong><span>对峙</span></div>
          <div className="arc-bars">
            {scene.arc.map((height, index) => <i key={`${height}-${index}`} className={index > scene.arc.length / 2 - 2 && index < scene.arc.length - 2 ? 'is-peak' : ''} style={{ height }} />)}
          </div>
        </div>
      </header>
      {generationProgress !== null ? (
        <div className="generation-banner">
          <WandSparkles size={17} />
          <div><strong>正在生成场景声音</strong><span>{generationMessage || '正在提交到本地模型网关'}</span></div>
          <div className="generation-progress"><span style={{ width: `${generationProgress}%` }} /></div>
          <b>{generationProgress}%</b>
          <button className="cancel-task-button" type="button" aria-label="取消当前任务" title="取消任务" onClick={onCancelTask}><X size={14} /></button>
        </div>
      ) : null}
      <div className="script-toolbar">
        <div><FileStack size={14} /><span>声音场景流</span><b>{scene.lines.length} 个事件</b></div>
        <button type="button" disabled={!sourceText} onClick={() => setShowSource(true)}>查看小说原文</button>
      </div>
      <section className="script-flow" aria-label="场景声音事件">
        {scene.lines.map((line) => (
          <ScriptLine
            key={line.id}
            line={line}
            character={characters.find((item) => item.id === line.speakerId)}
            selected={line.id === selectedLineId}
            onSelect={() => onSelectLine(line.id)}
            onTextChange={(text) => onUpdateLine(line.id, { text })}
            onRegenerate={() => onRegenerate(line)}
            onPlay={() => onPlayLine(line)}
            onDelete={() => onDeleteLine(line.id)}
          />
        ))}
        <div className="insert-event" aria-label="添加声音事件"><span><Plus size={13} />添加</span><button type="button" onClick={() => onAddLine('dialogue')}><MessageSquarePlus size={13} />对白</button><button type="button" onClick={() => onAddLine('ambient')}><Volume2 size={13} />环境声</button><button type="button" onClick={() => onAddLine('sfx')}><Zap size={13} />音效</button><button type="button" onClick={() => onAddLine('music')}><Music2 size={13} />音乐</button></div>
      </section>
      {showSource ? <div className="source-dialog-backdrop" role="presentation" onMouseDown={() => setShowSource(false)}><section className="source-dialog" role="dialog" aria-modal="true" aria-label="小说原文" onMouseDown={(event) => event.stopPropagation()}><header><div><strong>小说原文</strong><span>{sourceText.length.toLocaleString()} 字符</span></div><button type="button" aria-label="关闭原文" onClick={() => setShowSource(false)}><X size={16} /></button></header><pre>{sourceText}</pre></section></div> : null}
    </main>
  );
}

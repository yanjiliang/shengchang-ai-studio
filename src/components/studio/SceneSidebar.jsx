import { Check, Circle, Plus, Sparkles, Trash2 } from 'lucide-react';

function isSceneGenerated(scene) {
  const dialogue = scene.lines?.filter((line) => line.type === 'dialogue') || [];
  return dialogue.length > 0 && dialogue.every((line) => Boolean(line.audioUrl));
}

function SceneState({ scene }) {
  if (isSceneGenerated(scene)) return <Check size={12} className="state-ready" aria-label="已生成" />;
  const status = scene.status;
  if (status === 'draft') return <Sparkles size={12} className="state-draft" aria-label="有改动" />;
  return <Circle size={9} className="state-pending" aria-label="待生成" />;
}

function formatMs(milliseconds) {
  const seconds = Math.max(0, Math.round((milliseconds || 0) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function SceneSidebar({ project, scenes, currentSceneId, mediaReport, onSceneChange, onImportNovel, onAddScene, onDeleteScene }) {
  const generatedCount = scenes.filter(isSceneGenerated).length;
  const probedDuration = (sceneId) => mediaReport?.scenes?.find((item) => item.sceneId === sceneId)?.durationMs || 0;
  return (
    <aside className="scene-sidebar">
      <section className="project-summary">
        <div className="sidebar-eyebrow">当前作品</div>
        <div className="project-heading">
          <div>
            <h1>{project.name}</h1>
            <p>{project.genre || '未分类'} · {scenes.length} 个场景</p>
            {project.state?.breakdown === 'heuristic' ? <p className="breakdown-note">规则拆解 · 建议人工校对</p> : null}
          </div>
        </div>
        <div className="project-progress"><span style={{ width: `${scenes.length ? (generatedCount / scenes.length) * 100 : 0}%` }} /></div>
        <div className="progress-copy"><span>{generatedCount} / {scenes.length} 场已生成</span><span>{project.sourceFilename || '未导入原文'}</span></div>
      </section>
      <div className="episode-row">
        <div>场景列表 <span>{project.name}</span></div>
        <strong>{scenes.length}</strong>
      </div>
      <div className="scene-list">
        {scenes.map((scene) => {
          const probed = probedDuration(scene.id);
          return (
          <div className={`scene-row-wrap ${scene.id === currentSceneId ? 'is-selected' : ''}`} key={scene.id}>
            <button
              className={`scene-row ${scene.id === currentSceneId ? 'is-selected' : ''}`}
              type="button"
              onClick={() => onSceneChange(scene.id)}
            >
              <span className="scene-number">{scene.number}</span>
              <span className="scene-copy"><strong>{scene.title}</strong><small>{scene.cast}</small></span>
              <span className="scene-duration">{probed ? formatMs(probed) : scene.duration}</span>
              <SceneState scene={scene} />
            </button>
            <button className="scene-delete" type="button" aria-label={`删除场景${scene.title}`} title="删除场景" onClick={() => onDeleteScene(scene.id)}><Trash2 size={13} /></button>
          </div>
          );
        })}
      </div>
      <button className="add-scene-button" type="button" onClick={onAddScene}><Plus size={14} />新建空场景</button>
      <button className="add-scene-button" type="button" onClick={onImportNovel}><Plus size={14} />导入或重新拆解小说</button>
      <div className="sidebar-footer-note"><span>小说原文</span><strong>{project.sourceFilename || '尚未导入'}</strong></div>
    </aside>
  );
}

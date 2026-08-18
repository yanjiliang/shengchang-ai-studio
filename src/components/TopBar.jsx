import { Check, ChevronDown, CloudCheck, FileUp, FolderPlus, Play, Sparkles } from 'lucide-react';
import { useState } from 'react';

const titles = {
  studio: ['场景制作', '导演工作台'],
  voices: ['作品资产', '角色音色'],
  sounds: ['作品资产', '声音素材'],
  production: ['成片制作', '制作中心'],
  quality: ['制作检查', '质量审听'],
  settings: ['个人工作区', '生成设置'],
};

export function TopBar({ view, project, currentScene, projects, onSelectProject, onCreateProject, onGenerate, onReview, onImportNovel, generating, canReview }) {
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [defaultGroup, defaultTitle] = titles[view] || titles.studio;
  const group = view === 'studio' ? currentScene?.number ? `场景 ${currentScene.number}` : defaultGroup : defaultGroup;
  const title = view === 'studio' ? currentScene?.title || defaultTitle : defaultTitle;
  return (
    <header className="topbar">
      <button className="project-switcher" type="button" aria-expanded={projectsOpen} onClick={() => setProjectsOpen((value) => !value)}>
        <span className="project-name">{project?.name || '选择作品'}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {projectsOpen ? <div className="project-menu"><div className="project-menu-title">本地作品</div>{projects.map((item) => <button type="button" key={item.id} onClick={() => { onSelectProject(item.id); setProjectsOpen(false); }}><span><strong>{item.name}</strong><small>{item.sceneCount} 个场景 · {item.genre || '未分类'}</small></span>{item.id === project?.id ? <Check size={14} /> : null}</button>)}<button className="new-project-menu-item" type="button" onClick={() => { onCreateProject(); setProjectsOpen(false); }}><FolderPlus size={15} />新建作品</button></div> : null}
      <span className="crumb-separator">/</span>
      <span className="top-crumb">{group}</span>
      <span className="crumb-separator">/</span>
      <strong className="top-title">{title}</strong>
      <div className="save-state"><CloudCheck size={14} aria-hidden="true" />已保存至本地</div>
      <div className="topbar-spacer" />
      {view === 'studio' ? <button className="button secondary-button top-action import-novel-button" type="button" onClick={onImportNovel}><FileUp size={15} />导入小说</button> : null}
      {view === 'studio' ? (
        <>
          <button className="button secondary-button top-action" type="button" disabled={!canReview} onClick={onReview}>
            <Play size={15} fill="currentColor" aria-hidden="true" />审听整场
          </button>
          <button className="button primary-button top-action" type="button" disabled={generating} onClick={onGenerate}>
            <Sparkles size={15} aria-hidden="true" />{generating ? '生成中' : '生成本场'}
          </button>
        </>
      ) : null}
    </header>
  );
}

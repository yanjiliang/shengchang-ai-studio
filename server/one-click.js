// 一键成片 orchestrator (design doc B3). One persistent task walks five
// in-process stages; after each stage the checkpoint list is merged into the
// task payload so a crash, cancel, or retry resumes from the last completed
// stage instead of re-paying for finished work.
//
//   queued ─▶ 拆解 ─▶ 音色 ─▶ 生成 ─▶ 体检 ─▶ 导出 ─▶ completed
//              │       │       │       │       │
//              └───────┴───────┴───┬───┴───────┘
//                                failed（completedStages 已落盘）
//                                  │ retryTask / 服务重启恢复
//                                  ▼
//                       queued（带 completedStages）→ 跳过已完成阶段
//
// The orchestrator NEVER enqueues child tasks: MAX_CONCURRENCY = 2 means
// enqueue-and-wait would burn a worker slot for the whole run (eng-review A1).
// Stage functions are called directly, reusing runGenerationRequests and
// analyzeNovel in-process.
import { buildGenerationRequests } from '../shared/generation-requests.mjs';
import { getPersistentTask, getProject, updatePersistentTask, updateProject } from './database.js';
import { exportProjectTimeline, inspectProjectMedia } from './media-store.js';
import { analyzeNovel } from './story-analyzer.js';
import { applyResultsToProject, runGenerationRequests } from './task-manager.js';

// Preset roster (design OQ1: hardcoded known-good voices, simple > clever).
// Demo accepts any voice id (pitch derives from the string). The 豆包 ids are
// best-effort public official voices - users can remap any character on the
// 角色音色 page; presets only ever fill UNMAPPED characters.
const PRESET_VOICES = {
  demo: { narrator: 'demo_narrator_warm', cast: ['demo_female_1', 'demo_male_1', 'demo_female_2', 'demo_male_2', 'demo_elder_1', 'demo_youth_1'] },
  'volcengine-api-key': {
    narrator: 'zh_female_cancan_mars_bigtts',
    cast: ['zh_male_chunhui_mars_bigtts', 'zh_female_wanwanxiaohe_mars_bigtts', 'zh_male_shaun_mars_bigtts', 'zh_female_tianmeiyueyue_mars_bigtts', 'zh_male_dongchanghong_mars_bigtts', 'zh_female_nuanxinyuan_mars_bigtts'],
  },
};

// Pure, exported for unit tests. Fills ONLY unmapped characters - a user's
// voice choice is never overwritten by automation (design stage 2).
export function mapCharactersToPresets(characters, voiceMap, provider) {
  const presets = PRESET_VOICES[provider] || PRESET_VOICES.demo;
  const assignments = {};
  let castIndex = 0;
  for (const character of characters || []) {
    if (!character?.id || voiceMap?.[character.id]) continue;
    const isNarrator = character.id === 'narrator' || character.role === '叙事者' || character.name === '旁白';
    assignments[character.id] = isNarrator ? presets.narrator : presets.cast[castIndex++ % presets.cast.length];
  }
  return assignments;
}

function cancelledError() {
  const error = new Error('一键成片已取消');
  error.code = 'TASK_CANCELLED';
  return error;
}

export async function runOneClickPipeline(task, config, deps = {}) {
  const { runGeneration = runGenerationRequests, analyze = analyzeNovel, exportTimeline = exportProjectTimeline, inspectMedia = inspectProjectMedia } = deps;
  const completedStages = [...task.payload.completedStages || []];
  const done = (stage) => {
    completedStages.push(stage);
    updatePersistentTask(task.id, { payload: { completedStages } });
  };
  const shouldCancel = () => Boolean(getPersistentTask(task.id)?.cancelRequested);
  const progress = (value, message) => updatePersistentTask(task.id, { progress: Math.min(99, value), message });
  const skip = (stage) => completedStages.includes(stage);

  // Stage 1: 拆解 - in-process novel breakdown when the project has no scenes.
  if (!skip('拆解')) {
    const project = getProject(task.projectId);
    if (!project) throw new Error('一键成片目标项目不存在');
    if (project.state.scenes?.length) done('拆解');
    else {
      if (!project.sourceText?.trim()) throw new Error('项目既没有场景也没有小说原文，无法拆解');
      progress(8, '拆解 · 正在理解人物与场景结构');
      const analyzed = await analyze(config, { text: project.sourceText, filename: project.sourceFilename || 'novel.txt', name: project.name }, {
        onProgress: ({ current, total, progress: percent }) => progress(8 + Math.round(percent * 0.2), `拆解 · 原文 ${current} / ${total} 段`),
        shouldCancel,
      });
      if (shouldCancel()) throw cancelledError();
      updateProject(task.projectId, { name: analyzed.name, genre: analyzed.genre, trustedAudio: true, state: { ...project.state, characters: analyzed.characters, scenes: analyzed.scenes, assets: project.state.assets || [], breakdown: analyzed.breakdown } });
      done('拆解');
    }
  }

  // Stage 2: 音色 - auto-map unmapped characters to preset voices.
  if (!skip('音色')) {
    const project = getProject(task.projectId);
    const assignments = mapCharactersToPresets(project?.state?.characters, project?.state?.voiceMap, config.provider);
    const count = Object.keys(assignments).length;
    if (count) {
      progress(31, `音色 · 自动映射 ${count} 个角色（预设音色，可在角色音色页修改）`);
      updateProject(task.projectId, { trustedAudio: true, state: { ...project.state, voiceMap: { ...project.state.voiceMap, ...assignments } } });
    }
    done('音色');
  }

  // Stage 3: 生成 - rebuild the missing-line list from live project state,
  // then run the shared per-request pipeline scene by scene. Requests without
  // a voiceId are skipped and reported in the attention list rather than
  // burning a doomed synthesis call.
  if (!skip('生成')) {
    const project = getProject(task.projectId);
    const state = project.state;
    const allRequests = buildGenerationRequests(state);
    const requests = allRequests.filter((request) => request.voiceId);
    const unmapped = allRequests.length - requests.length;
    const results = [];
    let processed = 0;
    const byScene = new Map();
    for (const request of requests) {
      if (!byScene.has(request.sceneId)) byScene.set(request.sceneId, []);
      byScene.get(request.sceneId).push(request);
    }
    for (const [sceneId, sceneRequests] of byScene) {
      if (shouldCancel()) throw cancelledError();
      const scene = state.scenes.find((item) => item.id === sceneId);
      const outcome = await runGeneration(config, sceneRequests, {
        projectId: task.projectId,
        sceneId,
        onProgress: ({ index, total, message }) => progress(35 + Math.round(((processed + index) / Math.max(1, requests.length)) * 45), `生成 · ${scene?.title || '场景'} · ${message}`),
        shouldCancel,
      });
      if (outcome.status === 'cancelled') throw cancelledError();
      results.push(...outcome.results);
      if (outcome.failures.length) {
        // Successful lines (this scene AND earlier scenes) are applied so a
        // retry only pays for the failures; the stage checkpoint is
        // intentionally NOT written.
        applyResultsToProject(task.projectId, '', results);
        throw new Error(`生成阶段有 ${outcome.failures.length} 句失败（${outcome.failures[0].error}）；已完成的句子已写入项目，重试将只补缺失句${unmapped ? `，另有 ${unmapped} 句因角色未绑定音色被跳过` : ''}`);
      }
      processed += sceneRequests.length;
    }
    applyResultsToProject(task.projectId, '', results);
    done('生成');
  }

  // Stage 4: 体检 - media health report feeds the attention list.
  if (!skip('体检')) {
    if (shouldCancel()) throw cancelledError();
    progress(82, '体检 · 正在检查音频文件健康');
    await inspectMedia(getProject(task.projectId));
    done('体检');
  }

  // Stage 5: 导出 - render the episode; the completion message carries the
  // URL plus a plain-text attention list for everything automation could not
  // finish (missing voices, stale lines, invalid files).
  if (!skip('导出')) {
    progress(86, '导出 · 正在渲染整集');
    const project = getProject(task.projectId);
    const media = await inspectMedia(project);
    const report = await exportTimeline({
      project: getProject(task.projectId), targetLufs: config.targetLufs,
      shouldCancel, onProgress: ({ progress: percent, message }) => progress(86 + Math.round(percent * 0.13), `导出 · ${message}`),
    });
    const attention = buildAttentionList(getProject(task.projectId), media);
    const attentionNote = attention.length ? `\n需注意：\n${attention.join('\n')}` : '';
    done('导出');
    updatePersistentTask(task.id, {
      status: 'completed', progress: 100, completedAt: Date.now(),
      message: `一键成片完成：${report.sceneCount} 个场景已导出${attention.length ? `，${attention.length} 项待处理` : ''}${attentionNote}`,
      result: { url: report.url, name: report.name, sceneCount: report.sceneCount, durationMs: report.durationMs, attention, stages: completedStages },
    });
  }
}

function buildAttentionList(project, mediaReport) {
  const attention = [];
  const state = project.state;
  const speakers = [...new Set((state.scenes || []).flatMap((scene) => (scene.lines || []).filter((line) => line.type === 'dialogue' && line.speakerId).map((line) => line.speakerId)))];
  const unmappedVoices = speakers.filter((id) => !state.voiceMap?.[id]);
  if (unmappedVoices.length) attention.push(`${unmappedVoices.length} 个角色未绑定音色（相关台词未生成）`);
  const stale = (state.scenes || []).flatMap((scene) => (scene.lines || []).filter((line) => line.audioUrl && line.audioStale));
  if (stale.length) attention.push(`${stale.length} 句台词改动后音频过期，进入成片的是旧音频`);
  const missing = (state.scenes || []).flatMap((scene) => (scene.lines || []).filter((line) => line.type === 'dialogue' && !line.audioUrl));
  if (missing.length) attention.push(`${missing.length} 句对白没有音频，未进入成片`);
  const invalid = mediaReport?.scenes?.reduce((sum, scene) => sum + (scene.invalidFileCount || 0), 0);
  if (invalid) attention.push(`${invalid} 个音频文件无法解码，请重新生成或重新绑定`);
  return attention;
}

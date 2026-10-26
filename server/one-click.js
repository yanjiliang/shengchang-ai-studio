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
import { voiceDirectability } from './directable-voices.js';
import { buildGenerationRequests } from '../shared/generation-requests.mjs';
import { getPersistentTask, getProject, updatePersistentTask, updateProject } from './database.js';
import { exportProjectTimeline, inspectProjectMedia } from './media-store.js';
import { analyzeNovel } from './story-analyzer.js';
import { applyResultsToProject, runGenerationRequests, sumBilledCharacters } from './task-manager.js';

// Preset roster (design OQ1: hardcoded known-good voices, simple > clever).
// Demo accepts any voice id (pitch derives from the string). 豆包预设按
// resourceId 分组：音色代际必须和模型匹配（1.0 的 *_mars_bigtts 不能用于
// seed-tts-2.0）。seed-tts-2.0 的 id 取自豆包语音合成 2.0 公开音色列表
// （标注“指令遵循”）；后续换成经复测确认的白名单时只改这张表。
// seed-icl-2.0 是用户自己的克隆音色，没有通用预设，留空 = 不自动映射。
// Users can remap any character on the 角色音色 page; presets only ever fill
// UNMAPPED characters.
const PRESET_VOICES = {
  demo: { narrator: 'demo_narrator_warm', cast: ['demo_female_1', 'demo_male_1', 'demo_female_2', 'demo_male_2', 'demo_elder_1', 'demo_youth_1'] },
  'volcengine-api-key': {
    'seed-tts-2.0': {
      narrator: 'zh_female_cancan_uranus_bigtts', // 知性灿灿 2.0
      cast: [
        'zh_female_vv_uranus_bigtts', // Vivi 2.0（实测可导戏）
        'zh_male_ruyayichen_uranus_bigtts', // 儒雅逸辰 2.0
        'zh_male_qingcang_uranus_bigtts', // 擎苍 2.0
        'zh_female_gufengshaoyu_uranus_bigtts', // 古风少御 2.0
        'zh_male_m191_uranus_bigtts', // 云舟 2.0
        'zh_female_popo_uranus_bigtts', // 婆婆 2.0
      ],
    },
    'seed-icl-2.0': null,
  },
};

// 角色轮换时实测可导戏的音色排前面（第一个非旁白角色通常是主角），
// 实测不可导戏的排最后；未验证的保持原顺序。旁白不需要强导戏，不参与排序。
const DIRECTABILITY_RANK = { true: 0, null: 1, false: 2 };

export function presetVoicesFor(provider, resourceId) {
  const presets = provider === 'volcengine-api-key'
    ? PRESET_VOICES['volcengine-api-key'][resourceId] ?? null
    : PRESET_VOICES[provider] || PRESET_VOICES.demo;
  if (!presets || provider !== 'volcengine-api-key') return presets;
  const cast = presets.cast
    .map((voiceId, index) => ({ voiceId, index, rank: DIRECTABILITY_RANK[String(voiceDirectability(voiceId))] }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.voiceId);
  return { ...presets, cast };
}

// Pure, exported for unit tests. Fills ONLY unmapped characters - a user's
// voice choice is never overwritten by automation (design stage 2).
export function mapCharactersToPresets(characters, voiceMap, provider, resourceId) {
  const presets = presetVoicesFor(provider, resourceId);
  const assignments = {};
  if (!presets) return assignments;
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
    const assignments = mapCharactersToPresets(project?.state?.characters, project?.state?.voiceMap, config.provider, config.resourceId);
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
    // 本集累计计费字数：存进 payload（浅合并），失败重试时累加而不是覆盖，
    // 因为失败那一轮已经付过费的句子在重试时走缓存、不会再返回 usage。
    const recordBilled = (sceneResults) => {
      const billed = sumBilledCharacters(sceneResults);
      if (billed === null) return;
      const prior = getPersistentTask(task.id)?.payload?.billedCharacters || 0;
      updatePersistentTask(task.id, { payload: { billedCharacters: prior + billed } });
    };
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
      recordBilled(outcome.results);
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
      result: { url: report.url, name: report.name, sceneCount: report.sceneCount, durationMs: report.durationMs, attention, stages: completedStages, billedCharacters: getPersistentTask(task.id)?.payload?.billedCharacters ?? null },
    });
  }
}

// 只标记豆包 2.0 官方音色（*_uranus_bigtts）；demo / 克隆音色不适用这张白名单。
export function flagUndirectableVoices(voiceMap, characterIds) {
  return (characterIds || Object.keys(voiceMap || {}))
    .map((characterId) => ({ characterId, voiceId: voiceMap?.[characterId] }))
    .filter((item) => /_uranus_bigtts$/.test(item.voiceId || '') && voiceDirectability(item.voiceId) !== true)
    .map((item) => ({ ...item, directable: voiceDirectability(item.voiceId) }));
}

function buildAttentionList(project, mediaReport) {
  const attention = [];
  const state = project.state;
  const speakers = [...new Set((state.scenes || []).flatMap((scene) => (scene.lines || []).filter((line) => line.type === 'dialogue' && line.speakerId).map((line) => line.speakerId)))];
  const unmappedVoices = speakers.filter((id) => !state.voiceMap?.[id]);
  if (unmappedVoices.length) attention.push(`${unmappedVoices.length} 个角色未绑定音色（相关台词未生成）`);
  const notDirectable = flagUndirectableVoices(state.voiceMap, speakers);
  if (notDirectable.length) attention.push(`${notDirectable.length} 个角色的音色未确认可导戏（情绪/节奏指令可能不生效）：${notDirectable.map((item) => `${item.characterId}=${item.voiceId}${item.directable === false ? '（实测不可导戏）' : '（未验证）'}`).join('、')}`);
  const stale = (state.scenes || []).flatMap((scene) => (scene.lines || []).filter((line) => line.audioUrl && line.audioStale));
  if (stale.length) attention.push(`${stale.length} 句台词改动后音频过期，进入成片的是旧音频`);
  const missing = (state.scenes || []).flatMap((scene) => (scene.lines || []).filter((line) => line.type === 'dialogue' && !line.audioUrl));
  if (missing.length) attention.push(`${missing.length} 句对白没有音频，未进入成片`);
  const invalid = mediaReport?.scenes?.reduce((sum, scene) => sum + (scene.invalidFileCount || 0), 0);
  if (invalid) attention.push(`${invalid} 个音频文件无法解码，请重新生成或重新绑定`);
  return attention;
}

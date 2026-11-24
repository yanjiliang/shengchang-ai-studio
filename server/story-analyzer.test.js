import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeNovel, resolveScenePlans, splitNovel } from './story-analyzer.js';

const LLM_CONFIG = { llmEndpoint: 'http://llm.local', llmApiKey: 'k', llmModel: 'm' };

test('分块：单换行分段的小说在段落边界切分', () => {
  const paragraphs = Array.from({ length: 200 }, (_unused, index) => `第${index + 1}段。${'叙述文字。'.repeat(20)}`);
  const chunks = splitNovel(paragraphs.join('\n'), 1000);
  assert.ok(chunks.length > 1, '应切分为多块');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1000, `块不应超长: ${chunk.length}`);
    assert.ok(/。$/.test(chunk), '块应在段落边界结束，不应从句子中间断开');
  }
});

test('分块：换行结构在块内保留', () => {
  const chunks = splitNovel('第一段。\n\n第二段。', 1000);
  assert.deepEqual(chunks, ['第一段。\n\n第二段。']);
});

test('未配置文本模型：导入直接报错，不再退回规则拆解', async () => {
  await assert.rejects(
    () => analyzeNovel({}, { text: '雨下了整夜。', filename: 'demo.txt' }, {}),
    (error) => error.code === 'LLM_CONFIG_INVALID' && error.status === 400,
  );
});

test('文本模型超时：不自动重试，直接失败', async () => {
  const aborted = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  let calls = 0;
  await assert.rejects(
    () => analyzeNovel(LLM_CONFIG, { text: '雨下了整夜。', filename: 'n.txt' }, {
      retryDelayMs: 1,
      call: async () => { calls += 1; throw aborted; },
    }),
    /aborted/,
  );
  assert.equal(calls, 1, '超时不应再自动重试一次');
});

test('seedCharacters：后续分块沿用已有角色表', async () => {
  const prompts = [];
  await analyzeNovel(LLM_CONFIG, {
    text: '雨下了整夜。',
    filename: 'n.txt',
    seedCharacters: [{ id: 'tangseng', name: '唐僧', role: '师父' }],
  }, {
    call: async (_config, prompt) => {
      prompts.push(prompt);
      return { project: { genre: '' }, characters: [], scenes: [{ title: '场景', lines: [{ type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text: '台词' }] }] };
    },
  });
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /已确认角色表/);
  assert.match(prompts[0], /tangseng/);
});

test('拆解断点续跑：失败后从已完成分块继续，不重付前段', async () => {
  const text = Array.from({ length: 300 }, (_, index) => `第${index}段。林深说：「风向变了。」`).join('\n');
  const totalChunks = splitNovel(text, 500).length;
  assert.ok(totalChunks >= 4, '测试文本应至少切出 4 个分块');
  const sceneOf = (index) => ({ project: { genre: '悬疑' }, characters: [], scenes: [{ title: `场景${index}`, lines: [{ type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text: `第${index}段台词` }] }] });
  let checkpoint = null;
  let brokenChunk = true;
  const firstRunCalls = [];
  await assert.rejects(
    analyzeNovel(LLM_CONFIG, { text, filename: 'n.txt', name: '作品' }, {
      chunkChars: 500, retryDelayMs: 10,
      call: async (_config, source) => { firstRunCalls.push(source); if (brokenChunk && firstRunCalls.length >= 2) throw new Error('第二段失败'); return sceneOf(firstRunCalls.length - 1); },
      onCheckpoint: (value) => { checkpoint = value; },
    }),
    /第二段失败/,
  );
  assert.ok(firstRunCalls.length >= 3, '失败分块应先经历一次自动重试');
  brokenChunk = false;
  assert.equal(checkpoint.chunksDone, 1);
  assert.equal(checkpoint.merged.scenes.length, 1);

  const resumeCalls = [];
  const resumed = await analyzeNovel(LLM_CONFIG, { text, filename: 'n.txt', name: '作品' }, {
    chunkChars: 500, retryDelayMs: 10,
    resume: checkpoint,
    call: async () => { resumeCalls.push(1); return sceneOf(resumeCalls.length + 1); },
  });
  assert.equal(resumeCalls.length, totalChunks - 1, '只应重打未完成的分块');
  assert.equal(resumed.breakdown, 'llm');
  assert.equal(resumed.scenes.length, totalChunks, '断点前的场景与续跑场景全部保留');
});

test('拆解分块自动重试：瞬时失败重打一次后成功', async () => {
  const text = Array.from({ length: 80 }, (_, index) => `第${index}段。她说：「再来一次。」`).join('\n');
  let failures = 0;
  const calls = [];
  const result = await analyzeNovel(LLM_CONFIG, { text, filename: 'n.txt', name: '作品' }, {
    chunkChars: 500,
    retryDelayMs: 10,
    call: async () => {
      calls.push(1);
      if (calls.length === 1) { failures += 1; throw new Error('网络抖动'); }
      return { project: { genre: '' }, characters: [], scenes: [{ title: '场景', lines: [{ type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text: '台词' }] }] };
    },
  });
  assert.equal(failures, 1);
  assert.equal(calls.length, splitNovel(text, 500).length + 1, '第一分块重打了一次');
  assert.equal(result.breakdown, 'llm');
});

test('分块：优先在章节标题、分隔线和空行处切分，避免拦腰截断场景', () => {
  const sceneA = Array.from({ length: 8 }, (_, i) => `第一幕第${i + 1}段。风雪拍打着城头铁甲，无人说话。`).join('\n');
  const sceneB = Array.from({ length: 8 }, (_, i) => `第二幕第${i + 1}段。大堂内灯火摇曳，二人低声对峙。`).join('\n');
  const combined = `${sceneA}\n\n第二章 密议\n${sceneB}`;
  const maxChars = sceneA.length + 80;
  const chunks = splitNovel(combined, maxChars);
  assert.equal(chunks.length, 2, '应在“第二章 密议”标题前切分');
  assert.ok(chunks[0].length <= maxChars);
  assert.ok(chunks[1].startsWith('第二章 密议'), `第二块应从新章标题起头，实际: ${chunks[1].slice(0, 20)}`);

  const withDivider = `${sceneA}\n***\n${sceneB}`;
  const dividerChunks = splitNovel(withDivider, maxChars);
  assert.equal(dividerChunks.length, 2);
  assert.ok(dividerChunks[1].startsWith('***'), '应在场景分隔线处切分');
});

test('分场规划修正：补全遗漏段落与尾段、限制上限并校验 continuesPrevious', () => {
  const paragraphs = Array.from({ length: 10 }, (_, i) => `第${i + 1}段正文`);
  const repaired = resolveScenePlans(paragraphs, [
    { title: '场一', continuesPrevious: true, startParagraph: 1, endParagraph: 3 },
    { title: '场二', continuesPrevious: true, startParagraph: 6, endParagraph: 8 },
  ], { hasPreviousScene: true });
  assert.equal(repaired.length, 2);
  assert.deepEqual([repaired[0].startParagraph, repaired[0].endParagraph], [1, 3]);
  assert.deepEqual([repaired[1].startParagraph, repaired[1].endParagraph], [4, 10], '遗漏的 P4-P5 与尾部 P9-P10 应自动补齐');
  assert.equal(repaired[0].continuesPrevious, true);
  assert.equal(repaired[1].continuesPrevious, false, '只有第一场允许 continuesPrevious');

  const noPrev = resolveScenePlans(paragraphs, [{ title: '场一', continuesPrevious: true, startParagraph: 1, endParagraph: 10 }], { hasPreviousScene: false });
  assert.equal(noPrev[0].continuesPrevious, false, '没有上一场时禁止 continuesPrevious');

  const many = Array.from({ length: 9 }, (_, i) => ({ title: `碎片${i + 1}`, startParagraph: i + 1, endParagraph: i + 1 }));
  const capped = resolveScenePlans(paragraphs, many, { maxScenes: 4 });
  assert.equal(capped.length, 4);
  assert.equal(capped[0].startParagraph, 1);
  assert.equal(capped[capped.length - 1].endParagraph, 10);
});

test('两阶段导演流水线：长段先做分场策划再逐场精写，传递切片原文、分镜单与衔接上下文', async () => {
  const paragraphs = Array.from({ length: 12 }, (_, i) => `第${i + 1}段：寒夜朔风卷过边关城头，赵猛按住刀柄喝问来者何人，暗处马蹄渐近。`);
  const text = paragraphs.join('\n');
  const calls = [];
  const progressMessages = [];

  const result = await analyzeNovel(LLM_CONFIG, { text, filename: 'chapter1.txt', name: '边关夜雪' }, {
    twoStageMinChars: 100,
    onProgress: (info) => progressMessages.push(info),
    call: async (_config, prompt, opts) => {
      calls.push({ stage: opts?.stage, prompt });
      if (opts?.stage === 'plan') {
        return {
          project: { genre: '历史权谋' },
          characters: [
            { id: 'narrator', name: '旁白', role: '叙事者', gender: '男', age: '中年', description: '沉稳冷峻', voiceDescription: '中年男声，中低音区，磁性沉稳' },
            { id: 'zhaomeng', name: '赵猛', role: '守将', gender: '男', age: '中年', description: '悍勇警觉', voiceDescription: '中年男声，音色粗粝厚实，语速干脆' },
          ],
          scenePlan: [
            {
              title: '幽州夜雪 · 城头喝问',
              location: '夜 / 外 / 幽州城头',
              mood: '凛冽肃杀',
              synopsis: '风雪夜城头戒备，神秘骑兵逼近。',
              emotionArc: '寒夜肃静(30) → 警觉喝问(75)',
              cameraStrategy: '旁白中距建立雪夜城楼，守将近讲喝问',
              soundPlan: { ambient: '寒夜风雪呼啸，旌旗猎猎', keySfx: ['铁甲轻响', '长刀出鞘'], musicCue: '低沉大提琴暗涌' },
              startParagraph: 1,
              endParagraph: 6,
            },
            {
              title: '城门亮令 · 暗流骤紧',
              location: '夜 / 外 / 幽州城门下',
              mood: '剑拔弩张',
              synopsis: '来使报出身份，局势反转。',
              emotionArc: '对峙紧绷(80) → 压低密谈(45)',
              cameraStrategy: '远距传声切近讲对峙，末尾转耳语',
              soundPlan: { ambient: '城门洞寒风穿堂', keySfx: ['马蹄停步'], musicCue: '战鼓缓重推进' },
              startParagraph: 7,
              endParagraph: 12,
            },
          ],
        };
      }
      if (calls.length === 2) {
        return {
          characters: [],
          scene: {
            title: '幽州夜雪 · 城头喝问',
            lines: [
              { type: 'ambient', text: '[环境声] 寒夜风雪呼啸，旌旗猎猎' },
              { type: 'sfx', text: '音效：长刀出鞘金属脆鸣' },
              { type: 'dialogue', speaker: '赵猛', speakerId: 'zhaomeng', text: '什么人！', subtext: '按刀警备，先声夺人', emotion: '警惕的语气', intensity: 78, pace: 105, distance: '近讲', pauseAfterMs: 120 },
            ],
          },
        };
      }
      return {
        characters: [{ id: 'laishi', name: '来使', role: '密使', gender: '男', age: '青年', voiceDescription: '青年男声，低沉克制' }],
        scene: {
          title: '城门亮令 · 暗流骤紧',
          lines: [
            { type: 'ambient', text: '城门洞寒风穿堂' },
            { type: 'music', text: '背景音乐：低沉战鼓与弦乐暗涌推进' },
            { type: 'dialogue', speaker: '来使', speakerId: 'laishi', text: '镇北王急令，速开城门。', subtext: '压低声线亮出底牌', emotion: '冷静', intensity: 60, pace: 88, distance: '远景喊话', pauseAfterMs: 850 },
          ],
        },
      };
    },
  });

  assert.deepEqual(calls.map((c) => c.stage), ['plan', 'scene', 'scene']);
  assert.match(calls[0].prompt, /\[P1\][\s\S]*\[P12\]/, '阶段一应带全部段落编号');
  assert.match(calls[1].prompt, /第1段[\s\S]*第6段/);
  assert.doesNotMatch(calls[1].prompt, /第7段/, '第 1 场不应拿到第 2 场的原文');
  assert.match(calls[2].prompt, /第7段[\s\S]*第12段/);
  assert.match(calls[2].prompt, /上一段尾场衔接[\s\S]*什么人！/, '第 2 场应拿到第 1 场尾句衔接');

  assert.equal(result.genre, '历史权谋');
  assert.equal(result.scenes.length, 2);
  assert.equal(result.scenes[0].emotionArc, '寒夜肃静(30) → 警觉喝问(75)');
  assert.match(result.scenes[0].directorNote, /旁白中距建立雪夜城楼/);
  assert.equal(result.scenes[0].lines[0].text, '寒夜风雪呼啸，旌旗猎猎', '剥离多余的 [环境声] 前缀');
  assert.equal(result.scenes[0].lines[1].text, '长刀出鞘金属脆鸣', '剥离多余的 音效：前缀');
  assert.equal(result.scenes[0].lines[2].emotion, '警惕', '剥离“的语气”后缀');
  assert.deepEqual(result.scenes[0].lines[2].mix, { gapAfterMs: 120 }, '抢白停顿落入 mix.gapAfterMs');

  assert.equal(result.scenes[1].lines[1].text, '低沉战鼓与弦乐暗涌推进');
  assert.equal(result.scenes[1].lines[2].distance, '远距', '距离别名归一到标准四档');
  assert.deepEqual(result.scenes[1].lines[2].mix, { gapAfterMs: 850 }, '悬念留白落入 mix.gapAfterMs');
  assert.ok(result.characters.some((c) => c.id === 'laishi'), '阶段二补充的新角色进入总角色表');
  assert.ok(progressMessages.some((p) => p.stage === 'plan' && /分场策划/.test(p.message)));
  assert.ok(progressMessages.some((p) => p.stage === 'scene' && /精写第 2 \/ 2 场/.test(p.message)));
});

test('两阶段场景级断点续跑：第 2 场失败后重试，跳过阶段一与已完成分场', async () => {
  const text = Array.from({ length: 9 }, (_, i) => `第${i + 1}段。风雪漫天，三人拔刀对峙。`).join('\n');
  let checkpoint = null;
  const firstRunStages = [];

  await assert.rejects(
    analyzeNovel(LLM_CONFIG, { text, filename: 'c.txt', name: '续跑测试' }, {
      twoStageMinChars: 50,
      retryDelayMs: 1,
      onCheckpoint: (cp) => { checkpoint = cp; },
      call: async (_config, _prompt, opts) => {
        firstRunStages.push(opts?.stage);
        if (opts?.stage === 'plan') {
          return {
            project: { genre: '权谋' },
            characters: [{ id: 'a', name: '甲', role: '主角' }],
            scenePlan: [
              { title: '场一', startParagraph: 1, endParagraph: 3 },
              { title: '场二', startParagraph: 4, endParagraph: 6 },
              { title: '场三', startParagraph: 7, endParagraph: 9 },
            ],
          };
        }
        if (firstRunStages.length === 2) {
          return { characters: [], scene: { title: '场一', lines: [{ type: 'dialogue', speaker: '甲', speakerId: 'a', text: '第一场完成。' }] } };
        }
        throw new Error('第二场模型超时抖动');
      },
    }),
    /第二场模型超时抖动/,
  );

  assert.equal(checkpoint.chunksDone, 0);
  assert.equal(checkpoint.activeChunk.scenesDone, 1);
  assert.equal(checkpoint.merged.scenes.length, 1);

  const resumeCalls = [];
  const resumed = await analyzeNovel(LLM_CONFIG, { text, filename: 'c.txt', name: '续跑测试' }, {
    twoStageMinChars: 50,
    retryDelayMs: 1,
    resume: checkpoint,
    call: async (_config, prompt, opts) => {
      resumeCalls.push({ stage: opts?.stage, prompt });
      const title = resumeCalls.length === 1 ? '场二' : '场三';
      return { characters: [], scene: { title, lines: [{ type: 'dialogue', speaker: '甲', speakerId: 'a', text: `${title}台词。` }] } };
    },
  });

  assert.deepEqual(resumeCalls.map((c) => c.stage), ['scene', 'scene'], '只补跑第 2、3 场，不再重跑阶段一和第 1 场');
  assert.deepEqual(resumed.scenes.map((s) => s.title), ['场一', '场二', '场三']);
});

test('跨块续场与导演护栏：continuesPrevious 合并台词并去重重复环境声；清理套话 subtext 与默认气口', async () => {
  const part1 = '第一段。夜雨拍窗，二人对坐茶室。'.repeat(12);
  const part2 = '第二段。赵猛冷笑一声拍案而起。'.repeat(12);
  const text = `${part1}\n${part2}`;
  let idx = 0;

  const result = await analyzeNovel(LLM_CONFIG, {
    text,
    filename: 'n.txt',
    name: '雨夜茶室',
    seedPreviousScene: { title: '前章尾场', location: '夜 / 外 / 长街', mood: '阴郁', lines: [{ type: 'dialogue', speaker: '旁白', speakerId: 'narrator', text: '前章收尾。', emotion: '冷静', distance: '中距' }] },
  }, {
    chunkChars: part1.length + 10,
    twoStage: false,
    call: async (_config, prompt) => {
      idx += 1;
      if (idx === 1) {
        assert.match(prompt, /前章尾场/, '首块应获得前章尾场衔接参考');
        return {
          project: { genre: '悬疑' },
          characters: [{ id: 'zhaomeng', name: '赵猛', role: '主角' }],
          scenes: [{
            title: '雨夜茶室',
            continuesPrevious: true, // 第一块无同章前场，应被忽略不报错
            location: '夜 / 内 / 茶室',
            mood: '暗流涌动',
            emotionArc: '静水试探(35)',
            lines: [
              { type: 'ambient', text: '细雨敲打茶室窗棂，炭炉微响' },
              { type: 'dialogue', speaker: '赵猛', speakerId: 'zhaomeng', text: '你来晚了。', subtext: '按当前剧情上下文表达。', emotion: '克制', intensity: 35, pace: 88, distance: '窃窃私语', pauseAfterMs: 320 },
            ],
          }],
        };
      }
      assert.match(prompt, /你来晚了/, '第二块应收到上一块尾句');
      return {
        characters: [],
        scenes: [{
          title: '雨夜茶室（续）',
          continuesPrevious: true,
          emotionArc: '拍案爆发(88)',
          lines: [
            { type: 'ambient', text: '细雨敲打茶室窗棂，炭炉轻响' }, // 重复环境声，应去重
            { type: 'sfx', text: '手掌重重拍在木案上' },
            { type: 'sfx', text: '手掌重重拍在木案上' }, // 连续重复音效，应去重
            { type: 'dialogue', speaker: '赵猛', speakerId: 'wrong-id', text: '把东西交出来！', emotion: '愤怒情绪', intensity: 88, pace: 110, distance: '未知距离', pauseAfterMs: 700 },
          ],
        }],
      };
    },
  });

  assert.equal(result.scenes.length, 1, 'continuesPrevious: true 应无缝并入上一场');
  const scene = result.scenes[0];
  assert.equal(scene.emotionArc, '静水试探(35) → 拍案爆发(88)');
  assert.equal(scene.lines.filter((l) => l.type === 'ambient').length, 1, '续场重复环境声应去重');
  assert.equal(scene.lines.filter((l) => l.type === 'sfx').length, 1, '连续重复音效应去重');

  const dialogues = scene.lines.filter((l) => l.type === 'dialogue');
  assert.equal(dialogues.length, 2);
  assert.equal(dialogues[0].subtext, '', '套话 subtext 不再污染 TTS 指令');
  assert.equal(dialogues[0].distance, '耳语');
  assert.equal(dialogues[0].mix, undefined, '常规 320ms 气口不额外写入 mix');
  assert.equal(dialogues[1].speakerId, 'zhaomeng', '按说话人姓名修正漂移的 speakerId');
  assert.equal(dialogues[1].emotion, '愤怒');
  assert.equal(dialogues[1].distance, '近讲');
  assert.deepEqual(dialogues[1].mix, { gapAfterMs: 700 });
});

test('两阶段兼容回退：阶段一直接返回 scenes 时平滑采纳不报错', async () => {
  const text = '边关风雪呼啸，将军策马疾驰。'.repeat(12);
  let calls = 0;
  const result = await analyzeNovel(LLM_CONFIG, { text, filename: 'n.txt', name: '测试' }, {
    twoStageMinChars: 50,
    call: async () => {
      calls += 1;
      return {
        project: { genre: '武侠' },
        characters: [{ id: 'hero', name: '将军', role: '主角' }],
        scenes: [{ title: '边关驰道', lines: [{ type: 'dialogue', speaker: '将军', speakerId: 'hero', text: '全军加速！' }] }],
      };
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.scenes.length, 1);
  assert.equal(result.scenes[0].title, '边关驰道');
});


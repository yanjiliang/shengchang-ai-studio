// Sample project content + seeder (design B2): a direction-rich condensed
// excerpt of 西游记·第二十七回「尸魔三戏唐三藏」(public domain, Ming dynasty).
// Hand-authored instead of heuristic output so every line carries real
// direction data (subtext/emotion/intensity/distance) — that layer is the
// product pitch, so the first-run sample must show it at its best.
//
// Two seed modes:
//   seedSampleProject()          — boot path: seeds only a genuinely fresh
//                                  install (zero project rows, archived ones
//                                  included), so deleting your work never
//                                  resurrects the sample.
//   seedSampleProject({force})   — scripts/seed-sample.mjs: adds the sample
//                                  to an existing install unless the marker
//                                  is already present (idempotent).
import { createProject, getProject, listProjects, countProjects } from './database.js';

export const SAMPLE_SEED = 'xiyouji-sanda-v1';
export const SAMPLE_NAME = '西游记 · 三打白骨精';

const deliveryOf = (line) => `${line.emotion} ${line.intensity}% · 语速 ${(line.pace / 100).toFixed(2)}`;

const dialogue = (id, speaker, speakerId, text, direction) => ({
  id, type: 'dialogue', speaker, speakerId, text, ...direction,
});

const soundEvent = (id, type, label, text) => ({ id, type, label, text, time: '待编排' });

const CHARACTERS = [
  { id: 'narrator', name: '旁白', role: '叙事者', description: '冷静克制，保留说书人的节奏感，不抢戏。' },
  { id: 'tangseng', name: '唐僧', role: '主角', description: '慈悲而执拗。动怒时也带着文气，字字有礼却句句见责。' },
  { id: 'sunwukong', name: '孙悟空', role: '主角', description: '火气与忠心都写在嗓门里，急躁但死心塌地护主。' },
  { id: 'zhubajie', name: '猪八戒', role: '主角', description: '憨直嘴碎，情绪永远比脑子快半拍。' },
  { id: 'shaonv', name: '青衣少女', role: '角色（白骨精一化）', description: '甜糯殷勤，妖气全部藏进笑意里。' },
  { id: 'laoyu', name: '老妪', role: '角色（白骨精二化）', description: '苍老悲切，哭腔里带着钩子。' },
  { id: 'laoweng', name: '老翁', role: '角色（白骨精三化）', description: '苍凉迟缓，每个问句都是试探。' },
];

const SCENES = [
  {
    id: 'sd-scene-1', title: '白虎岭 · 斋饭', location: '日 / 外 / 山坳松林',
    mood: '山静日长，暗流涌动', synopsis: '白骨精一化少女送斋，悟空识破打杀，师徒裂痕初现。',
    lines: [
      dialogue('sd-l01', '旁白', 'narrator', '山坳里起了薄雾。白马走得慢，唐僧在松树下勒住缰绳。', { subtext: '平静表面下埋着不安', emotion: '克制', intensity: 30, pace: 88, distance: '中距' }),
      dialogue('sd-l02', '唐僧', 'tangseng', '徒弟，为师腹中饥饿，何处化些斋饭来？', { subtext: '旅途劳顿，语气放得平和', emotion: '疲惫', intensity: 30, pace: 85, distance: '近讲' }),
      dialogue('sd-l03', '孙悟空', 'sunwukong', '师父且坐，这荒山没处化斋，老孙去南山摘些鲜果来。', { subtext: '爽快应下，眼里先扫过四周', emotion: '克制', intensity: 40, pace: 100, distance: '近讲' }),
      soundEvent('sd-s01', 'ambient', '环境声', '松涛与山风穿过林梢'),
      dialogue('sd-l04', '青衣少女', 'shaonv', '长老万福。小女子备了香米饭，特来献斋。', { subtext: '殷勤讨好，句句往人心里送', emotion: '温柔', intensity: 55, pace: 92, distance: '近讲' }),
      dialogue('sd-l05', '猪八戒', 'zhubajie', '师父，人家一片好意，你还推辞什么！', { subtext: '馋意占了上风，帮着外人说话', emotion: '急切', intensity: 70, pace: 105, distance: '近讲' }),
      dialogue('sd-l06', '孙悟空', 'sunwukong', '妖怪！吃俺老孙一棒！', { subtext: '火眼金睛看穿伪装，出手不留情', emotion: '愤怒', intensity: 95, pace: 112, distance: '近讲' }),
      dialogue('sd-l07', '唐僧', 'tangseng', '悟空！她好心送斋，你怎可伤人性命！', { subtext: '惊怒交加，慈悲压不住火气', emotion: '愤怒', intensity: 75, pace: 95, distance: '近讲' }),
      dialogue('sd-l08', '旁白', 'narrator', '少女应声倒地，罐子里滚出几条长蛆。唐僧惊得倒退两步，念起了紧箍咒。', { subtext: '事态陡变，节奏收紧', emotion: '警惕', intensity: 45, pace: 95, distance: '中距' }),
    ],
  },
  {
    id: 'sd-scene-2', title: '寻女 · 逐徒', location: '日 / 外 / 山径',
    mood: '悲声逼人，师徒决裂', synopsis: '白骨精二化老妪寻女，悟空再打；唐僧写下贬书逐走悟空。',
    lines: [
      dialogue('sd-l09', '老妪', 'laoyu', '我的儿啊……哪个天杀的，害了我女儿！', { subtext: '哭腔是演的，试探是真的', emotion: '悲伤', intensity: 85, pace: 80, distance: '中距' }),
      dialogue('sd-l10', '猪八戒', 'zhubajie', '师父，祸事了！她母亲寻上门来了！', { subtext: '慌了神，先把祸水引给大师兄', emotion: '急切', intensity: 75, pace: 110, distance: '近讲' }),
      dialogue('sd-l11', '孙悟空', 'sunwukong', '又是那妖怪变的，看棒！', { subtext: '看穿了，也不再解释', emotion: '愤怒', intensity: 95, pace: 112, distance: '近讲' }),
      dialogue('sd-l12', '唐僧', 'tangseng', '你这泼猴！连伤两命，快回你的花果山去！', { subtext: '失望到极点，一字一句都是绝情话', emotion: '愤怒', intensity: 85, pace: 88, distance: '近讲' }),
      dialogue('sd-l13', '孙悟空', 'sunwukong', '师父！再教俺走，谁来保你西去……', { subtext: '委屈与不舍，头一次软了语气', emotion: '悲伤', intensity: 70, pace: 82, distance: '近讲' }),
      soundEvent('sd-s02', 'sfx', '动作音效', '纸页撕裂——贬书被扯成两半'),
      dialogue('sd-l14', '旁白', 'narrator', '悟空拜了师父四拜，翻身上了云头。山径上只剩一僧一马，和越来越近的哭声。', { subtext: '离别的静，为第三场蓄力', emotion: '悲伤', intensity: 40, pace: 85, distance: '远距' }),
    ],
  },
  {
    id: 'sd-scene-3', title: '现形', location: '日 / 外 / 白虎岭',
    mood: '杀机毕露，真相大白', synopsis: '白骨精三化老翁索命，悟空三打现形，唐僧悔悟。',
    lines: [
      dialogue('sd-l15', '老翁', 'laoweng', '长老，可曾见我女儿与老伴？一家三口，如今只剩老朽。', { subtext: '苍凉是壳，句句都在探虚实', emotion: '悲伤', intensity: 50, pace: 78, distance: '远距' }),
      dialogue('sd-l16', '猪八戒', 'zhubajie', '师父，又来一个，准是同伙！', { subtext: '嘴上帮师兄，腿往后缩', emotion: '怀疑', intensity: 65, pace: 108, distance: '近讲' }),
      soundEvent('sd-s03', 'music', '背景音乐', '弦乐渐紧，杀机一线一线收拢'),
      dialogue('sd-l17', '孙悟空', 'sunwukong', '妖精！三番两次戏弄俺老孙，今日不打死你，誓不上西天！', { subtext: '最后一次出棒，怒意顶点', emotion: '愤怒', intensity: 100, pace: 115, distance: '近讲' }),
      dialogue('sd-l18', '旁白', 'narrator', '老翁应声倒地，一缕白烟从天灵盖飘出。脊梁骨上，现出「白骨夫人」四个字。', { subtext: '真相揭开，语气放轻放慢', emotion: '警惕', intensity: 35, pace: 82, distance: '中距' }),
      dialogue('sd-l19', '唐僧', 'tangseng', '悟空……是是为师错怪你了。', { subtext: '愧疚说不出整句，声音低了下去', emotion: '悲伤', intensity: 60, pace: 78, distance: '近讲' }),
    ],
  },
];

const SOURCE_TEXT = [
  '第二十七回 尸魔三戏唐三藏（节选）',
  '山坳里起了薄雾，唐僧在松树下勒住缰绳，说腹中饥饿。悟空道这荒山无处化斋，去南山摘鲜果便回。',
  '不多时，来了一个青衣少女，提着青砂罐，说罐中是香米饭，特来献斋。八戒馋得口水利，只劝师父收下。',
  '悟空南山上回头一看，认出那女子是妖精变的，掣出金箍棒就打。少女倒地现出假尸，罐里滚出长蛆。唐僧惊得念起紧箍咒，责他伤人性命。',
  '不多时，又来了一个老妪，哭着寻女。悟空认出还是那妖精，一棒打倒。唐僧惊怒，念了二十遍紧箍咒，写下贬书，赶悟空回花果山。悟空拜了四拜，含泪去了。',
  '那妖精又化作老翁，来寻女儿与老伴。悟空唤来本地土地山神作证，一棒打杀，妖精化作一堆粉骷髅，脊梁上刻着「白骨夫人」。唐僧这才信了，只是八戒在旁挑唆，师徒终是生分了。',
].join('\n');

export function buildSampleState() {
  return {
    sampleSeed: SAMPLE_SEED,
    scenes: SCENES.map((scene, index) => ({
      id: scene.id,
      number: String(index + 1).padStart(2, '0'),
      title: scene.title,
      duration: '待生成',
      cast: [...new Set(scene.lines.filter((line) => line.type === 'dialogue').map((line) => line.speaker))].join(' · ') || '旁白',
      status: 'pending',
      location: scene.location,
      mood: scene.mood,
      synopsis: scene.synopsis,
      arc: [12, 18, 24, 31, 38, 44, 36, 29],
      lines: scene.lines.map((line) => line.type === 'dialogue' ? { ...line, delivery: deliveryOf(line) } : line),
    })),
    assets: [],
    characters: CHARACTERS,
    voiceMap: {},
    pronunciationDictionary: [],
  };
}

function alreadySeeded() {
  return listProjects().some((summary) => getProject(summary.id)?.state?.sampleSeed === SAMPLE_SEED);
}

export function seedSampleProject({ force = false } = {}) {
  if (alreadySeeded()) return { created: false, reason: 'sample-exists' };
  // Boot mode never seeds into an install that has ANY project (archived
  // included): a user who deleted their work must not find the sample back.
  if (!force && countProjects() > 0) return { created: false, reason: 'not-fresh' };
  const project = createProject({
    name: SAMPLE_NAME,
    genre: '神魔小说 · 公版节选',
    state: buildSampleState(),
    sourceFilename: '西游记-第27回节选.txt',
    sourceText: SOURCE_TEXT,
  });
  return { created: true, projectId: project.id };
}

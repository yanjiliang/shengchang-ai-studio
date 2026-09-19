# 声场 ShengChang

![声场：让故事，有声有场。AI 多人广播剧创作工作台](public/brand/launch-cover.jpg)

**Personal AI radio-drama workbench — paste a novel, get a directed, mixed episode.**
个人使用的 AI 多人广播剧制作工作台：小说进，成片出。

---

## English Quickstart

ShengChang turns a novel chapter into a finished radio-drama episode: scene/line breakdown → per-character voice mapping → directed TTS (emotion / subtext / intensity / distance folded into one voice instruction) → FFmpeg mix desk with sidechain ducking → loudness-normalized MP3.

**Zero-key first run.** A fresh install ships with a sample project — a condensed, direction-rich excerpt from *Journey to the West* (Chapter 27, public domain) — and defaults to the offline demo engine. Clone, install, run, and the full pipeline (一键成片 one-click episode) works end-to-end with placeholder tones: no API key, no signup, no cost. The plumbing is real; only the voice is a placeholder. Real voices need a [豆包语音](https://www.volcengine.com/product/speech) key; pasting your own novel works without any key via the rule-based breakdown (tagged for manual review) or with an LLM key for full understanding.

```bash
# Requirements: Node.js 22.5+, FFmpeg + ffprobe on PATH
npm install
npm run dev          # workbench on http://127.0.0.1:4173
```

1. Open the sample project 「西游记 · 三打白骨精」.
2. 制作中心 → 「一键成片」 → confirm the estimate → walk away.
3. Come back to a mixed episode MP3 (demo-engine tones).

What to look at as a developer:

- **The direction layer** — select a dialogue line, open 方向实验室 (Direction Lab) in the Inspector: the same line under three different directions (subtext/emotion/intensity/distance), auditioned side by side. Takes are cached per direction, so applying a take and regenerating is an instant cache hit.
- **The mix graph** — per-scene timelines with auto-sequenced dialogue, looped beds, sidechain-compressed ducking, loudnorm + limiter master chain (`server/media-store.js`).
- **Production plumbing** — persistent resumable tasks in SQLite with stage checkpoints, content-addressed audio cache with disk recovery and LRU eviction, server-owned audio fields that survive browser autosave races.

Everything runs on loopback (`127.0.0.1`); credentials never leave `~/.shengchang/`. API routes reject non-loopback `Host`/`Origin`.

中文详细文档如下 / Full documentation in Chinese below.

品牌素材：[深底 Logo](public/brand/logo-dark.png) · [浅底横排 Logo](public/brand/logo-light.png) · [应用图标](public/brand/icon-256.png) · [使用说明](public/brand/README.md)

---

## 环境要求

- Node.js 22.5+（数据库使用内置 `node:sqlite`）
- FFmpeg 与 ffprobe（混音与导出，需在 PATH 中）

## 运行

```bash
npm install
npm run dev
```

打开 `http://127.0.0.1:4173/`。`npm run dev` 会同时启动：

- 前端工作台：`127.0.0.1:4173`
- 本地模型网关：`127.0.0.1:4174`（只绑定本机回环地址）

全新安装会自动创建示例项目「西游记 · 三打白骨精」（公版节选，每句台词都带完整导演参数），并默认使用离线演示引擎——不配任何密钥即可完整体验一键成片。已有安装可运行 `npm run seed` 补种示例。

生产构建：

```bash
npm run build
npm start
```

Docker 运行（镜像内含 Node 22 与 FFmpeg，以非 root 的 node 用户运行，单端口 4174）：

```bash
docker build -t shengchang .
docker run -p 4174:4174 \
  -v shengchang-runtime:/app/.runtime \
  -v shengchang-config:/home/node/.shengchang \
  shengchang
```

项目与音频缓存放 `shengchang-runtime` 卷，模型凭证放 `shengchang-config` 卷；首次在设置页配置即可。

运行测试：

```bash
npm test          # 单元测试（含混音结构化测试）
npm run test:e2e  # 沙箱端到端：真实起服务、走完生成/一键成片全链路
```

## 零密钥能做什么

| 能力 | 无任何密钥 | 配置文本模型 | 再配豆包语音 |
|------|-----------|-------------|-------------|
| 示例项目一键成片 | ✅（占位音） | — | ✅ 真实语音 |
| 导入自己的小说 | ✅ 规则拆解（建议人工校对角色归属） | ✅ 语义拆解 | — |
| 生成真实语音 | ❌ | ❌ | ✅ |
| 方向实验室对比 | ✅（占位音） | — | ✅ |

离线演示引擎的定位：链路是真的，声音是假的。设置页会在演示引擎激活时提示。

## 模型配置

进入左下角“设置”。支持三种语音合成连接：

- 豆包语音（火山引擎新版 API Key）：`/api/v3/tts/unidirectional` 流式接口，使用 `X-Api-Key` 请求头，按 Resource ID 选择模型（`seed-tts-2.0` 或 `seed-icl-2.0`）。`seed-tts-2.0` 下，台词的情绪、情绪强度、潜台词和声音距离会合并为一条语音指令送入 `context_texts`；`seed-icl-2.0` 仅使用台词文本与语速。
- 自定义 HTTP：使用 JSON 请求头和请求体模板连接其他服务。请求体模板支持 `{{text}}`、`{{voiceId}}`、`{{emotion}}`、`{{emotionScale}}`、`{{speed}}`、`{{model}}`、`{{subtext}}`、`{{distance}}` 等变量。
- 开发测试引擎（demo）：只用于离线验证生成、回放和导出链路，不用于正式制作。

小说拆解使用 OpenAI Chat Completions 兼容接口（默认指向火山方舟）。在设置页填写 endpoint、API Key 和模型名称后，可用“测试连接”发起一次真实请求验证。长篇原文按段落分块处理（兼容单换行分段的网文格式），并携带已经确认的角色表来保持人物 ID 连续。

未配置文本模型时，导入小说会自动退回到规则拆解：按章节标题（或固定段落数）切分场景，用引号与说话人动词（“X说：「…」”，含英文直引号）推断对白归属，代词跟随最近说话人，无法归属的文本一律归为旁白。规则拆解的结果会在场景侧栏标记“规则拆解 · 建议人工校对”，角色归属与场景切分可在工作台内手动修正。

角色音色有两种配置方式：

1. 在角色音色页直接为角色填写已有的 `voice_id` / `speaker_id`。
2. 使用豆包音色设计接口：填写基础 `speaker_id` 和声音描述，创建并锁定新的 `speaker_id`（仅新版豆包语音 API Key 连接支持）。

## 本地数据

- 凭证：`~/.shengchang/config.json`，权限为当前用户可读写。
- 项目、任务与音频缓存索引：仓库的 `.runtime/shengchang.sqlite`。
- 生成音频与导出：仓库的 `.runtime/media/` 与 `.runtime/exports/`，均已加入 `.gitignore`。
- 最终导出：48 kHz、双声道、MP3 192 kbps，默认标准化至 -16 LUFS。

不要把 `.runtime/` 或 `~/.shengchang/config.json` 提交到版本库。

## 制作流程

0. （可选）在制作中心点「一键成片」：自动拆解 -> 预设音色映射 -> 批量生成 -> 音频体检 -> 整集导出，一次跑完。启动前会显示预估（句数、字数、缓存命中）；阶段进度与注意事项在任务历史查看，失败可从断点重试。
1. 导入 TXT 小说自动拆解，或手动新建场景。
2. 在角色音色页创建或映射每个角色的 `voice_id`。
3. 调整场景、台词、潜台词、情绪、语速和空间参数（台词改动后已有音频会标记“待重生成”，不会被静默删除）。选中对白后可在「方向实验室」用同一句台词试听三种演法，应用后再生成会直接命中缓存。
4. 生成单句、整个场景或仅重新生成过期台词，音频自动写回台词事件。
5. 在声音素材页导入音乐、环境声、动作音效和人物主题，试听并选择具体声音事件进行绑定。删除素材时先自动解除全部绑定，服务器确认无任何引用后才从磁盘移除文件。
6. 在质量审听页检查音频覆盖、音色绑定、素材绑定与文件健康，检查条目可点击直达问题台词。
7. 在制作中心导出当前场景或整集 MP3。已绑定的声音素材会作为声床进入混音。

生成、小说拆解和整集导出均使用持久任务。服务重启后未完成任务会重新进入队列；相同模型、音色、文本和表演参数会复用已有音频缓存。缓存体积超过设置中的上限（默认 50 GB）时，最久未被复用的缓存会被清理；仍被项目引用的音频文件不会被删除，后续命中时会从磁盘重新登记回缓存索引，不会重复调用模型。

## 制作中心

- 混音编排：为对白、音乐、环境声和音效设置入点、持续时间、增益、声像、淡入淡出与循环。对白未填写入点时自动顺排。
- 自动闪避：音乐与环境声进入对白区间时，由 FFmpeg 侧链压缩自动降低电平。
- 整集导出：按场景顺序渲染中间文件，最终统一到目标 LUFS、-1 dBTP、MP3 192 kbps；中间文件在导出完成后自动清理。
- 任务历史：保留小说拆解、语音生成和整集导出的进度，可取消和重试失败任务。
- 发音词典：项目级原文替换规则在语音合成前生效，替换结果参与音频缓存键计算。

## 安全边界

- 服务只绑定 `127.0.0.1`，`/api` 拒绝非回环的 `Host` 与 `Origin`（防跨站表单提交与 DNS rebinding）。
- 凭证文件权限 0600，浏览器永远拿不到明文，设置页只回显脱敏提示。
- 上传与导出的文件名经过消毒；素材删除遵守引用检查。

## 许可

MIT（见 LICENSE）。示例文本《西游记》为公版作品，本仓库使用的节选与导演标注为原创改编。

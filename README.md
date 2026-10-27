# 声场 ShengChang

**[🌐 产品主页](https://yanjiliang.github.io/shengchang-ai-studio/) · 一部小说，一键变成多人广播剧。**

[![CI](https://github.com/yanjiliang/shengchang-ai-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/yanjiliang/shengchang-ai-studio/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-informational.svg)](LICENSE)

![声场：让故事，有声有场。AI 多人广播剧创作工作台](public/brand/launch-cover.jpg)

**Personal AI radio-drama workbench — paste a novel, get a directed, mixed episode.**
本地运行、开源免费；每个角色都有自己的声音，从头到尾不换人。

---

## English Quickstart

ShengChang turns a novel chapter into a finished radio-drama episode: scene/line breakdown → per-character voice mapping → directed TTS (emotion / subtext / intensity / distance folded into one voice instruction) → FFmpeg mix desk with sidechain ducking → loudness-normalized MP3.

**Zero-key first run.** A fresh install ships with a sample project — a condensed, direction-rich excerpt from *Journey to the West* (Chapter 27, public domain) — and defaults to the offline demo engine. Clone, install, run, and the full pipeline (一键成片 one-click episode) works end-to-end with placeholder tones: no API key, no signup, no cost. The plumbing is real; only the voice is a placeholder. Real voices come from a Breeze TTS service running on your own machine (default `http://127.0.0.1:4180`; you download the weights yourself, and their license is non-commercial only); pasting your own novel works without any key via the rule-based breakdown (tagged for manual review), or with a text model you configure yourself (any OpenAI-compatible endpoint; there is no default provider) for full understanding. Doubao (Volcengine) TTS is supported as an optional cloud engine.

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

## 本地运行：Breeze 配音 + 你自己的文本模型

声场的主力配音引擎是在你本机运行的 Breeze，文本模型用你自己配置的 OpenAI 兼容服务。

**运行要求**

- 在本机运行 Breeze 语音服务，声场默认连接 `http://127.0.0.1:4180`。安装步骤见下文「安装 Breeze」。
- 目前只支持 Apple Silicon（M 系列）的 Mac（Intel Mac、Windows、Linux 暂不支持）。
- Breeze 权重需要自己下载，权重许可仅限非商业用途；本仓库不附带、不分发权重。首次需下载约 7.1 GB 的 Breeze 权重。
- 自己配置文本模型：任意 OpenAI 兼容服务，填 Base URL、Key 和模型名。
- 跑完整一集内存峰值约 12 GB，建议 24 GB 以上（16 GB 未测试）。
- Node.js 22.5+，FFmpeg 与 ffprobe 在 PATH 中。

**快速开始**

1. `npm install && npm run dev`，打开 `http://127.0.0.1:4173/`。
2. 设置 → 语音引擎选 Breeze，地址填 `http://127.0.0.1:4180`。
3. 设置 → 文本模型填 Base URL、Key 和模型名，点「测试连接」。
4. 场景导演 → 导入小说并拆解；角色音色 → 为每个角色上传 5–30 秒参考录音做声音克隆，或用 Breeze 音色设计试听后锁定。
5. 制作中心 → 一键成片，确认要配的句数，完成后导出整集 MP3。

**这版能做到的**

- 一键成片只重配改过的句子：改了台词、情绪、语速或锁定的音色，这几句会被标出来并重配，没改过的不动；开始前会显示要配几句。
- Breeze 连不上或没有响应时，界面给出提示，可以重试或去设置；不会自动切换到其他引擎，也不会切到付费服务。豆包语音是可选的云端引擎，不配也能用。
- 某句音频文件丢了，导出会被拦住，并列出是哪几句，可以直接重新生成这几句。
- 导出失败时直接告诉你失败了，可以「重试」，「详情」里有原始报错，可一键复制。

## 安装 Breeze

声场的「本地 Breeze-TTS-2」引擎需要你在自己电脑上跑一个 Breeze 服务，默认地址是 `http://127.0.0.1:4180`，只监听本机。仓库 `breeze/` 目录里有服务脚本，但**不包含模型权重**，权重要你自己下载。

> **许可**：Breeze TTS 2 的权重采用 BreezeBlue Research and Non-Commercial License，**仅限研究和非商业用途**，而且不是开源许可。声场代码是 MIT，但权重不适用 MIT。权重请自己下载，不要提交进仓库，也不要随项目再分发。

### 硬件和系统

- 需要 Apple Silicon 的 Mac（M 系列芯片）。服务用 MLX，跑在 Metal GPU 上，不用 PyTorch / CUDA。Intel Mac、Linux、Windows **未验证**，大概率跑不了，因为 `mlx` 只支持 Apple Silicon。
- 建议 24 GB 以上内存，16 GB 未测试。（实测机器：Apple M4 Pro、48 GB、macOS 26.7.1。配完一整集后，MLX 的峰值显存约 11.7 GB。）
- 磁盘：bf16 权重约 7.1 GB。

### 1. 准备环境

需要 [uv](https://docs.astral.sh/uv/)（实测用 uv 0.9.24，Homebrew 安装：`brew install uv`），以及 Python 3.12（实测 3.12.11，uv 会自动下载）。

```sh
cd breeze
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
```

`requirements.txt` 里的版本是从实际运行的环境里逐个锁定的（mlx-audio 0.6.1、mlx 0.32.4、transformers 5.20.2、fastapi 0.162.0、uvicorn 0.54.0 等）。mlx-audio 原样使用，没有打补丁。
（未验证：没有在一台干净的机器上用这份 requirements.txt 从零装过一遍。）

### 2. 自己下载权重（仅限非商用）

用的是 MLX 转换版：[mlx-community/Breeze-TTS-2-mlx](https://huggingface.co/mlx-community/Breeze-TTS-2-mlx)（bf16，非官方转换）。原始模型是 [BreezeBlue/Breeze-TTS-2](https://huggingface.co/BreezeBlue/Breeze-TTS-2)，下载前请先读它的许可。

```sh
cd breeze
.venv/bin/hf download mlx-community/Breeze-TTS-2-mlx --local-dir models/Breeze-TTS-2-mlx
```

下载不用登录 Hugging Face（实测时没有登录，只会提示“unauthenticated requests”）。下载完，`models/Breeze-TTS-2-mlx/` 里应该有 `config.json`、`model-00001-of-00002.safetensors`、`model-00002-of-00002.safetensors`、`audio_tokenizer/`、`tokenizer.json`、`LICENSE` 等文件。`breeze/.gitignore` 已经忽略了 `models/`。

权重放在别的地方也可以，启动时用 `BREEZE_MODEL_DIR=/你的路径 ./start.sh` 指定。
（未验证：8bit 版 `mlx-community/Breeze-TTS-2-mlx-8bit` 可以省内存，但还没测过音质和稳定性。）

### 3. 启动

```sh
cd breeze
./start.sh
# 输出：started pid 12345; log: logs/server.log
```

服务在后台运行，日志写到 `logs/server.log`，每次生成的耗时和内存记录在 `logs/requests.jsonl`。加载模型约 3 秒（实测 `load_seconds` 为 2.6）。如果 4180 端口已经被占用，脚本会报 `port 4180 already in use` 并退出。要换端口，就用 `BREEZE_PORT=4280 ./start.sh` 启动，声场里的地址也要跟着改。

### 4. 确认 4180 能连上

```sh
curl -s http://127.0.0.1:4180/health
```

正常时返回 HTTP 200 和一段 JSON，`"ok":true`，`device` 是 GPU。实测输出如下（路径做了脱敏，voices 列表做了截断）：

```json
{"ok":true,"model":"<你的路径>/breeze/models/Breeze-TTS-2-mlx","runtime":"mlx-audio","pause_backstop_default":true,"device":"Device(gpu, 0)","load_seconds":2.6,"voices":["bajie","laoweng", …],"requests":143,"errors":0,"max_peak_gb":11.65…}
```

刚装好时 `voices` 是 `[]`，`requests` 是 0。声场在设置页判断“已连接”时，调用的是 `GET /voices`（返回 `{音色id: 参考文本}`）：

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4180/voices   # 期望 200
```

如果连不上：先看 `logs/server.log` 里有没有 `Uvicorn running on http://127.0.0.1:4180`，再确认权重路径对不对。

### 5. 停止

```sh
cd breeze
./stop.sh
# 输出：stopped 12345
```

`stop.sh` 只会停掉 `logs/server.pid` 里记录的那个进程。

### 6. 在声场里连上 Breeze

打开声场的设置页，语音引擎选「本地 Breeze-TTS-2」，「Breeze 服务地址」填 `http://127.0.0.1:4180`（这也是默认值），只填 `http://主机:端口`，不用加 `/tts`，然后保存。这个地址是声场服务端去连的，浏览器不会直接连 Breeze。

注意：Breeze 地址也是配音缓存的一部分。已经配过音的项目如果改了这个地址（哪怕只改端口），所有 Breeze 配过的句子都会被标成需要重配。重配在本机进行，不花钱，但要等全部重新生成。所以地址定下来以后就别再改了。

### 角色音色存在哪里

角色音色由声场通过 `POST /voices` 注册，保存在 `breeze/voices/<id>.wav` 和 `<id>.txt` 里。这些是你本机的音频，已经被 `.gitignore` 忽略。删了它们，对应角色就得重新设计音色。

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

| 能力 | 无任何密钥（演示引擎） | 配置文本模型 | 接上本机 Breeze |
|------|-----------|-------------|-------------|
| 示例项目一键成片 | ✅（占位音） | — | ✅ 真实语音 |
| 导入自己的小说 | ✅ 规则拆解（建议人工校对角色归属） | ✅ 语义拆解 | — |
| 生成真实语音 | ❌ | ❌ | ✅ |
| 方向实验室对比 | ✅（占位音） | — | ✅ |

离线演示引擎的定位：链路是真的，声音是假的。设置页会在演示引擎激活时提示。真实语音的主力是本机 Breeze（不需要云端 Key）；豆包语音和自定义 HTTP 是可选的另外两种引擎。

## 模型配置

进入左下角“设置”。语音引擎有四种：本机 Breeze（主力）、豆包语音（可选云端）、自定义 HTTP、离线演示：

- 豆包语音（火山引擎新版 API Key）：`/api/v3/tts/unidirectional` 流式接口，使用 `X-Api-Key` 请求头，按 Resource ID 选择模型（`seed-tts-2.0` 或 `seed-icl-2.0`）。`seed-tts-2.0` 下，台词的情绪、情绪强度、语速和潜台词会合并为一条只描述情绪与节奏的语音指令送入 `additions.context_texts`（实测音色类指令无效，声音距离不再进指令）；哪些音色实测“可导演”记录在 `server/directable-voices.json`，用 `scripts/measure-instruction.mjs` 复测；`seed-icl-2.0` 仅使用台词文本与语速。
- 本机 Breeze：`/tts` 的 `instruction` 由声场生成并以声场为准（`server/model-adapters.js` 的 `breezeInstruction`，规则与 Breeze 自带的一致：情绪程度 + 语速 + 潜台词，≤ 300 字，不加音色稳定从句、不写停顿）；没有任何表演参数时发空字符串，即纯克隆。Breeze 在 `X-Instruction-B64` 回显实际用的指令，不一致时服务端只记一条警告日志。
- 自定义 HTTP：使用 JSON 请求头和请求体模板连接其他服务。请求体模板支持 `{{text}}`、`{{voiceId}}`、`{{emotion}}`、`{{emotionScale}}`、`{{speed}}`、`{{model}}`、`{{subtext}}`、`{{distance}}` 等变量。
- 开发测试引擎（demo）：只用于离线验证生成、回放和导出链路，不用于正式制作。

小说拆解使用 OpenAI Chat Completions 兼容接口（出厂不预填任何服务商，Base URL、Key 和模型名都由你在设置页填写；可以接 DeepSeek / OpenAI 等云端服务，或本机的 Ollama、LM Studio、vLLM、llama.cpp server——地址可以只填 base URL，如 `http://127.0.0.1:11434/v1`，本地服务的 API Key 可留空；不支持 `response_format: json_object` 的服务会自动降级重试）。拆解结果里每个角色可带一句可选的 `voiceDescription`（给 Breeze 音色设计用的声音描述）。在设置页填写 Base URL、API Key（如需要）和模型名称后，可用“测试连接”发起一次很短的真实请求验证（20 秒超时，结果区分 Key 错误 / 地址或模型名错误 / 连不上 / 其他上游错误，见 `docs/openapi.yaml` 的 `TestLlmResult`）。API Key 只保存在本机，不会回传给浏览器（界面只显示末 3 位，如 `···abc`）；更换地址后需要重新填写 Key，已保存的 Key 不会发给新地址——语音合成和音效生成的凭证、以及自定义请求头里的密钥也按各自的接口地址遵循同一规则。语音引擎（Demo / 豆包 / Breeze / 自定义）的地址、Key 和参数按引擎分别保存（配置文件里的 `ttsProviders`），切换引擎不会清空其他引擎的设置，切回去即可继续用；上面的“换地址清 Key”规则只在同一个引擎内生效。旧版本的配置第一次读取时会自动迁移，不丢数据。长篇原文按段落分块处理（兼容单换行分段的网文格式），并携带已经确认的角色表来保持人物 ID 连续。拆解的输出是体量很大的 JSON（每句台词都带完整导演参数），请求会显式要求 8192 token 输出——请选择输出上限不低于它的模型；若任务报“输出被截断”，请换用输出上限更大的模型，或分章导入减少单段篇幅。

未配置文本模型时，导入小说会自动退回到规则拆解：按章节标题（或固定段落数）切分场景，用引号与说话人动词（“X说：「…」”，含英文直引号）推断对白归属，代词跟随最近说话人，无法归属的文本一律归为旁白。规则拆解的结果会在场景侧栏标记“规则拆解 · 建议人工校对”，角色归属与场景切分可在工作台内手动修正。

角色音色的配置方式：

1. 本机 Breeze：为角色上传一段 5–30 秒的参考录音做声音克隆（5–10 秒可用但会提示效果可能不稳定，推荐 10–30 秒）；或用 Breeze 音色设计按声音描述生成试听，选中后锁定。
2. 在角色音色页直接为角色填写已有的 `voice_id` / `speaker_id`（豆包语音、自定义 HTTP）。
3. 可选：豆包音色设计接口——填写基础 `speaker_id` 和声音描述，创建并锁定新的 `speaker_id`（仅新版豆包语音 API Key 连接支持）。

## 声音资源系统

声音事件（环境声/音效/音乐）的供给来自三条路径，统一在场景内的「获取素材」选择器中收拢：

- **推荐**：按事件描述文本做规则匹配（同义词表 + 词频加权 + 类型门槛 + 全项目使用一致性加成），给出最匹配的候选；纯本地计算，无需密钥。
- **内置素材库**：随应用分发 20 条 CC0 素材（环境声场、动作音效、音乐情绪床，`server/builtin-assets/`），启动时登记进媒体目录，素材页与选择器中可直接试听、绑定；内置素材为共享只读资源，不可删除。当前清单由 `scripts/build-builtin-assets.mjs` 程序合成（仓库自有内容），未来引入外部素材时只允许 CC0 或已获商用授权的内容，并需在 `manifest.json` 中登记授权信息。
- **AI 生成 / 本地导入**：音效与音乐生成在设置页单独配置（演示引擎离线可用，或用请求体模板接入任意 text-to-SFX 服务，变量为 `{{prompt}}`、`{{durationSec}}`、`{{type}}`、`{{model}}`）。生成走持久任务管线，按“描述 + 时长 + 类型”内容寻址缓存，同一描述重复生成直接命中。本地导入支持 MP3/WAV/OGG/M4A/FLAC。

整集导出会自动生成《来源清单》：内置（CC0）、AI 生成（附描述与所用服务）、本地导入分组列出，随 MP3 一起下载。

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
5. 在声音素材页导入音乐、环境声、动作音效和人物主题，试听并选择具体声音事件进行绑定。删除素材时先自动解除全部绑定，服务器确认无任何引用后才从磁盘移除文件。点击声音事件的「获取素材」可打开选择器：推荐（按事件描述匹配）、内置库、AI 生成、本地导入四条路径一个入口。
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

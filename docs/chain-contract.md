# 声场 · 前端整条链路的接口约定（chain contract）

范围：导入小说 → 角色 → 设计/锁定声音 → Breeze 配音 → 审听/修正 → 导出 mp3。
基线：后端 0009–0043（0044 只动服务端缓存键，src/** 不受影响）。本文只描述前端**实际依赖**的字段；
与 `docs/openapi.yaml` 或设计稿不一致的地方集中列在最后。

## 1. 调用的接口（`src/lib/chain-api.js`，`apiRequest` 保留错误的 `code` / `field` / `status` / `payload`）

| 用途 | 方法 + 路径 | 前端用到的字段 |
|---|---|---|
| Breeze 健康 | GET `/api/engines/breeze/health` | `ok`, `via`（`'busy'` = 可达、正在生成，显示「生成中」）, `latencyMs`/`voiceCount`（可为 null）, `inFlightCount`, `lastSuccessAt` |
| 文本模型测试 | POST `/api/config/test-llm` | 见 §3 |
| 设置读写 | GET/PUT `/api/config` | 见 §4 |
| 声音设计 | POST `/api/projects/:p/roles/:r/voice-design/takes` `{description,testLines,count}` | 返回 job；`testLines` 目前只发 1 句 |
| 任务轮询 / 取消 | GET / DELETE `/api/jobs/:id` | `status`, `progress`（0–100）, `queuePosition`, `result`；取消返回布尔 |
| 一键任务 | GET `/api/tasks/:id`；重试 POST `/api/tasks/:id/retry`（或重新提交一键） | `status`, `result`, `failed.code` |
| 声音参考 | GET/POST `/api/projects/:p/roles/:r/voice-reference`（锁定 `{takeId}` 或上传 multipart） | 警告 `REFERENCE_SHORT` → 软提示；上传 5–30 秒，5–10 秒软提示 |
| 改声音影响 | GET `…/voice-reference/impact` | 受影响句数 |
| 定声音进度 | GET `/api/projects/:p/voice-readiness` | 缺声音的角色名单 →「还有 N 个角色没定声音」+「去给X定声音」，不自动分配 |
| 单句换一条 | POST `/api/lines/:l/takes` `{projectId, seed?}` | 可能直接带 `progress`/`startedAt`；失败事件带 `code`/`causeCode` |
| 单句版本 | GET `/api/lines/:l/takes?projectId=`；POST `…/takes/:t/accept` | `seed`（只在「详情」显示，注明「仅存档，不能用来复现声音」）, `renderSeed`, `reused`（不新增一行，提示「和已有的一版相同」）；缓存命中不新增版本 |
| 时间线 | GET `/api/projects/:p/timeline` | `lines[].stale`（「需重渲」只看它）, `staleLineCount`, `lastExport` |
| 导出预检 | GET `/api/projects/:p/export-precheck[?sceneId=]` | `staleLineCount`, `pendingLineCount`, `pendingCharCount` |
| 导出 | POST `/api/projects/:p/export-episode` | job → mp3（无字幕/SRT），结果带 `staleLineCount` |
| 估算 / 一键 | POST `/api/projects/:p/one-click-estimate`；POST `/api/projects/:p/one-click` | `requestCount`, `characters`, `estimatedBillableCharacters`；结果 `causeCode`, `skippedCount`, `skippedLineIds`, `completedLineCount`, `remainingLineCount`, `staleLineCount` |

stale 计数（预检 / 一键 / 时间线 / lastExport）一律**照原样显示**，前端不重新计算。

## 2. 只在前端的功能

- 文本模型「已连通」标记存在 localStorage（服务端没有 `llmVerified`）。没连通时导入被拦下：
  「文本模型还没连通，先去设置里测试一下」+「去设置」。建议后端提供 `llmVerified`（见 §9）。
- 「已切到豆包，需要确认一次」的标记在 localStorage，只作用于一键生成。
- 排队文案：progress 为 0 显示「排队中」，有 `queuePosition` 时「排队中，前面还有 N 句」。

## 3. test-llm

- 永远 HTTP 200 `{ok, latencyMs, code, message, status?}`，**以 `ok` 判断**。
- `ok` →「连接正常，用时 N 秒」；`LLM_AUTH` →「Key 不对或已过期」；`LLM_NOT_FOUND` →「地址或模型名不对，请检查是否以 /v1 结尾」；
  `LLM_UNREACHABLE` →「连不上这个地址」；`LLM_UPSTREAM`/其他 → 原始 message。
- HTTP 400 `LLM_CONFIG_INVALID` 按 `field` 显示在对应输入框下面。
- 地址末尾的 `/chat/completions` 自动去掉并提示；改了地址而 Key 是已保存的 → 「改了地址，请重新填 Key」。
- 允许不测试就保存。前端从不对默认的 volces Ark `llmEndpoint` 发测试。

## 4. 设置 / 密钥

- 扁平字段 = 当前引擎的配置。`ttsProviders.{demo|volcengine-api-key|breeze|custom}` 是各引擎的存档：
  切换引擎时有存档就读存档，没有才用预设（`shared/tts-presets.mjs`，与服务端同一份，未改任何值）。
  **PUT 时不发送 `ttsProviders`**（`configForSave`）。
- 密钥只回显提示：「已设置 ···abc」+「更换」（含 `sfxSecretHint`）。`__SAVED_SECRET__` 原样回传，界面上显示为掩码。
- 文本模型用 `sameLlmEndpoint` 判断是否沿用旧 Key；TTS / 音效用 `sameEndpoint`（比较 `effectiveTtsEndpoint`）。
- Breeze 地址末尾 `/tts` 自动去掉：「已去掉末尾的 /tts，只需填服务地址」。

## 5. Breeze 断开（BREEZE_UNREACHABLE）——绝不自动改用豆包

- 引擎只在用户自己去设置里切换时才变；提示里没有「换豆包」按钮。测试：`src/lib/breeze-outage.test.js`、`server/breeze-no-fallback.test.js`。
- 判定：错误或任务的 `code`（`failed.code || result.code`）为 `BREEZE_UNREACHABLE`。
- 计数（取第一个有的）：已配好 = `completedLineCount` ?? `doneCount` ?? `freshCount+cacheHits` ?? `估算 requestCount − 剩余` ?? `results.length`；
  还剩 = `remainingLineCount` ?? `skippedCount` ?? `remainingCount` ?? `failedCount` ?? `skippedLineIds.length`。
- 开始前（已配好 0 或 POST 直接报错）：「Breeze 连不上，还没开始配音，没有花任何额度。请确认 Mac 上的 Breeze 服务已启动。」+「重试连接」/「去设置」。
- 中途：「Breeze 中途断开，已配好 N 句，还剩 M 句」+「Breeze 恢复后继续」= 重新提交同一个一键（已完成的句子走缓存，已在真实服务上验证：12 句断在第 2 句后，重跑 cacheHits 4 / fresh 6）。
- 0042：连接出错时服务端先探测 Breeze，还活着就照旧自动重试；确认连不上才以 BREEZE_UNREACHABLE 停下。横幅的「重试连接」/「Breeze 恢复后继续」只处理这种确认断开的情况；前端没有自己的重试逻辑。
- 只显示一条横幅。`causeCode: 'BREEZE_TIMEOUT'` 时多一行「原因：Breeze 太久没有响应」。
- 0043：Breeze 连不上 / 进通道前就失败时，单句换一条只有 queued → failed（没有 started）。前端 `takeJobPatch` 不依赖之前的状态：直接变成失败、清掉排队位置，不留转圈，也不显示任务 message（如「命中缓存」）。
- 单句换一条失败：只在这一句上提示（「Breeze 连不上 / 太久没有响应，这一句没生成，没有花额度」），不弹横幅。
- 生成中健康检查偶尔失败不把顶部状态改成「未连接」。
- 用户切到豆包后的第一次一键：确认「接下来 M 句会用豆包生成，约扣 X 字额度，声音也会和 Breeze 不一样」，
  X = `estimatedBillableCharacters ?? characters`；0 句不弹。
- 豆包「换一条」确认：「豆包不支持换种子，重新生成会扣 X 字，结果可能差不多」。

## 6. 导出预检

打开导出对话框时请求预检：
- `staleLineCount > 0` →「还有 N 句改过但没重新配音」+「先重配这 N 句」/「按现在的版本导出」。
- `pendingLineCount > 0` →「还需渲染 N 句，约 X 字（估算）」（没有 `pendingCharCount` 时省略字数）。

## 7. 情绪强度 0

- 显示：值为 0 就显示 0（`intensityOf`：缺省 / 空 → 40，夹在 0–100）。
- **Breeze**：滑块旁「不加情绪」，说话意图和情绪选项变灰，并注明「无情绪时不发送」；台词卡显示「不加情绪 · 语速 x」。
  开关常量 `BREEZE_DROPS_EMOTION_AT_ZERO`（`src/lib/intensity.js`，当前为 true）。
- **豆包**：滑块旁小字「豆包上强度 0 按 40 处理」（0040：豆包 / 自定义强度 0 → emotionScale 0.4），不显示 Breeze 的说法；台词卡照实显示「克制 0%」。
- 台词请求：前端**不**删 emotion / subtext，交给服务端 `buildGenerationRequest`。
- 演法试听（direction-lab）：`labVariantRequest(base, variant, provider)`（`src/lib/direction-lab.js`）。
  变体是在台词请求上展开的，台词强度 0 带的 `emotionOff: true` 会漏进每个变体，所以**每个变体都显式写** `emotionOff`：
  Breeze 上 = `variant.intensity === 0`；豆包 / 自定义一律 `false`（服务端只认严格的 `true`）。
  `emotionScale` 用 `emotionScaleFor`（0040：数字 0 → 0.4），没有 `|| 40` / `|| 0.4` 兜底。
  仓库里没有单独的 voice-preview 生成请求，所以只有 direction-lab。
- 强度一律按**数字**发送：滑块 `Number(event.target.value)`；编辑台词的补丁经 `normalizeLinePatch` 把 `intensity` 转成数字后再存 / PUT；
  变体强度也先转数字。字符串 `"0"` 在豆包上会落到旧规则（0.1），有测试保证序列化成 `0`。

## 8. 设计稿 / openapi 与实现的差异（未改，留给决定）

- 没有 unlock / relock / 声音历史接口；`MissingRole` 没有原因字段（自动设计失败时显示「未设计」+「自动设计没成功 · 原因：…」靠 job 错误）。
- 没有标记接口；`LineTakes` 不带 `line`；没有 ETA、`voiceDrift`；只有轮询；transcribe 接口未用（ASR 不在范围）。
- 导出 = 重新混音，不能撤销；原始音频不算一个版本；接受版本会清掉标记；清理旧版本时不保护进行中的版本；导出文件名带 UUID 前缀。
- progress 是 0–100；`VoiceReference` 字段名与 openapi 不同；时间线 `lufs` 是旧值；`endMs` 不含停顿。
- GET timeline 304 句约 15 秒；test-llm 有 500 路径；默认 `llmEndpoint` 指向 volces。
- 窄屏（≤640px）原有样式隐藏了「生成本场」按钮和右侧检查器（未改样式，范围冻结）。

## 9. 建议

- 服务端提供 `llmVerified`（最后一次 test-llm 成功的地址+模型+时间），替代 localStorage。
- 一键结果统一带 `completedLineCount` / `remainingLineCount`（0037 已有），前端可删掉 0036 的回退推算。

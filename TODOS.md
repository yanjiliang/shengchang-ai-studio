# TODOS

Deferred work, captured with context so a future session (or contributor) can pick
any item up cold. The v1 follow-up list also lives in the 一键成片 design doc
(`~/.gstack/projects/peiyin/laosi-unknown-design-20260813-171811.md`, Next Steps §8):
direction A/B lab, GitHub Actions, Docker, server estimate endpoint with cache-hit
prediction, attention-list deep links, stage-checklist progress panel, asset-file
deletion policy, media-store/story-analyzer golden-file tests.

## TODO-1: Offline rule-based 拆解 fallback — SHIPPED 2026-08-18

Implemented in `server/story-analyzer.js` (`heuristicAnalysis`): chapter-heading
splitting with fixed-paragraph regrouping fallback, quote + speech-verb
attribution (lazy name capture, pronoun -> last speaker, filler stripping),
unattributed speech -> narrator, synthesis-length narration chunking. Engages
only when `validateLlmConfig` fails; results carry `breakdown: 'heuristic'`,
persisted to project state, shown as a sidebar badge and labeled in the task
message. Covered by `server/story-analyzer.test.js` and e2e check #11.

## TODO-2: Per-line continue-past-errors - SHIPPED 2026-08-18

Shipped together with B3: the per-request loop now lives in the exported
`runGenerationRequests` helper (`task-manager.js`), which collects per-line
failures and continues instead of aborting. Partial failures complete the task
with `result.failures[]` (lineId, text, error); all-failed runs keep `failed`
status for one-click retry (successful lines replay from cache for free).
The task history in 制作中心 renders a per-line failure detail list; toasts
carry the failure count. The old "已完成的 N 句已进入缓存" message is superseded.

## Done 2026-08-18 (session follow-ups)

- Initial commit created (repo previously had zero commits).
- GitHub Actions CI added (`.github/workflows/ci.yml`): Node 22, ffmpeg via apt,
  `npm test` + `npm run test:e2e`.
- TODO-1 shipped (above).
- B3 shipped: `runGenerationRequests` extracted in `task-manager.js` (injectable
  `synthesize` for tests); App.jsx `runGeneration`/`generateBatch` merged into a
  shared `runGenerationTask`. TODO-2 shipped on top of it (above).
- §8 attention-list deep links + stage-checklist panel shipped, adapted to the
  manual workbench: QualityView issues with a locate target deep-link into the
  studio line (voices/sounds/media issues jump to their surface), and a
  project-wide 成片进度 stage panel (拆解/音色/对白/素材/导出) links to the view
  where each stage is fixed.
- 一键成片 orchestrator shipped (design B3-B5, now in THIS repo):
  `server/one-click.js` five-stage pipeline with completedStages checkpointing
  (payload merge in `updatePersistentTask`), preset voice auto-mapping that
  never overwrites user choices, endpoint guards (409 live-run / 400 empty /
  provider preflight / OV-4 autosave 409), `shared/generation-requests.mjs`
  request contract shared by browser + server, estimate endpoint with
  cache-hit prediction, UI button + confirm + auto-switch to tasks tab.
  Zero-key end-to-end (heuristic 拆解 + demo provider) covered by e2e.
- Docker shipped: `Dockerfile` (node:22-slim + ffmpeg) + `.dockerignore`,
  single-port 4174, runtime/config volumes; README section added.
- Asset-file deletion policy shipped: `DELETE /api/assets` removes the file
  from disk only when no project references it; browser unbinds + flushes
  before deleting.
- story-analyzer golden-file test shipped (`story-analyzer.golden.test.js` +
  `fixtures/heuristic-golden.json`); building it caught and fixed a real
  attribution bug (bare verb 道 false-positive on 知道, verb-quote gap crossing
  sentence ends). media-store golden tests remain open - export output is not
  byte-deterministic, needs a structural-diff approach.

## Done 2026-08-18 (review fixes)

- Voice-design previews no longer leak files: the demo preview round-trips as
  a base64 data URL instead of an untracked file on disk (nothing referenced
  it, nothing could reclaim it).
- `splitNovel` packs single-newline-separated novels at paragraph boundaries
  instead of hard-cutting them mid-sentence; structure is preserved verbatim.
- Heuristic 拆解 understands ASCII straight quotes (common in web novels) for
  both quote extraction and speaker attribution; covered by unit tests.
- Loopback API guard: `/api` rejects requests whose Host or Origin is not
  loopback (form-POST CSRF + DNS-rebinding protection for the local server).
- Dockerfile runs as the non-root `node` user; config volume moved to
  `/home/node/.shengchang`.
- `applyResultsToProject` only marks a scene `ready` once every dialogue line
  has audio; partial-failure writes keep the previous status.
- media-store structural tests shipped (`media-store.test.js`): render real
  timelines through ffmpeg and assert duration/format with ffprobe. They
  immediately caught two real bugs, both fixed: sidechaincompress truncated
  looped beds at the end of the last dialogue (sidechain input now padded),
  and rendered files came up short whenever totalDuration included phantom
  tail gap (final chain now pads to the reported duration).

## Done 2026-08-18 (follow-up tasks, design §8)

- **B2 sample project**: `server/sample-project.js` seeds 西游记·第二十七回
  节选（公版）— 3 scenes, 19 directed dialogue lines, 7 characters, sound
  events, full direction data (subtext/emotion/intensity/distance). Boot path
  seeds only genuinely fresh installs (countProjects() includes archived
  rows); `npm run seed` force-adds to existing installs, marker-idempotent.
  Empty project list now renders a welcome screen instead of hanging.
  Acceptance: sandbox one-click on the sample completes — 19/19 voiced,
  7 voices auto-mapped, 3 scenes exported.
- **Direction lab (Approach C)**: same line × 3 direction takes (可编辑
  情绪/强度/潜台词/距离) auditioned side by side in the Inspector. Server
  kind `direction-lab` skips project writeback; takes land in the audio cache
  keyed by direction params, so apply-take → regenerate is an instant cache
  hit. Covered by e2e checks (no-writeback + take audio served).
- **README bilingual rewrite**: English quickstart (zero-key first run), 中文
  深度文档, zero-key capability table, security boundary notes.
- **Design A5**: fresh installs default to the demo provider (zero-key first
  run); Settings 面板 shows a dismissible demo-engine banner.
- **Sample content tests**: `server/sample-project.test.js` validates the
  hand-authored direction data (full direction fields, unique ids, speaker
  roster coverage, scene cast sync, sound events). 51/51 unit tests green.

## Done 2026-08-19 (launch prep, /office-hours checklist)

- package.json: `private` removed, description/license/keywords added for the
  public repo (repository field pending the GitHub URL).
- Docker smoke test on a real daemon: PASSED — and it caught a real bug. The
  server bound `127.0.0.1` unconditionally, which makes `docker run -p`
  unreachable (published ports forward to the container interface, never its
  loopback). Fixed via `SHENGCHANG_BIND_HOST` (default stays `127.0.0.1`;
  Dockerfile sets `0.0.0.0`; the Host/Origin loopback guard remains the
  security boundary). Verified: host curl → 200, /api/health ok with ffmpeg,
  sample project auto-seeds into the named volume as the node user (the
  mountpoint-ownership fix works — sqlite + media dirs all node-owned).
  51/51 unit tests green after the change.

## Done 2026-08-19 (launch: GitHub publish)

- Code is on GitHub: https://github.com/yanjiliang/shengchang-ai-studio —
  main pushed, `v0.1.0` tagged and pushed, `repository` field added in
  095dcb6. Repo was created PRIVATE; owner needs to flip visibility to public
  (Settings → Danger Zone → Change visibility).
- Owner web-UI settings still pending: description, topics, Discussions,
  social preview image (checklist in the launch design doc step 2).

## Done 2026-10-15 (repo went public, launch checklist closed via gh)

- Visibility flipped to PUBLIC (`gh repo edit --visibility public`).
- Description, 14 topics, Discussions enabled via gh (see `gh repo view`).
- README now carries CI + license badges (public-repo face).

## Still open

- Social preview image: gh/GitHub API cannot upload it — one manual web
  upload (Settings → Social preview), use `public/brand/launch-cover.jpg`.
- Real-voice demo episode MP3: must be rendered by the owner with a 豆包 key
  (一键成片 on the sample project), then referenced from README's demo section.
- Silent-week check (from the launch design doc): verify whether GitHub renders
  an inline `<audio>` player for a committed `docs/demo/*.mp3` on the live
  repo. Pre-check 2026-08-19: html-pipeline's default sanitizer allowlist has
  no `audio`/`video` elements, so inline `<audio>` will likely be stripped;
  expected landing = GitHub-uploaded mp4 screen recording (renders a player in
  markdown) + a prominent raw-MP3 link. Confirm on the live (now public) repo.

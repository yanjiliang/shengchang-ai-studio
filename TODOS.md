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
  shared `runGenerationTask`. TODO-2 shipped on top of it (above). NOTE: the
  one-click orchestrator from the 一键成片 design doc (one-click.js, stage
  checkpointing) was never built in this repo - the design doc's B3–B6 plan is
  the blueprint if it is ever wanted here.
- §8 attention-list deep links + stage-checklist panel shipped, adapted to the
  manual workbench: QualityView issues with a locate target deep-link into the
  studio line (voices/sounds/media issues jump to their surface), and a
  project-wide 成片进度 stage panel (拆解/音色/对白/素材/导出) links to the view
  where each stage is fixed.

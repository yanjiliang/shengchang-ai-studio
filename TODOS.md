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

## TODO-2: Per-line continue-past-errors for batch generation

- **What:** Change the generation loop to record per-line failures and continue,
  instead of aborting at the first `synthesize` error, so one run surfaces ALL
  failing lines at once.
- **Why:** Better batch UX on large novels - today one bad line hides the state of
  everything after it; the user fixes and retries blind.
- **Pros:** Complete failure visibility per run; pairs naturally with an
  attention-list UI.
- **Cons:** Changes the manual generation flows' behavior (premise 3 tension from
  the v1 design - "manual workbench untouched"); needs UI to surface per-line
  failures, not just a count.
- **Context:** Rejected for v1 at the 2026-08-14 eng review (OV-2) to keep manual
  flows byte-identical. The natural moment to revisit is when B3's
  `runGenerationRequests` extraction has landed - the helper becomes the single
  place both manual and orchestrated generation flow through. Note the existing
  failure path already captures partial results (`task-manager.js` - "已完成的 N
  句已进入缓存").
- **Depends on / blocked by:** B3 extraction (`runGenerationRequests`) landed.

## Done 2026-08-18 (session follow-ups)

- Initial commit created (repo previously had zero commits).
- GitHub Actions CI added (`.github/workflows/ci.yml`): Node 22, ffmpeg via apt,
  `npm test` + `npm run test:e2e`.
- TODO-1 shipped (above).

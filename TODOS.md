# TODOS

Deferred work, captured with context so a future session (or contributor) can pick
any item up cold. The v1 follow-up list also lives in the 一键成片 design doc
(`~/.gstack/projects/peiyin/laosi-unknown-design-20260813-171811.md`, Next Steps §8):
direction A/B lab, GitHub Actions, Docker, server estimate endpoint with cache-hit
prediction, attention-list deep links, stage-checklist progress panel, asset-file
deletion policy, media-store/story-analyzer golden-file tests.

## TODO-1: Offline rule-based 拆解 fallback

- **What:** A no-LLM fallback for novel breakdown — split on paragraph/chapter
  markers, attribute dialogue by 引号 + 说话人 heuristics, map unattributed lines
  to narrator — so paste-your-own-novel works with zero API keys.
- **Why:** Removes the last key requirement from the headline 一键成片 flow. Today
  zero-key only works on the seeded sample project (which ships pre-seeded scenes);
  a stranger's own novel dies at stage 1 without an LLM key.
- **Pros:** True zero-key 一键成片 for any text; much stronger demo story.
- **Cons:** Chinese dialogue attribution is genuinely hard; a bad breakdown is a
  worse demo than a clear "configure LLM" message (this is why v1 chose honest
  framing instead, eng-review OV-3).
- **Context:** Rejected for v1 at the 2026-08-14 eng review in favor of documenting
  the LLM-key requirement. Entry point: `server/story-analyzer.js` (`splitNovel`
  already does paragraph-aware chunking at 24,000 chars — reuse it). The fallback
  should only engage when `validateLlmConfig` fails, and the UI should label the
  result as a heuristic breakdown.
- **Depends on / blocked by:** v1 shipped.

## TODO-2: Per-line continue-past-errors for batch generation

- **What:** Change the generation loop to record per-line failures and continue,
  instead of aborting at the first `synthesize` error, so one run surfaces ALL
  failing lines at once.
- **Why:** Better batch UX on large novels — today one bad line hides the state of
  everything after it; the user fixes and retries blind.
- **Pros:** Complete failure visibility per run; pairs naturally with an
  attention-list UI.
- **Cons:** Changes the manual generation flows' behavior (premise 3 tension from
  the v1 design — "manual workbench untouched"); needs UI to surface per-line
  failures, not just a count.
- **Context:** Rejected for v1 at the 2026-08-14 eng review (OV-2) to keep manual
  flows byte-identical. The natural moment to revisit is when B3's
  `runGenerationRequests` extraction has landed — the helper becomes the single
  place both manual and orchestrated generation flow through. Note the existing
  failure path already captures partial results (`task-manager.js` — "已完成的 N
  句已进入缓存").
- **Depends on / blocked by:** B3 extraction (`runGenerationRequests`) landed.

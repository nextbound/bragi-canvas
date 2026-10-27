# Wan Prime and Vidu merge validation — 2026-10-27

## Coordinated candidates

The feature is coordinated through plugin PR [#156](https://github.com/nextbound/bragi-canvas/pull/156), skill PR [#94](https://github.com/nextbound/bragi-canvas-skill/pull/94), and website PR [#15](https://github.com/nextbound/bragi-canvas-site/pull/15).

The candidates incorporate the concurrent Kling 4.0 main-branch updates: plugin `0540e16`, skill `75169c8`, and website `814582c`. Conflict resolution retains both independent APIMart request builders, both audio-reference paths, Kling keyframe bindings and media validation, Vidu mode inference, and connected prompt support. The documentation includes both integrations as unreleased additions.

Vidu prompt-free first-frame generation also passes the multi-node batch entry point. Its regression checks cover valid single-image dispatch and rejection of blank image-reference/audio combinations, while preserving Wan's prompt requirement and Kling's frame exception. MCP regression checks preserve connected prompt text for Vidu image-reference generation.

## Validation

- Plugin `npm run verify`: passed, including English, types, lint, all regression suites, catalog/version validation, and production build.
- Plugin `npm run audit:catalog`: passed, 260 model/provider/mode combinations.
- Skill and website `npm run verify`: passed.
- Website `npm run check:releases`: passed against stable plugin 1.44.0.
- Workspace English and explicit-path plugin/skill/website sync: passed, 1.44.0 and 27 MCP tools.
- The merged website production preview served all three edited guides with Wan Prime and Vidu content. The video and provider guides retained Kling 4.0 content. Searching for Vidu returned all three edited guides.
- Whitespace/conflict-marker review: passed in all affected repositories.

Workspace-local logs and preview results are stored under `validation/2026-10-27-wan-prime-vidu-merge/`. GitHub must validate the resulting candidate heads before the coordinated merges.

## Evidence boundaries

The three successful live generations remain the evidence from [October 26](2026-10-26-wan-prime-vidu.md). They were not repeated after incorporating Kling 4.0. The current build is covered by the new automated checks; it is not claimed to be byte-identical to the earlier live-tested build.

The API and asset Workers need no changes. No version bump or stable plugin release is included. The published catalog and release records stay on 1.44.0; update them from the eventual published stable tag before that release is considered complete. Unrelated primary-checkout changes remain untouched.

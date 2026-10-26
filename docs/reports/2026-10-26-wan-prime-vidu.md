# Wan Prime and Vidu integration verification — 2026-10-26

## Candidate and scope

All three repositories use `feat/wan-prime-vidu` in isolated worktrees. The plugin starts at `309b244`, the skill at `7b4e337`, and the website at `7146e55`. Existing primary checkouts and their unrelated changes were preserved. No version bump, merge, installation into the primary vault, release, or deployment was performed.

- Plugin: Wan 3.0 stays `wan-3.0`; Version selects Standard (default) or Prime on DashScope. Prime submits `wan3.0-video-prime` and retains that identity in the async task snapshot. All existing five modes are retained.
- Plugin: add explicitly enabled APIMart Vidu Q4 Preview (`vidu-q4-preview` → `viduq4-preview`). First-frame accepts one image with an optional prompt. Image-ref requires text and 1–15 images, optionally up to three MP3 clips. A single reference image has an explicit reference role. Validate unsupported media, format, counts, size, duration, resolution, audio, and seed before submission; use existing Relay and task recovery.
- Skill candidate: `9ab61c6e616c159577ed08c78927f2b532340cb4`. Updated model catalog, MCP semantics, prompt exception, inference, gotchas, and recipes. Stable baseline stays 1.44.0; additions are labeled unreleased and require discovery through `list_models`.
- Website candidate: `88e3852726aa8fc5e7c5577bf4188b9ab156f98e`. Updated video, provider setup, and MCP guides. The three pages rendered in a local production preview and Vidu search results included all three.
- API Worker and asset Worker: no changes needed. Both providers use existing direct provider submission, temporary Relay references, polling, and local media persistence.

## Checks

| Check | Result |
| --- | --- |
| Plugin `npm run verify` | Passed: English, types, lint, 43 regression suites, 55-model catalog validation, version alignment, build |
| Plugin `npm run audit:catalog` | Passed: 252 model/provider/mode combinations |
| Skill `npm run verify` | Passed |
| Website `npm run verify` | Passed: English, types, tests, content, production build |
| Workspace `npm run check:english` | Passed |
| Workspace `npm run sync:check` with explicit candidate directories | Passed: 1.44.0 and 27 MCP tools |
| `git diff --check` | Passed in affected repositories |

The added regression suite covers all five Wan modes with Standard/Prime payload parity, invalid variants, Vidu payload limits and roles, empty prompts, opt-in model visibility, MCP mode inference, MP3/size rejection, canvas audio delivery, actual Prime queue identity, task polling, result download, and explicit provider failure.

## Real generation

Used a dedicated QA vault, synthetic image/audio fixtures, and the existing APIMart and DashScope account credentials. Only three generation requests were submitted. The local test harness initially used an incorrect `create_file_node` argument; it was corrected to `filePath` and continued from its submission ledger without resubmitting the accepted Wan task.

| Case | Requested | Saved result | Result |
| --- | --- | --- | --- |
| Wan Prime text-to-video | 2 seconds, 480P, audio off | 854×480 H.264, 2.000 seconds, no audio stream | Passed |
| Vidu first-frame with empty prompt | 3 seconds, 540p, audio off | 960×540 H.264, 3.042 seconds, no audio stream | Passed |
| Vidu one reference image plus MP3 | 3 seconds, 720p, audio on | 1280×720 H.264 + AAC, 3.042 seconds | Passed |

All three tasks completed through the plugin MCP flow and became connected local video nodes. `ffprobe` confirmed dimensions, duration, and audio presence; `ffmpeg` decoded each complete file without errors. The Vidu first-frame UI showed no ratio control and default duration 5s, 720p, audio on, and seed 0. Wan defaulted to Standard and offered Prime. UI inspection did not submit extra generations.

The test vault was closed; copied provider credentials were removed and its MCP server was disabled. The final built `main.js` is byte-identical to the live-tested build (SHA-256 `33063fb8c127211ecd83fbae3ae117726c6961ef28d3d0eda60498b83ad47ede`).

## Evidence and limits

Workspace-local evidence is in `validation/2026-10-26-wan-prime-vidu/`: `live-results.json`, full verification logs, catalog audit, `vidu-controls.png`, `wan-prime-controls.png`, and the sanitized QA vault with three playable MP4s. Do not commit vault runtime settings, uploaded URLs, or media artifacts to provider/plugin repositories.

Live smoke coverage is limited to the three cases above. Wan image/reference modes have automated routing coverage, not new live generation coverage. Higher Vidu resolutions and maximum-length jobs were not generated. APIMart validates the 3–12 second MP3 duration requirement; the plugin checks extension and file size locally. These tests confirm successful requests and valid outputs, not an SLA or perceptual audio-reference fidelity.

The public stable catalog, release records, and website changelog intentionally remain unchanged: export the catalog from the eventual published stable plugin tag and derive release notes from `CHANGELOG.md` as part of that release. Target: before completion of the next stable release containing this branch. Neither model is represented as already released by the candidate docs. Kling was excluded from this implementation.

# Changelog

The canonical Bragi Canvas plugin release history. Historical entries describe behavior at the time of each release. Unreleased entries have not shipped.

## Unreleased

- Keep DashScope voice-design previews within the CosyVoice and Qwen text limits, normalize whitespace, and supply Chinese or English language hints from the preview without shortening the speech text.

- Show generation stages, retry countdowns and paused reasons on placeholders. Stop the loader and shimmer while retrying or paused, with a circular **Resume checking** icon beside the bottom model pill for retained tasks.
- Pause automatic task checks after five failed retries or a 15-minute checking window. Keep the accepted task ID, persisted deadline and downloaded results; resume checks without submitting another generation.
- Bound SVRouter reference preparation, video submission and status/download requests. Explain that reference registration failures happen before video submission, while retaining upstream error details.
- Expose download state, retry count, deadline and pause diagnostics through both MCP task inspection tools.

- Proposed Nano Banana 2 Lite (`nano-banana-2-lite`, `gemini-3.1-flash-lite-image`): direct Gemini image generation at 1K with ten ratios, disabled by default. It is not in the catalog and was not shipped in 1.39.0.

## 1.40.1 — 2026-09-24

- Keep pending audio and video tasks across settings changes and restarts, including tasks belonging to closed canvases. Temporary network and rate-limit failures retry the original task; interrupted downloads and canvas saves can be resumed.
- Add **Resume checking** to generation placeholders and the command palette. Task status now distinguishes waiting, retrying, and issues requiring attention.
- Preserve shared source files when tidying assets. Only the selected canvas is updated, with a backup and clear partial-failure reporting.
- Restrict local MCP requests by Host, Origin, JSON content type, body size, and read timeout while keeping local clients compatible with optional access tokens.
- Add type checking, behavioral regression tests, and consistent pull-request/release checks. Production builds no longer copy files into a development vault.

## 1.40.0 — 2026-09-24

- Added Pika MiniMax H3 generation across text-to-video, first-frame, first-last-frame, image-reference, and video-reference modes, including audio-only references. Local media references use Bragi Relay, and provider errors retain their upstream details.
- Added Sonilo Music with text-to-music and video-to-music modes. Music generation supports MP3, M4A, and WAV output; video inputs follow Canvas edges through Bragi Relay. Sonilo tasks are asynchronous and save playable audio nodes to the canvas.
- Added provider-specific regression checks for Pika and Sonilo. Both integrations were verified with generated media on Obsidian canvases.
- Bumped the plugin version to `1.40.0`.

## 1.39.1 — 2026-09-20

- Fixed failed SVRouter Seedance 2.5 tasks to show the provider error code together with the full error message, including request IDs supplied by the provider.
- Preserved SVRouter JSON error strings and plain-text gateway failures instead of replacing them with JSON parsing errors, including asset registration and status responses.
- Added regression coverage for Seedance task failures, other video task failures, and gateway error responses.
- Bumped the plugin version to `1.39.1`.

## 1.39.0 — 2026-09-10

- Added GPT Image 2.5 on APIMart as one aggregated `gpt-image-2.5` model whose `variant` param picks the `flare` (faster, default) or `sunburst` (editing precision) upstream build, with the extended `xhigh` / `max` quality tiers and up to 16 reference images.
- Extended the APIMart `quality` gate from the official GPT Image 2 channel to every `gpt-image-2.5*` route.
- Widened the `aggregated` provider flag to cover param-keyed upstream routing, not just mode-keyed.
- Added HappyHorse 1.1 on DashScope as the aggregated `happyhorse-1.1` model, routing text-to-video, first-frame, image-ref, and video-edit to `happyhorse-1.1-t2v` / `-i2v` / `-r2v` / `happyhorse-1.0-video-edit`.
- Removed HappyHorse 1.0 entirely: the `happyhorse-1.0-t2v` / `happyhorse-1.0-i2v` catalog entries, the TokenRouter HappyHorse payload branch, and stale settings keys (settings schema 13).
- Made DashScope video downloads model-neutral (`dashscope_video_*`) instead of labelling Wan 3.0 and HappyHorse output as Wan 2.7.
- Restored the API-model-id pencil editor, which had been unreachable since the provider-integration refactor introduced `editableApiModelId` without opting any catalog entry in. All four BytePlus entries (Seedance 2.5 / 2.0 / 2.0 Fast, Seedream 5.0 Lite) now set it, so a custom `ep-...` inference endpoint can be entered again.
- Added `pruneApiModelIdOverrides()`, run on every load: stored API-model-id overrides are dropped when the model leaves the catalog, the provider drops the model, or the pairing is not editable. `resolveApiModelId` applies overrides unconditionally, so an unreachable one silently rewrote every request with no pencil and no "Modified" badge in the UI.
- Moved the id-editability rule into one exported `isApiModelIdEditable()`; the settings pencil, the override pruning, and `audit:catalog` had (or would have had) three separate copies.
- Bumped the plugin version to `1.39.0`.

## 1.38.0 — 2026-09-04

- Added asynchronous SVRouter image task submission and three-second polling for APIMart-backed routes, with a ten-minute maximum wait.
- Preserved the legacy synchronous image endpoint as a compatibility fallback when the gateway does not expose asynchronous tasks.
- Added SVRouter image task endpoint, polling, fallback, and reference-image regression coverage.
- Bumped the plugin version to `1.38.0`.

## 1.37.0 — 2026-08-26

- Upgraded the stable `midjourney-v8` model to Midjourney V8.2 through Legnext, replacing the unsupported quality control with Standard/2K resolution and adding V8.2-compatible stylize, chaos, raw style, stop, and weird controls.
- Added token-aware Midjourney prompt flag handling and V8.2 catalog/request regression coverage while preserving explicit prompt flags and the existing individual-image result selection.
- Bumped the plugin version to `1.37.0`.

## 1.36.2 — 2026-08-24

- Fixed MCP reference-image generation races by waiting for newly imported Canvas edges before reading upstream inputs, including GPT Image 2 edit flows.
- Added 1080p output for Seedance 2.5 in both the canvas generation bar and MCP model parameters.
- Bumped the plugin version to `1.36.2`.

## 1.36.1 — 2026-08-21

- Fixed portrait videos in native fullscreen playback so they are contained within the viewport instead of being cropped.
- Kept canvas video thumbnails on the existing cover-fit behavior while applying fullscreen-specific contain-fit styling.
- Bumped the plugin version to `1.36.1`.

## 1.36.0 — 2026-08-20

- Upgraded the native xAI Grok Imagine image route to `grok-imagine-image-2.0` while preserving the stable Bragi `grok-imagine` model ID.
- Added xAI Image 2.0 aspect ratio, 1K/2K resolution, and Low/Medium quality controls with provider-scoped fal.ai compatibility.
- Upgraded Grok Video generation to `grok-imagine-video-1.5` for text-to-video, first-frame, and image-reference modes while keeping legacy xAI edit and extension routing.
- Added xAI Grok provider, catalog, mode, payload, polling, and documentation regression coverage.
- Bumped the plugin version to `1.36.0`.

## 1.35.0 — 2026-08-14

- Added MiniMax-H3 video generation through APIMart with text-to-video, first-frame, first-last-frame, image-reference, and video-reference modes.
- Added MiniMax-H3 image/video/audio Relay handling, strict frame-versus-reference validation, 4–15 second duration, 2K/768P output, adaptive/fixed ratios, and optional watermarking.
- Added APIMart MiniMax-H3 request, relay, async polling, error, catalog, and documentation regression coverage.
- Bumped the plugin version to `1.35.0`.

## 1.34.2 — 2026-08-13

- Added SVRouter support for Seedance 2.5 through `sv-seedance-2.5`.
- Forwarded SVRouter Seedance 2.5 mode and output format through gateway metadata.
- Added a settings migration that backfills the Seedance 2.5 SVRouter provider connection without changing the active provider.
- Expanded Seedance 2.5 and SV NewAPI video parameter regression coverage.
- Bumped the plugin version to `1.34.2`.

## 1.34.1 — 2026-08-08

- Added a configurable BytePlus Seedance task endpoint in provider settings.
- Applied the configured BytePlus endpoint to Seedance 2.0, Seedance 2.0 Fast, and Seedance 2.5 task submission and polling.
- Kept the current BytePlus Singapore endpoint as the default and made connection tests use the configured endpoint.
- Added BytePlus Seedance endpoint regression coverage.
- Bumped the plugin version to `1.34.1`.

## 1.34.0 — 2026-08-07

- Added Seedance 2.5 video generation for Volcengine and BytePlus.
- Supported Seedance 2.5 text-to-video, first-frame, first-last-frame, multimodal reference, video extension, and video editing modes.
- Added Seedance 2.5 provider validation for duration, adaptive-only modes, resolution, output format, reference limits, and upstream model IDs.
- Added Seedance 2.5 provider regression coverage.
- Bumped the plugin version to `1.34.0`.

## 1.33.0 — 2026-08-07

- Added Wan 3.0 video generation through DashScope, with text-to-video, first-frame, first-last-frame, image-ref, and video-ref modes.
- Added image, video, audio, and PDF reference handling for Wan 3.0, including temporary HTTPS upload support for PDFs.
- Added Wan 3.0 params for 480P/720P/1080P output, adaptive or fixed ratios, auto or 2-30 second duration, generated audio, and seed clamping.
- Added DashScope Wan 3.0 request-shape and validation regression coverage.
- Bumped the plugin version to `1.33.0`.

## 1.32.0 — 2026-08-06

- Added Mureka Music under Audio → Music with prompt-to-song, upstream-lyrics-to-song, and instrumental generation.
- Generalized the persistent async task queue to track and resume both audio and video tasks while preserving older video-only snapshots.
- Unified native MiniMax and Mureka lyrics generation around ordered upstream text nodes, with the target node kept as the music/style prompt.
- Added offline request, polling, download, lyrics guard, batching-contract, and async audio queue regression coverage.
- Bumped the plugin version to `1.32.0`.

## 1.31.3 — 2026-08-05

- Updated the fixed SVRouter gateway base URL to `https://gateway.one-take-ai.com`.
- Bumped the plugin version to `1.31.3`.

## 1.31.2 — 2026-08-03

- Fixed Pika Kling routing to use the current `kling-3.0` API paths.
- Removed the unavailable Pika Kling 3.0 Omni route and hid the unsupported Pika quality selector.
- Updated Pika provider regression coverage and provider rules.
- Bumped the plugin version to `1.31.2`.

## 1.31.1 — 2026-07-31

- Removed the forbidden `obsidianmd/ui/sentence-case` disable comment from the Denoise choice modal.
- Changed Denoise option labels to sentence case for Obsidian community review.
- Bumped the plugin version to `1.31.1`.

## 1.31.0 — 2026-07-31

- Added Pika provider support for Kling 3.0 and Kling 3.0 Omni, including provider-scoped modes and static request verification.
- Added provider-scoped Seedance Asset ID binding to audio file nodes through the canvas context menu and MCP, with `asset://` reuse during video generation.
- Added Seedance 2.0 `4k` resolution support for the generation bar and MCP calls.
- Added local NLM 35 as the default Denoise choice, with a configurable local service URL and static verification.
- Bumped the plugin version to `1.31.0`.

## 1.30.1 — 2026-07-16

- Removed forbidden `obsidianmd/ui/sentence-case` disable comments from Voice Changer UI copy.
- Changed Voice Changer notices and tooltips to sentence case for Obsidian community review.
- Bumped the plugin version to `1.30.1`.

## 1.30.0 — 2026-07-16

- Added ElevenLabs Voice Changer for audio nodes using `eleven_multilingual_sts_v2`: the selected audio supplies content and emotion, one incoming audio supplies the target voice, and every click creates an independent parallel output node.
- Reused cached ElevenLabs custom voices across TTS and Voice Changer, with in-flight clone deduplication for parallel conversions.
- Fixed Kling 3.0 Omni video editing so native Kling and APIMart requests can combine one base video with reference images.
- Added payload regression coverage for Kling 3.0 Omni base-video edits with multiple image references.
- Bumped the plugin version to `1.30.0`.

## 1.29.2 — 2026-07-16

- Fixed Legnext image result selection so single-image outputs prefer the first individual image instead of the composite preview grid.
- Added static verification coverage for Legnext image result parsing.
- Bumped the plugin version to `1.29.2`.

## 1.29.1 — 2026-07-15

- Tuned fal.ai FLUX.2 Klein 9B base inference and request shaping.
- Expanded static verification coverage for fal FLUX Klein routing.
- Bumped the plugin version to `1.29.1`.

## 1.29.0 — 2026-07-15

- Added fal.ai as a provider for FLUX.2 Klein 9B image generation, alongside BFL and Runpod.
- Added static verification for fal FLUX Klein payload routing.
- Fixed the Denoise toolbar action so it is hidden when no available provider supports the action.
- Bumped the plugin version to `1.29.0`.

## 1.28.0 — 2026-07-14

- Renamed SV NewAPI to SVRouter in provider-facing UI while keeping the same `svnewapi` settings key for compatibility, and fixed SVRouter asset registration to use the centralized gateway URL.
- Added Kling 3.0 Omni through the native Kling and APIMart providers, including text-to-video, first/last-frame, multi-image reference, feature-video reference, and video-edit flows.
- Added 3–15 second duration, Standard/Pro/4K quality, optional generated audio, source-audio retention, and advanced multi-shot/subject payload support while keeping the generator bar mode-specific and compact.
- Exposed intelligent multi-shot generation as the default `Multi shots` control, with `Single shot` as the alternative, and clarified generated-audio choices as `Audio On` / `Audio Off`.
- Added payload contract verification for both provider request shapes and native Omni task polling.
- Added FLUX.2 Klein 9B image generation through BFL and Runpod, including reference-image generation, safety tolerance, provider-specific seed handling, denoise defaults, and optional color matching.
- Fixed BytePlus and SVRouter asset failures so terminal `Result.Error.Message` / `Code` details surface when `FailedReason` is absent.
- Added regression verification for BFL denoise, Kling Omni payloads, and BytePlus/SVRouter asset failure messages.
- Bumped the plugin version to `1.28.0`.

## 1.27.3 — 2026-06-24

- Fixed SV NewAPI Seedance Auto duration by forwarding it as `metadata.duration = -1`, matching the direct BytePlus/Volcengine Ark Seedance behavior.
- Added static verification coverage for SV NewAPI video parameters.
- Bumped the plugin version to `1.27.3`.

## 1.27.2 — 2026-06-23

- Fixed SV NewAPI Nano Banana Pro requests by forwarding the selected aspect ratio as APIMart-style `size` and the selected image size as `resolution`.
- Added static verification coverage for the SV NewAPI Nano Banana Pro payload shape.
- Bumped the plugin version to `1.27.2`.

## 1.27.1 — 2026-06-18

- Fixed APIMart GPT Image 2 routing by using the official upstream model ID while keeping Bragi's stable `gpt-image-2` model ID.
- Bumped the plugin version to `1.27.1`.

## 1.27.0 — 2026-06-17

- Added GPT Image 2 (Official) as a selectable APIMart/SV NewAPI image model with quality-aware routing.
- Aligned SV NewAPI gateway model IDs for image, video, audio, and text models.
- Forwarded SV NewAPI media generation parameters for Seedance and fal-routed video models.
- Fixed SV NewAPI GPT Image 2 sizing/quality handling and Seedream image sizing.
- Added SV NewAPI image reference and audio parameter verification scripts.
- Bumped the plugin version to `1.27.0`.

## 1.26.3 — 2026-06-16

- Fixed canvas-scoped duplicate handling so duplicated nodes and generated assets stay associated with the correct canvas.
- Fixed reference thumbnail refresh behavior after duplicate/canvas operations.
- Bumped the plugin version to `1.26.3`.

## 1.26.2 — 2026-06-16

- Fixed TokenRouter GPT Image edit requests so reference images are uploaded and routed correctly.
- Added verification coverage for TokenRouter reference image upload handling.
- Bumped the plugin version to `1.26.2`.

## 1.26.1 — 2026-06-12

- Fixed Obsidian review source warnings by typing the fflate stream callback used during `.bragi` ZIP import.
- Tightened Gemini Files API response parsing to avoid unsafe file/state response access.
- Tightened SV NewAPI gateway asset flow response parsing and error extraction without `any` response access.
- Bumped the plugin version to `1.26.1`.

## 1.26.0 — 2026-06-11

- Added Kling V3 Motion Control mode for character image plus reference motion video generation on the native Kling provider.
- Added APIMart support for Kling V3 Motion Control through the `kling-v3-motion-control` model path.
- Added Motion Control UI handling, including automatic mode selection for one image plus one video, Orientation and Audio controls, and hidden duration/aspect ratio controls for this mode.
- Routed Kling Motion Control reference videos through the relay and added polling for the native `/v1/videos/motion-control` endpoint.
- Restricted non-motion Kling providers to their supported modes so fal, TokenRouter, and SV NewAPI do not expose Motion Control.
- Bumped the plugin version to `1.26.0`.

## 1.25.0 — 2026-06-11

- Expanded SV NewAPI reference media support so Seedance routes image, audio, and video refs through top-level gateway arrays for text-to-video, first-frame, image-ref, and video-ref modes.
- Enabled SV NewAPI Grok video modes for text-to-video, image-ref, and video-extend flows.
- Generalized SV NewAPI provider media upload handling across image, audio, and video refs, preserving HTTP(S) and `asset://` refs when possible.
- Added SV NewAPI gateway asset registration via `/v1/assets`, including per-node cache validation, polling, `asset://` reuse, and graceful fallback when registration is unsupported.
- Fixed SV NewAPI Seedance reference image routing by sending refs through top-level `images`.
- Bumped the plugin version to `1.25.0`.

## 1.24.0 — 2026-06-10

- Added the provider integration standard: provider/model differences are now declared in the catalog, including aggregated providers, editable API model IDs, provider-specific modes, parameter overrides, and reference-media delivery behavior.
- Added centralized reference-media delivery with relay, inline, native asset, and passthrough strategies, including relay-first defaults where provider APIs accept URLs.
- Merged Wan 2.7 provider variants into the unified `wan-2.7` model with provider-effective modes and migrated existing settings.
- Fixed Gemini multimodal text references by uploading video, audio, PDF, and large image inputs through the Gemini Files API instead of passing relay URLs to AI Studio.
- Added SV NewAPI as a configurable OpenAI-compatible gateway provider for existing text, image, video, and audio catalog models.
- Added catalog validation and audit tooling for provider/model/mode/reference delivery rules.
- Bumped the plugin version to `1.24.0`.

## 1.23.0 — 2026-06-06

- Reworked `.bragi` export/import to use a streaming ZIP package format that avoids large-canvas string and buffer limits while keeping legacy JSON package import compatibility.
- Added an export confirmation modal with asset/package size stats, destination selection, and reveal-in-file-manager support.
- Fixed merge import, large canvas export/import, and asset-heavy package handling so imported nodes repaint reliably and exports clean up partial files on failure.
- Changed ElevenLabs Sound Effects duration to a range control with provider-specific ElevenLabs and fal.ai limits, including clamped provider/MCP defaults.
- Cleared Obsidian community review lint warnings and deprecated settings re-render self-calls.
- Bumped the plugin version to `1.23.0`.

## 1.22.0 — 2026-06-04

- Added DashScope Wan 2.7 video generation with text-to-video, image-to-video, reference-to-video, video extend, and video edit modes.
- Added configurable DashScope native base URL support, including southeast workspace compatibility.
- Simplified Wan 2.7 UI params and mode labels, including merging multi-image reference into Ref Image and fixing the Duration toolbar hover height.
- Fixed grid split, collage, and duplicate-with-connections flows so newly imported canvas nodes render immediately after being persisted.
- Fixed reference strip drag state so image, text, and audio refs self-heal if a drag is cancelled or dropped outside the window.
- Bumped the plugin version to `1.22.0`.

## 1.21.3 — 2026-06-03

- Fixed TokenRouter text generation with upstream video references by sending relay video URLs as `video_url` content parts.
- Kept non-video file references on the existing file content path for TokenRouter text generation.
- Bumped the plugin version to `1.21.3`.

## 1.21.2 — 2026-06-03

- Skipped the ModelArk and BytePlus asset moderation prefilter when creating reference assets for supported generation flows.
- Fixed reference asset uploads that could be rejected before the provider generation request started.
- Bumped the plugin version to `1.21.2`.

## 1.21.1 — 2026-06-02

- Fixed Obsidian community audit warnings by removing unused AI SDK dependencies from the plugin package.
- Removed remaining CSS `!important` usage from inline tool and generated stylesheet output.
- Tightened inline tool CSS specificity so the toolbar behavior remains intact without `!important`.
- Bumped the plugin version to `1.21.1`.

## 1.21.0 — 2026-06-01

- Added `seedream-5.0-lite` as an image model on Volcengine and BytePlus, with 2K, 3K, and 4K output options.
- Added BytePlus Seedream image generation through the international BytePlus ARK endpoint.
- Changed BytePlus asset handling to use an explicit reusable Asset group ID instead of creating asset groups automatically.
- Added per-provider API model ID overrides in the provider model management UI.
- Migrated legacy BytePlus `byteplusProjectName` values that look like asset group IDs into the new `byteplusAssetGroupId` setting.
- Bumped the plugin version to `1.21.0`.

## 1.20.0 — 2026-06-01

- Added MuleRouter CarrotHub image models: `z-image-spicy` for text-to-image and `qwen-image-edit-spicy` for image-ref-to-image.
- Added SuChuang as an optional provider for the existing `omni-flash-ext` video model, including async task submission, polling, Relay image reference routing, and final URL extraction.
- Added an inline video editing tool for trimming video nodes and capturing frames back onto the canvas.
- Improved inline tool layout with node-relative top and bottom toolbars, moving video capture and save controls into the top toolbar.
- Fixed MCP tool schemas so `inputSchema` is emitted with a top-level `type: object`.
- Added verification scripts for MuleRouter CarrotHub image models and SuChuang Gemini Omni.
- Bumped the plugin version to `1.20.0`.

## 1.19.1 — 2026-05-30

- Fixed canvas inline annotation mode regressions introduced by the new image annotation tool.
- Improved inline tool session state handling, viewport focusing, toolbar suppression/reveal, and exit cleanup.
- Fixed annotation toolbar interactions for color dropdowns, pointer/focus scope, and native toolbar restoration.
- Adjusted node toolbar positioning and annotation CSS for the inline tool mode.
- Bumped the plugin version to `1.19.1`.

## 1.19.0 — 2026-05-29

- Added APIMart Omni-Flash-Ext as a video model with text-to-video, first-frame, multi-image-ref, and video-ref modes.
- Routed APIMart video reference images and videos through Bragi Relay before provider calls, avoiding raw data URIs and third-party source URLs.
- Normalized reference image upload preparation across APIMart, OpenAI-compatible, TokenRouter, and Token360 paths.
- Added reference image upload verification coverage.
- Bumped the plugin version to `1.19.0`.

## 1.18.0 — 2026-05-29

- Added inline image annotation tools on canvas image nodes, including box, number, and mosaic markup with save/undo/redo controls.
- Fixed Token360 Seedance asset uploads for WebP references by validating image bytes, converting WebP uploads to PNG, and honoring API-level error payloads.
- Changed TokenRouter ModelArk asset handling to use only an explicitly configured asset group ID, with clearer errors when the group is missing or inaccessible.
- Validated cached Seedance asset references before reusing them so stale TokenRouter, Token360, BytePlus, or Volcengine asset IDs are refreshed instead of sent blindly.
- Fixed the MCP HTTP worker listener and Node runtime resolution used by the local StreamableHTTP server.
- Bumped the plugin version to `1.18.0`.

## 1.17.2 — 2026-05-28

- Added Token360 as a Seedance video provider for `seedance-2.0` and `seedance-2.0-fast`.
- Added Token360 video task creation, polling, and download support.
- Added optional Token360 asset group uploads for RealFace / Virtual Portrait image references.
- Routed Token360 local reference media through temporary HTTPS URLs when asset upload is not configured.
- Bumped the plugin version to `1.17.2`.

## 1.17.1 — 2026-05-28

- Added MuleRouter as a video provider.
- Added Wan 2.7 Spicy I2V as an explicit opt-in video model.
- Routed MuleRouter image and audio references through Bragi temporary relay URLs before provider calls.
- Preserved explicit provider-model connection semantics so the new model is addable but not auto-enabled for existing users.
- Bumped the plugin version to `1.17.1`.

## 1.17.0 — 2026-05-28

- Refined the provider and model settings flow so provider credentials are only saved after selected models are connected.
- Added explicit provider-model connection preferences and a centralized settings migration pipeline.
- Updated Add Model, Manage Models, Remove Provider, MCP `list_models`, and the generate bar to respect connected provider-model pairs.
- Polished model/provider settings empty states and row layouts.
- Added an update reminder modal that checks the latest GitHub release when a canvas is opened or activated.
- Added the `Bragi Canvas: Check for updates` command and update-check verification script.
- Documented the update-check network request in the README.
- Bumped the plugin version to `1.17.0`.

## 1.16.0 — 2026-05-24

- Added image collage composition for multi-selected image nodes, creating a new composed PNG node and source edges.
- Added TokenRouter ModelArk asset flow for Seedance reference media, including asset group creation, upload, review polling, and cached `asset://` references.
- Added provider-scoped Seedance asset IDs for TokenRouter, BytePlus, and Volcengine, with MCP `set_asset_id` support for the provider namespace.
- Added ElevenLabs voice cloning from upstream audio references, plus stability, similarity, style, and speed controls for ElevenLabs TTS.
- Added MiniMax voice cloning from upstream audio references.
- Improved range and number parameter controls in the generate bar.
- Fixed GPT Image 2 sizing by mapping selected aspect ratio and image tier to explicit OpenAI-compatible sizes.
- Bumped the plugin version to `1.16.0`.

## 1.15.1 — 2026-05-23

- Removed runtime filesystem-based CSS hot reload code from the plugin bundle.
- Replaced the MCP SDK runtime dependency with a lightweight local JSON-RPC HTTP server.
- Scoped canvas listing, migration, and cleanup flows to Bragi-known canvases and indexed/generated assets instead of full vault enumeration.
- Replaced automatic clipboard writes in error details with a selectable read-only text area.
- Removed dynamic Pannellum script injection and imported the viewer bundle normally.
- Cleaned up community CSS lint warnings for `!important` and `:has()`.
- Bumped the plugin version to `1.15.1`.

## 1.15.0 — 2026-05-23

- Added provider-aware multimodal text input validation for upstream images, PDFs, videos, and audio.
- Added native DashScope Qwen 3.6 Plus text generation with multimodal refs.
- Exposed `supportedInputs` and `unsupportedInputs` for text models through MCP `list_models`.
- Preserved uploaded Gemini and TokenRouter file refs so large multimodal inputs are sent correctly.
- Included the Bragi theme, canvas UI polish, and improved placeholder overlays from the latest mainline UI work.
- Bumped the plugin version to `1.15.0`.

## 1.14.3 — 2026-05-22

- Added APIMart GPT-5.5 text provider support.
- Added Gemini 3.5 Flash text generation via Google Gemini and TokenRouter.
- Added Gemini multimodal text references for upstream video, audio, and PDF inputs.
- Split MCP tool registration into a dedicated registry module.
- Fixed Gemini text errors so Google quota and API-key details surface clearly.
- Bumped the plugin version to `1.14.3`.

## 1.14.2 — 2026-05-22

- Added APIMart support for Nano Banana Pro and Nano Banana 2.
- Routed APIMart image requests through each model's selected API model ID instead of hardcoding GPT Image 2.
- Expanded APIMart task failure details so structured provider errors no longer show as `[object Object]`.
- Bumped the plugin version to `1.14.2`.

## 1.14.1 — 2026-05-21

- Added TokenRouter support for Seedance 2.0 and Seedance 2.0 Fast using the Dreamina model IDs.
- Aligned TokenRouter Seedance video generation with the TokenRouter video task API, including `images`, `audios`, `videos`, and Seedance controls in `metadata`.
- Kept existing TokenRouter image/text and HappyHorse video behavior unchanged.
- Bumped the plugin version to `1.14.1`.

## 1.14.0 — 2026-05-17

### Added
- Unified Qwen Voice audio entry: built-in voices use Qwen Instruct Flash, reference voices use Qwen VC, and designed voices use Qwen VD.
- Added Design as a TTS voice source. Upstream text supplies the voice-design prompt; the current node supplies speech text without mixing the two.
- Qwen uses `qwen-voice-design`; CosyVoice Plus/Flash use `voice-enrollment` with `voice_prompt` and `preview_text`.
- Added `bragiCustomVoices` metadata distinguishing clone and design voices for later voice-ID reuse.

### Changed
- Renamed Custom to Voice ref alongside Built-in and Design.
- Replaced separate Qwen Flash/VC/Instruct entries with Qwen Voice; its built-in picker reuses the Instruct Flash sample list.

### Fixed
- MCP preserves extended audio parameters including `voiceMode` and `voiceDesignTextIndex` for reference/design workflows.
- Base64 preview audio returned by DashScope is excluded from canvas metadata to prevent oversized canvas files.

## 1.13.0 — 2026-05-16

### Added
- Searchable, filterable TTS voice picker with previews and remote sample lists from Bragi API.
- Reusable voice-clone IDs from upstream audio for DashScope/Bailian Qwen and CosyVoice TTS.
- DashScope audio support for Qwen3 TTS Flash/Instruct Flash/VC and CosyVoice v3.5 Plus/Flash.

### Changed
- Removed redundant TTS suffixes from audio model labels.
- Switched built-in reference transfer to `https://temp.bragi.now`, using the `temp/` R2 prefix.

### Fixed
- Correct voice parameter fields for fal-backed ElevenLabs/MiniMax models.
- Cleaned up new TTS CSS, English UI text, runtime response narrowing and DashScope output-path normalization for Obsidian review.

## 1.12.16 — 2026-05-15

### Added
- Gemini text generation accepts upstream MP4/MOV/WebM for video understanding and summaries.

### Changed
- Video references use Bragi Relay URLs and Gemini `fileData.fileUri`, avoiding large inline-base64 requests.

### Fixed
- Non-Gemini text providers report unsupported video references instead of silently ignoring them.

## 1.12.15 — 2026-05-14

### Changed
- Stopped tracking built `main.js`; tag workflows still build/upload the three release assets.
- MCP starts disabled on new installs; existing saved settings are preserved.
- `.bragi` import reads a user-selected browser file instead of Electron remote/Node filesystem access.

### Fixed
- Updated text entries to GPT-5.5/Pro and routed Pro through Responses API rather than the incompatible Chat Completions endpoint.
- MCP `delete_edge` verifies removal from the Canvas runtime before reporting success.
- Non-English Obsidian installations receive manual language-switch instructions; the plugin no longer changes language or restarts the app automatically.
- Merged duplicate reference-strip CSS selectors.

## 1.12.14 — 2026-05-13

### Changed
- Replaced BUSL-1.1 with MPL-2.0 so GitHub and Obsidian can identify the license.

### Fixed
- Cleaned up optional source/CSS review warnings, removed release CSS `!important`, and documented narrowly scoped runtime-data lint suppressions.
- Moved edge Remove label into More with Focus, Set color and Delete.
- Replaced the group Set background icon with a Bragi icon.
- Removed the native Edit button from text-node toolbars while preserving generation, Mark, Duplicate with connections and More.

## 1.12.13 — 2026-05-13

### Changed
- Replaced ZIP packages with version-2 JSON `.bragi` files containing base64 assets. Imports write only into vault `_bragi/assets`, never plugin installation directories.
- Package export and media download use browser Blob downloads instead of writing arbitrary local paths through Node `fs`.
- Tag releases include nonempty release notes and attestations for `manifest.json`, `main.js` and `styles.css`.

### Fixed
- Removed ZIP/JSZip and bundle signals that triggered self-update warnings, retaining package path validation.
- Declared BUSL-1.1 in package metadata and retained its license file. GitHub could still classify it as NOASSERTION/Other; that warning did not mean the file was missing.

## 1.12.12 — 2026-05-09

### Added
- Import settings from `data.json` in General. Validate the format and confirm replacement of providers, model lists/order and MCP settings; invalid files leave current settings intact.
- BytePlus Seedance 2.0/Fast reference-video mode registers up to three MP4/MOV inputs as Video assets after Relay upload, then sends `asset://` references.
- TokenRouter became an all-in-one image/video/text provider at `https://api.tokenrouter.com/v1`, covering supported GPT Image, Nano Banana, Seedream, Seedance, Kling, GPT, Gemini, Claude, Qwen and Grok routes confirmed by its model list.
- Added HappyHorse 1.0 T2V and I2V on TokenRouter. I2V uses first-frame with one reference image.

### Fixed
- Corrected import-settings sentence case and removed unused variables identified by ObsidianReviewBot, including asset-group, generation metadata, MCP and signing helpers.
- HappyHorse I2V uses `first_frame_image`; data-URI images are transferred through Relay before submission, avoiding Invalid URL errors.

## 1.12.11 — 2026-05-08

### Changed
- Updated README for Obsidian 1.8.7, BRAT/manual installation, MCP, providers, release assets and network/data disclosures.
- Removed unused imports/functions/variables and prefixed intentionally unused parameters without changing behavior.
- Restored missing Canvas tools across text/media/edges/groups. Focus, Set color and Delete moved to More; image tools include Split grid/360 viewer/Mark/Download; edge tools show Edit label/Line direction/Mark/More.

### Fixed
- Restored image overlays, panoramas, grid splitting, Mark and node More menus previously available before `708f959`.
- Cleared optional unused-code warnings without changing runtime behavior.

## 1.12.10 — 2026-05-08

### Fixed
- Changed the MCP token placeholder to `Leave blank to disable auth`, removing parentheses that triggered the remaining sentence-case check.
- Published 1.12.10 with the three individual GitHub release assets.

## 1.12.9 — 2026-05-08

### Fixed
- Corrected nine UI strings to sentence case, including fal.ai key guidance, generation notices and MCP descriptions.
- Published 1.12.9 with the three individual release assets.

## 1.12.8 — 2026-05-08

### Fixed
- Removed file-level sentence-case suppressions from import/export, main, panel, settings and language-gate code, and removed the MCP file-level explicit-any suppression.
- Narrowed MCP Canvas runtime types instead of using direct `any`.
- Used a non-async HTTP listener with `void this.handleHttpRequest(...)` to avoid misused promises.
- Published 1.12.8 with the three individual release assets.

## 1.12.7 — 2026-05-07

### Added
- Native xAI provider for Grok text, image generation/editing, video and TTS using one key.
- Grok 4.3 (`grok-4.3`, alias `grok-latest`) and Grok 4 Fast (`grok-4-fast-non-reasoning`) with vision.
- One Grok Imagine card with Quality/Normal tiers. Generation uses `/v1/images/generations`; editing uses `/v1/images/edits` with up to five references. Historical prices were $0.40/Quality and $0.20/Normal.
- Native Grok Video generation/extension: text-to-video and first-frame 1–15s, image-reference 1–10s, and extension 2–15s; added 1080p supported by the API.
- Native Grok TTS returns MP3 bytes from `/v1/tts`, with Eve/Ara/Leo/Rex/Sal and nine language choices.

### Fixed
- Image edits use `image` for one reference or `images` for multiple references, never both.
- Added per-mode duration options through `optionsByMode`; switching modes rebuilds parameters and resets invalid values to the 5s default, with provider-side clamping retained.
- Fixed collapsed mode selectors by attaching measurement lazily and explicitly updating size after programmatic option/value changes.
- Luma response parsing reads text before attempting JSON, preserving non-JSON errors.

### Changed
- Merged the short-lived separate Grok quality card into the shared model using a Quality parameter.
- Connected video-reference collection through Relay to fal/xAI extension requests.
- GPT Image 2 sizes map to supported fixed dimensions or auto.
- Documented xAI image pricing: normal $0.20, quality $0.40; deprecated pro $0.70 was not integrated.

## 1.12.6 — 2026-05-06

### Fixed
- MCP text/color updates use one full `importData` operation instead of `node.setText()`, which could invalidate live Canvas/CodeMirror state and make nodes disappear on rerender. Geometry-only updates still use `moveAndResize`.

## 1.12.5 — 2026-05-05

### Added
- Luma provider at the built-in `https://luma.bragi.now` proxy endpoint with one API key.
- Luma Uni-1 text-to-image and single-reference image generation with 1:1, 16:9, 9:16, 3:2 and 2:3 ratios.

### Fixed
- GPT Image 2 dimensions map to `1024x1024`, `1024x1536`, `1536x1024` or `auto`. Ratios above 1.15 use landscape, below 0.87 portrait, otherwise square; unsupported size tiers are ignored.
- Luma reference images are uploaded to Relay and submitted as JSON `image_url`, avoiding the proxy's roughly 4.5 MB multipart limit. Text-first error parsing preserves Request Entity Too Large responses.
- Image mode inference selects image-reference generation for one or multiple upstream images.

### Changed
- Documented the previously omitted always-new-tab patch from 1.12.4. `Workspace.getLeaf/getUnpinnedLeaf` open files in new tabs to avoid replacing active generation views; no setting switch was added.

## 1.12.4 — 2026-05-04

### Fixed
- Gemini connection tests recognize HTTP 400 with INVALID_ARGUMENT for expired/invalid keys and display Google's message.
- ElevenLabs `missing_permissions` from a restricted but valid key is treated as connected rather than invalid.

## 1.12.3 — 2026-05-03

### Added
- Added non-generating provider connection tests beside Save. OpenAI-compatible providers use model listings; Anthropic uses an empty messages request; Gemini/BytePlus use model endpoints; fal checks status authorization; ElevenLabs uses voices; MiniMax uses files; Legnext uses account balance. Bedrock/Kling testing remained unavailable because of their signing flows.

### Fixed
- Prevented overlapping TaskQueue polls from creating duplicate BytePlus result nodes using an in-flight task set, completed-ID removal and a post-await check that the task still exists.
- Kling text-to-video sends `mode: quality` rather than an undefined mode.
- Removed the obsolete `-v1:0` suffix from Claude 4 Bedrock IDs; fixed Sonnet 4.6 and removed the previous-generation Opus 4.6 entry.
- Updated fal's connection-test endpoint, switched ElevenLabs tests from user to voices, and simplified BytePlus tests to ARK models instead of an asset-group call requiring Filter.

### Changed
- Removed unsupported Kling extension mode to avoid silently falling back to text-to-video.
- Removed Claude Opus 4.6 from models/provider entries; stale preferences are harmless because unknown models are skipped.

## 1.12.2 — 2026-05-03

### Added
- At this release, the language gate skipped loading unless Obsidian used English/default English. Its modal offered disabling the plugin or switching language and restarting, with a reload fallback. This historical automatic-switch behavior was replaced by manual guidance in 1.12.15.

### Fixed
- Removed a hardcoded BytePlus test ARK key from default settings that had been distributed since 1.6.3. The credential value is not reproduced here.
- Positioned generation overlays consistently at the node's bottom center with translucent background and shadow.

## 1.12.1 — 2026-05-02

### Changed
- Replaced placement counters with live collision scans. `findFreePosition` tests the initial location, alternating vertical offsets and subsequent columns, up to 50 by 50 candidates.
- Both placeholder creation and larger result replacement find free space; user-positioned nodes are not moved.

### Removed
- Removed the old `placementOffsets` counter while keeping no-op compatibility methods for `getNextYOffset/resetPlacement`.

## 1.12.0 — 2026-05-02

### Changed
- Moved generation text into a bottom-centered overlay; placeholder content stays empty and does not rerender every second.
- Standardized elapsed-time text across types and used one shared 1s ticker that stops when no placeholders remain.
- TaskQueue no longer writes status into placeholder text; the overlay owns display.
- Removed overlay shadow and medium font weight for a quieter appearance.

### Added
- Scan for orphaned generating nodes on startup/canvas changes. Mark interrupted tasks with an explanation and show a count notice; never delete user content automatically.
- Persist model name/start time on placeholders and restore overlays/shimmer on remounted views.

### Fixed
- Clear model/start-time metadata when marking failures.
- Set generation flags after edge import so old snapshots cannot overwrite them. Add a direct-save fallback for debounced Canvas saves when an immediate reload would otherwise lose the flag.

## 1.11.2 — 2026-05-02

### Changed
- Replaced column-based placement with nearby candidate positions sorted by distance, avoiding distant or excessive vertical placements.
- Size placeholders from aspect ratio and reuse their geometry for results: 400×400 square, 400×225 landscape, 225×400 portrait; text defaults to 400×200 and audio to 400×100.
- Exported `computeOutputSize` and `readAspectRatio` for reuse.

## 1.11.1 — 2026-05-02

### Added
- MCP `update_nodes_batch` updates geometry/color through one import instead of N RPCs.
- MCP `create_group_node` creates titled Canvas groups.
- MCP `arrange_in_grid` accepts columns, origin, gaps and cell dimensions.
- Added workflows for cleaning up layouts and batch movement/color changes.

### Fixed
- Read edges from `canvas.getData().edges` because runtime `canvas.edges` is a Map, avoiding `o.map is not a function`.

## 1.11.0 — 2026-05-02

### Added — MCP
- **8 new MCP tools**:
  - `list_pending_tasks` / `get_task_status` — track async video generations via TaskQueue snapshots
  - `get_active_canvas_info` / `list_canvases` / `open_canvas` — inspect and switch canvases (switching requires user confirmation via modal)
  - `create_nodes_batch` / `connect_nodes_batch` — one `importData` call for N nodes/edges
  - `create_file_node` / `upload_image_as_node` — inject vault files or external base64 images into the canvas
  - `set_asset_id` — bind Volcengine Asset IDs to image nodes from MCP (previously UI-only)
- **`generate` now returns `placeholderIds`** and `expectedOutputType`. Agents can track which node they just started rather than guessing by re-reading the canvas.
- **Optional bearer token auth**: new `MCP access token` setting. When set, requests must send `Authorization: Bearer <token>` (401 otherwise). Blank = current open-localhost behaviour.
- **`read_canvas` size cap (100KB)**: large canvases return a `truncated` marker with hint to use `list_nodes` instead.
- **Skill package** `skills/bragi-canvas/` — SKILL.md + 4 references (tools / workflows / models / gotchas) documenting all 22 MCP tools for AI agents.

### Changed — MCP
- `generate` is now `await`-able on placeholder creation — the provider call still runs in the background, but placeholder IDs are returned synchronously so callers can track individual tasks.
- `connect_nodes` / `connect_nodes_batch` reject self-loops.
- Internals: `executeGeneration` / `executeSingleGeneration` split into `startSingleGeneration` (sync, returns placeholder id) + `runSingleGeneration` (async provider work).

### Fixed — MCP
- `delete_edge` no longer uses the two-pass `importData` hack — single atomic import of filtered edges.
- `update_node` writes text via `node.setText()` for text nodes so the live `node.text` property stays in sync with canvas JSON.
- Session-creation TDZ: `server` binding is declared before `StreamableHTTPServerTransport` closes over it.
- Edge/node IDs now use `crypto.randomUUID` instead of `Math.random` (not crypto-secure, and visually inconsistent with canvas-native IDs).

## 1.10.0 — 2026-05-02

### Added
- Grid splitting on image toolbars detects 1×1 through 5×5 layouts. A 1×1 result produces a notice without changes. The gridshots-derived detector combines dark-line detection, autocorrelation/comb scoring and multiscale validation, retaining thresholds 4, 0.55, 35 and 0.15.
- Replaced OpenCV with Canvas 2D and a 3×3 Gaussian blur. Tiles save as `_bragi/assets/tile_<ts>_<i>.png`, arranged to the right with 40 px gaps and directed edges.
- BytePlus face-reference asset flow with Volcengine HMAC-SHA256 signing verified against the Python SDK, asset-group/create/get/status operations, node/canvas caches, prevalidation, recreation and a 300s timeout. Optional Access Key, Secret Key and Project Name enable asset registration for image/audio references; otherwise URL delivery remains.
- Password visibility toggles for provider keys.
- Redirect canvas paste/drop attachments to `_bragi/assets`, restoring the user's attachment folder when leaving Canvas.
- Relay replaced direct R2 upload configuration; temporary-file lifecycle was described as 24 hours.

### Changed
- Moved Temporary cloud into General and shortened provider descriptions.
- Updated BytePlus Seedance endpoint IDs to the appropriate account.
- APIMart uses submit/poll/download with a 300s timeout; a constant selects official versus alternative routing.

### Fixed
- Simplified Add Model/provider navigation and Back buttons.
- Removed opacity from added model cards, improved unconfigured-provider badge contrast, and standardized modal spacing/classes/scrollbars.

## 1.9.2 — 2026-05-02

### Added
- Eye/eye-off controls toggle provider key visibility with Show/Hide tooltips.
- `attachment-redirect.ts` saves the user's attachment folder on Canvas entry, redirects to `_bragi/assets`, then restores it on exit.

### Changed
- Kept added model cards opaque and distinguished unconfigured provider badges from card backgrounds.

## 1.9.1 — 2026-04-30

### Added
- Hosted Bragi Relay Worker with built-in client configuration, R2 binding, authenticated `POST /upload?ext=...` and `GET /healthz`. Reference image/audio uploads use its public URLs without separate user setup; the historical `bragi/` prefix had a 24-hour lifecycle.
- APIMart GPT Image 2 with selectable official/alternative routing and asynchronous completion up to 300s.
- Reworked Add Model search/type filters, provider badges, Already added management and automatic search focus. Provider forms support a selector and Back navigation inside the same modal; Bragi modals share a 560 px width and spacing.

### Changed
- Merged cloud storage into General as Temporary cloud and removed direct R2 configuration/upload code.
- Simplified notices, removed exposed internal paths and prefixes, and used Transcription/Voice isolation terminology and typographic ellipses.
- Kept provider modal titles stable and improved card/badge contrast.

### Fixed
- Migrated remaining `ovid*` metadata to `bragi*`, reading old values as fallback but writing only new fields.
- Panorama loading uses blob URLs; mirroring rerenders the image and reverses yaw instead of flipping event coordinates with CSS.
- Hid the empty modal header that produced a black bar.

## 1.9.0 — 2026-04-29

### Added
- Provider registry declaring IDs, fields, configuration checks and modality factories. Main dispatch became four lookups instead of seventeen branches; new providers no longer require editing main dispatch.
- Add Provider search/form flow and per-modality Add Model dialogs with provider badges and configuration links.
- Provider removal checks affected models and fallback connections before confirming destructive availability changes.
- Unified audio providers behind `generateAudio`; moved direct fal audio calls into `FalAudioProvider`.
- One-time `migrationProviders_1_9` preserves enabled models for existing configured providers.

### Changed
- Settings list only added providers/models, retain model ordering and show only supported/configured providers.
- Replaced model enable toggles with explicit add/remove flows.

### Removed
- Removed fourteen direct provider-class imports and obsolete audio/video construction helpers from main.

## 1.8.1 — 2026-04-29

### Changed
- Rewrote notices, dialogs and buttons in plain English. Removed redundant product prefixes, internal paths and exclamation points; standardized ellipses.
- Renamed import choices to Open as new canvas/Add to this canvas. Tidying and cleanup dialogs show clearer actions and filenames rather than internal paths.

### Fixed
- Migrated `ovidLastGen`, `ovidImageOrder` and `ovidGenerating` with read fallback and write-only `bragi*` fields, preventing duplicate metadata from drifting.

## 1.8.0 — 2026-04-29

### Changed
- Moved generated assets from per-canvas `ss/` directories to vault-wide `_bragi/assets`; moving or renaming canvases no longer changes asset paths. Hid `_bragi` in the file tree and removed configurable output-directory input.
- Cleanup scans the shared asset directory and checks parsed canvas references plus Markdown references.
- Import/export use the shared asset location while keeping package-relative `assets/` paths.

### Added
- Historical migration flow backed up canvases under `_bragi/backup/<timestamp>`, flattened backup names, moved old assets with collision suffixes, rewrote canvas file/background paths and removed empty old directories. Users could migrate, defer or stop prompts; errors retained backups for recovery.
- Added `migrationPrompted`. Later releases changed migration to preserve shared source files; this entry records the original release behavior.

## 1.7.5 — 2026-04-26

### Added
- TokenRouter at `https://api.tokenrouter.com/v1` for GPT Image 2 and Claude/Gemini text routes, plus Qwen 3.6 Plus (`qwen/qwen3.6-plus`). Existing OpenAI image/text providers gained optional base URLs; settings gained a TokenRouter key field.
- Panorama viewer for image nodes using bundled pannellum 2.5.7. It supports drag/zoom, a node-style toolbar, true horizontal mirroring with yaw correction, and 2048×1024 PNG capture into a connected result node. The viewer is `min(1000px, 90vw)` by 600 px with a black background.

### Changed
- OpenAI image/text endpoint construction accepts custom base URLs; configured-provider detection and main dispatch recognize TokenRouter.
- Added esbuild text assets for bundled pannellum JavaScript/CSS, loaded on first use and available offline.

### Fixed
- Passed blob URLs to pannellum instead of HTMLImageElement to avoid `a.slice is not a function`.
- Replaced CSS mirroring with rendered flipped images to preserve natural dragging.
- Hid the empty modal header.

## 1.7.4 — 2026-04-26

### Added
- Canvas bottom-menu actions for package export, import choice and plugin settings, with six custom card/action icons.

### Changed
- Light canvas background `#f5f5f5`, dark `rgb(25,25,25)`, grid dots at 40% opacity; node borders became 1 px with 12 px corners and light `#e3e3e3` outlines.
- Reference strips use audio/image/text/content order, shared 5×10 px padding, 10 px spacing and extra top padding. Image badges sit inside thumbnails; badges share translucent black, white text/border and 4 px corners.
- Audio/text items use 8 px padding, 100 px width and 10 px text; audio duration uses mm:ss or hh:mm:ss. Leading drag handles and badges share a flex row.
- Hid the entire Canvas settings control group; unified control colors/icon sizes and reduced toolbar/control/card/bar shadows.
- Retained simplified Bedrock region labels and R2 copy from 1.7.3.

### Fixed
- Hide the settings control's parent group instead of leaving an isolated bordered button.
- Include `.canvas-control-item` in icon-color selectors.

## 1.7.3 — 2026-04-25

### Added
- R2 connection test uploads timestamped text and verifies the public URL with GET, reporting success/failure.
- Strip Host from outgoing SigV4 headers after signing; Chromium/Electron disallows setting it. This fixes Seedance reference-image R2 PUT errors.

### Changed
- R2 settings use native setting-group/items, rounded borders and row separators; credential and bucket/URL fields share rows.
- Simplified the R2 description to `Temporary storage for reference assets.` and Bedrock region choices to region codes.

## 1.7.2 — 2026-04-25

### Added
- More menu groups Edit, Set colour, Zoom to fit and Delete. Hover opens it; leaving closes it after 150 ms. Styling matches toolbars with 8 px corners and a 1 px overlap to avoid double borders.
- Native align/arrange menus share Bragi styling and hover behavior.

### Changed
- Generation icons appear first, followed by a conditional divider and built-in/Mark/duplicate/download tools; More stays last.
- Dark icons use white at 20 px, dark canvas uses `rgb(25,25,25)`, and Pin tooltip becomes Mark.

### Removed
- Separate multi-selection Arrange in grid button; grid remains in the alignment menu.

## 1.7.1 — 2026-04-25

### Added
- Persist video tasks in `_pendingTasks` with task/provider/model/canvas/node/output/start-time fields and resume polling after reopening the corresponding canvas.
- Restore providers, source/placeholder nodes and shimmer, resume once per canvas, and notify how many tasks resumed.
- At this historical stage, missing nodes/unavailable providers were discarded and logged; later recovery work replaced that behavior.

### Changed
- PendingTask stores snapshot/provider/canvas/placeholder/sourceNode for serialization.
- Added `hasTask`, `getSnapshots` and `onChange`.

## 1.7.0 — 2026-04-23

### Changed
- Replaced fal storage with R2 across image/video/audio reference upload, transcription and isolation. Removed `fal-upload.ts`; relevant constructors accept R2Config instead of a fal key.

### Added
- S3-compatible PUT signing through `r2-upload.ts`/`sigv4.ts` and a shared upload facade that rejects missing R2 configuration rather than falling back to fal.
- Cloud Storage settings for account, access key, secret, bucket and public base URL.
- Extended signing bodies to string, Uint8Array or ArrayBuffer.

## 1.6.9 — 2026-04-22

### Fixed
- One MCP transport/server pair per client session, routed by `Mcp-Session-Id`; initialization creates/registers a session and close/stop cleans up sessions. Reconnection and parallel clients no longer displace each other.

## 1.6.8 — 2026-04-22

### Changed
- Seedance 2.0/Fast duration follows official options: Auto (-1) plus each second from 4–15s, default 5s.

## 1.6.7 — 2026-04-22

### Changed
- Aligned GPT Image 2 parameter IDs with Nano Banana Pro: ten aspect ratios, Auto/1K/2K/4K size (2K default), and Auto/Low/Medium/High quality.
- Added size resolution rounded to multiples of 16, constrained to a 3840 px edge, 655360–8294400 pixels and at most 3:1 ratio.
- Shared parameter IDs preserve ratio selections between models.

## 1.6.6 — 2026-04-22

### Changed
- Displayed GPT Image size choices as ratios/tiers while keeping the underlying pixel values.

## 1.6.5 — 2026-04-22

### Changed
- Upgraded GPT Image 1.5 to GPT Image 2, adding 2048/3840 and auto sizes.
- Replaced AI SDK image calls, reducing the bundle from 692 KB to 609 KB. Text-only requests use JSON generations; image references use handwritten multipart edits with `image[]`; base64 responses are written to the vault.

### Fixed
- Restored missing OpenAI reference-image arguments in main dispatch.

## 1.6.4 — 2026-04-21

### Fixed
- Match both color/colour labels for Pin.
- Use native Arrange in a grid instead of a custom resize call that omitted dimensions and collapsed nodes.

## 1.6.3 — 2026-04-21

### Added
- BytePlus Seedance support in ap-southeast-1, initially with a prefilled key.
- Provider switching between Volcengine and BytePlus for Seedance 2.0/Fast.

## 1.6.2 — 2026-04-21

### Added
- Purple Pin for single/multiple selections and Grid for multiple selections.

## 1.6.1 — 2026-04-21

### Changed
- Removed debugging logs and repaired deployment steps.

## 1.6.0 — 2026-04-20

### Added
- Seedance audio-reference inputs.
- Direct MiniMax TTS/music, including Chinese-language voices.
- Expanded MCP generation and continued edge-direction cleanup.

## 1.5.2 — 2026-04-20

### Added
- MCP `list_models`, `get_upstream` and `generate` tools.

### Changed
- Generated connections default to no arrow; MCP settings moved above Providers.

## 1.5.1 — 2026-04-20

### Fixed
- Added bottom space to `.markdown-embed-content` so text reference strips do not clip the final line; corrected the selector.

## 1.5.0 — 2026-04-19

### Added
- Upstream text/Markdown strips with drag handles and single-line previews.
- Persisted ordering in `bragiTextOrder` and used it for prompt assembly.
- Image previews precede text references and node content; a shared 1s refresh follows image/text changes.

## 1.4.0 — 2026-04-18

A short-lived 1.4.1 was rolled back; Claude, Bedrock and GPT-5.4 Pro were grouped
into the 1.4.0 minor release after reviewing versioning.

### Added
- Claude Opus 4.7/4.6, Sonnet 4.6 and GPT-5.4 Pro.
- Direct Anthropic and AWS Bedrock with access key, secret and region (us-east-1 default); SigV4 uses Web Crypto without another dependency.
- Per-model Anthropic/Bedrock selection, image vision inputs and SPLIT outputs.
- Region-prefixed Bedrock inference-profile IDs.

## 1.3.1 — 2026-04-18

### Fixed
- Duplicate text nodes and connections through one atomic import, avoiding a later import overwriting a newly created node.
- Added error handling/logging.

## 1.3.0 — 2026-04-18

### Added
- Split generated text into vertically arranged nodes using `---SPLIT---`.
- Further canvas import/export improvements.

## 1.2.0 — 2026-04-17

### Added
- `.bragi` canvas export/import with media, merging into existing canvases or creating a new canvas.
- Remapped file paths, regenerated node IDs and handled filename collisions.

## 1.1.0 — 2026-04-17

Baseline: v1.0.1.

### Added
- Grok image/video through fal.ai, Midjourney v8/niji 7 through Legnext with stylize, and direct ElevenLabs TTS/music/SFX.
- ElevenLabs binary MP3 responses and Legnext provider authentication.
- Duplicate with incoming connections, preserving reference order and previous generation settings.
- Draggable reference-image order persisted in canvas JSON.
- Seedance `asset://` references through Set Asset ID.
- Media downloads, generation shimmer, custom icons across menus/controls/cards, and a divider between copy and generation.

### Changed
- Renamed 144 `ovid-` CSS classes to `bragi-`.

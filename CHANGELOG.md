# Changelog

## Unreleased

## 1.30.0

- Added ElevenLabs Voice Changer for audio nodes using `eleven_multilingual_sts_v2`: the selected audio supplies content and emotion, one incoming audio supplies the target voice, and every click creates an independent parallel output node.
- Reused cached ElevenLabs custom voices across TTS and Voice Changer, with in-flight clone deduplication for parallel conversions.
- Fixed Kling 3.0 Omni video editing so native Kling and APIMart requests can combine one base video with reference images.
- Added payload regression coverage for Kling 3.0 Omni base-video edits with multiple image references.
- Bumped the plugin version to `1.30.0`.

## 1.29.2

- Fixed Legnext image result selection so single-image outputs prefer the first individual image instead of the composite preview grid.
- Added static verification coverage for Legnext image result parsing.
- Bumped the plugin version to `1.29.2`.

## 1.29.1

- Tuned fal.ai FLUX.2 Klein 9B base inference and request shaping.
- Expanded static verification coverage for fal FLUX Klein routing.
- Bumped the plugin version to `1.29.1`.

## 1.29.0

- Added fal.ai as a provider for FLUX.2 Klein 9B image generation, alongside BFL and Runpod.
- Added static verification for fal FLUX Klein payload routing.
- Fixed the Denoise toolbar action so it is hidden when no available provider supports the action.
- Bumped the plugin version to `1.29.0`.

## 1.28.0

- Renamed SV NewAPI to SVRouter in provider-facing UI while keeping the same `svnewapi` settings key for compatibility, and fixed SVRouter asset registration to use the centralized gateway URL.
- Added Kling 3.0 Omni through the native Kling and APIMart providers, including text-to-video, first/last-frame, multi-image reference, feature-video reference, and video-edit flows.
- Added 3–15 second duration, Standard/Pro/4K quality, optional generated audio, source-audio retention, and advanced multi-shot/subject payload support while keeping the generator bar mode-specific and compact.
- Exposed intelligent multi-shot generation as the default `Multi shots` control, with `Single shot` as the alternative, and clarified generated-audio choices as `Audio On` / `Audio Off`.
- Added payload contract verification for both provider request shapes and native Omni task polling.
- Added FLUX.2 Klein 9B image generation through BFL and Runpod, including reference-image generation, safety tolerance, provider-specific seed handling, denoise defaults, and optional color matching.
- Fixed BytePlus and SVRouter asset failures so terminal `Result.Error.Message` / `Code` details surface when `FailedReason` is absent.
- Added regression verification for BFL denoise, Kling Omni payloads, and BytePlus/SVRouter asset failure messages.
- Bumped the plugin version to `1.28.0`.

## 1.27.3

- Fixed SV NewAPI Seedance Auto duration by forwarding it as `metadata.duration = -1`, matching the direct BytePlus/Volcengine Ark Seedance behavior.
- Added static verification coverage for SV NewAPI video parameters.
- Bumped the plugin version to `1.27.3`.

## 1.27.2

- Fixed SV NewAPI Nano Banana Pro requests by forwarding the selected aspect ratio as APIMart-style `size` and the selected image size as `resolution`.
- Added static verification coverage for the SV NewAPI Nano Banana Pro payload shape.
- Bumped the plugin version to `1.27.2`.

## 1.27.1

- Fixed APIMart GPT Image 2 routing by using the official upstream model ID while keeping Bragi's stable `gpt-image-2` model ID.
- Bumped the plugin version to `1.27.1`.

## 1.27.0

- Added GPT Image 2 (Official) as a selectable APIMart/SV NewAPI image model with quality-aware routing.
- Aligned SV NewAPI gateway model IDs for image, video, audio, and text models.
- Forwarded SV NewAPI media generation parameters for Seedance and fal-routed video models.
- Fixed SV NewAPI GPT Image 2 sizing/quality handling and Seedream image sizing.
- Added SV NewAPI image reference and audio parameter verification scripts.
- Bumped the plugin version to `1.27.0`.

## 1.26.3

- Fixed canvas-scoped duplicate handling so duplicated nodes and generated assets stay associated with the correct canvas.
- Fixed reference thumbnail refresh behavior after duplicate/canvas operations.
- Bumped the plugin version to `1.26.3`.

## 1.26.2

- Fixed TokenRouter GPT Image edit requests so reference images are uploaded and routed correctly.
- Added verification coverage for TokenRouter reference image upload handling.
- Bumped the plugin version to `1.26.2`.

## 1.26.1

- Fixed Obsidian review source warnings by typing the fflate stream callback used during `.bragi` ZIP import.
- Tightened Gemini Files API response parsing to avoid unsafe file/state response access.
- Tightened SV NewAPI gateway asset flow response parsing and error extraction without `any` response access.
- Bumped the plugin version to `1.26.1`.

## 1.26.0

- Added Kling V3 Motion Control mode for character image plus reference motion video generation on the native Kling provider.
- Added APIMart support for Kling V3 Motion Control through the `kling-v3-motion-control` model path.
- Added Motion Control UI handling, including automatic mode selection for one image plus one video, Orientation and Audio controls, and hidden duration/aspect ratio controls for this mode.
- Routed Kling Motion Control reference videos through the relay and added polling for the native `/v1/videos/motion-control` endpoint.
- Restricted non-motion Kling providers to their supported modes so fal, TokenRouter, and SV NewAPI do not expose Motion Control.
- Bumped the plugin version to `1.26.0`.

## 1.25.0

- Expanded SV NewAPI reference media support so Seedance routes image, audio, and video refs through top-level gateway arrays for text-to-video, first-frame, image-ref, and video-ref modes.
- Enabled SV NewAPI Grok video modes for text-to-video, image-ref, and video-extend flows.
- Generalized SV NewAPI provider media upload handling across image, audio, and video refs, preserving HTTP(S) and `asset://` refs when possible.
- Added SV NewAPI gateway asset registration via `/v1/assets`, including per-node cache validation, polling, `asset://` reuse, and graceful fallback when registration is unsupported.
- Fixed SV NewAPI Seedance reference image routing by sending refs through top-level `images`.
- Bumped the plugin version to `1.25.0`.

## 1.24.0

- Added the provider integration standard: provider/model differences are now declared in the catalog, including aggregated providers, editable API model IDs, provider-specific modes, parameter overrides, and reference-media delivery behavior.
- Added centralized reference-media delivery with relay, inline, native asset, and passthrough strategies, including relay-first defaults where provider APIs accept URLs.
- Merged Wan 2.7 provider variants into the unified `wan-2.7` model with provider-effective modes and migrated existing settings.
- Fixed Gemini multimodal text references by uploading video, audio, PDF, and large image inputs through the Gemini Files API instead of passing relay URLs to AI Studio.
- Added SV NewAPI as a configurable OpenAI-compatible gateway provider for existing text, image, video, and audio catalog models.
- Added catalog validation and audit tooling for provider/model/mode/reference delivery rules.
- Bumped the plugin version to `1.24.0`.

## 1.23.0

- Reworked `.bragi` export/import to use a streaming ZIP package format that avoids large-canvas string and buffer limits while keeping legacy JSON package import compatibility.
- Added an export confirmation modal with asset/package size stats, destination selection, and reveal-in-file-manager support.
- Fixed merge import, large canvas export/import, and asset-heavy package handling so imported nodes repaint reliably and exports clean up partial files on failure.
- Changed ElevenLabs Sound Effects duration to a range control with provider-specific ElevenLabs and fal.ai limits, including clamped provider/MCP defaults.
- Cleared Obsidian community review lint warnings and deprecated settings re-render self-calls.
- Bumped the plugin version to `1.23.0`.

## 1.22.0

- Added DashScope Wan 2.7 video generation with text-to-video, image-to-video, reference-to-video, video extend, and video edit modes.
- Added configurable DashScope native base URL support, including southeast workspace compatibility.
- Simplified Wan 2.7 UI params and mode labels, including merging multi-image reference into Ref Image and fixing the Duration toolbar hover height.
- Fixed grid split, collage, and duplicate-with-connections flows so newly imported canvas nodes render immediately after being persisted.
- Fixed reference strip drag state so image, text, and audio refs self-heal if a drag is cancelled or dropped outside the window.
- Bumped the plugin version to `1.22.0`.

## 1.21.3

- Fixed TokenRouter text generation with upstream video references by sending relay video URLs as `video_url` content parts.
- Kept non-video file references on the existing file content path for TokenRouter text generation.
- Bumped the plugin version to `1.21.3`.

## 1.21.2

- Skipped the ModelArk and BytePlus asset moderation prefilter when creating reference assets for supported generation flows.
- Fixed reference asset uploads that could be rejected before the provider generation request started.
- Bumped the plugin version to `1.21.2`.

## 1.21.1

- Fixed Obsidian community audit warnings by removing unused AI SDK dependencies from the plugin package.
- Removed remaining CSS `!important` usage from inline tool and generated stylesheet output.
- Tightened inline tool CSS specificity so the toolbar behavior remains intact without `!important`.
- Bumped the plugin version to `1.21.1`.

## 1.21.0

- Added `seedream-5.0-lite` as an image model on Volcengine and BytePlus, with 2K, 3K, and 4K output options.
- Added BytePlus Seedream image generation through the international BytePlus ARK endpoint.
- Changed BytePlus asset handling to use an explicit reusable Asset group ID instead of creating asset groups automatically.
- Added per-provider API model ID overrides in the provider model management UI.
- Migrated legacy BytePlus `byteplusProjectName` values that look like asset group IDs into the new `byteplusAssetGroupId` setting.
- Bumped the plugin version to `1.21.0`.

## 1.20.0

- Added MuleRouter CarrotHub image models: `z-image-spicy` for text-to-image and `qwen-image-edit-spicy` for image-ref-to-image.
- Added SuChuang as an optional provider for the existing `omni-flash-ext` video model, including async task submission, polling, Relay image reference routing, and final URL extraction.
- Added an inline video editing tool for trimming video nodes and capturing frames back onto the canvas.
- Improved inline tool layout with node-relative top and bottom toolbars, moving video capture and save controls into the top toolbar.
- Fixed MCP tool schemas so `inputSchema` is emitted with a top-level `type: object`.
- Added verification scripts for MuleRouter CarrotHub image models and SuChuang Gemini Omni.
- Bumped the plugin version to `1.20.0`.

## 1.19.1

- Fixed canvas inline annotation mode regressions introduced by the new image annotation tool.
- Improved inline tool session state handling, viewport focusing, toolbar suppression/reveal, and exit cleanup.
- Fixed annotation toolbar interactions for color dropdowns, pointer/focus scope, and native toolbar restoration.
- Adjusted node toolbar positioning and annotation CSS for the inline tool mode.
- Bumped the plugin version to `1.19.1`.

## 1.19.0

- Added APIMart Omni-Flash-Ext as a video model with text-to-video, first-frame, multi-image-ref, and video-ref modes.
- Routed APIMart video reference images and videos through Bragi Relay before provider calls, avoiding raw data URIs and third-party source URLs.
- Normalized reference image upload preparation across APIMart, OpenAI-compatible, TokenRouter, and Token360 paths.
- Added reference image upload verification coverage.
- Bumped the plugin version to `1.19.0`.

## 1.18.0

- Added inline image annotation tools on canvas image nodes, including box, number, and mosaic markup with save/undo/redo controls.
- Fixed Token360 Seedance asset uploads for WebP references by validating image bytes, converting WebP uploads to PNG, and honoring API-level error payloads.
- Changed TokenRouter ModelArk asset handling to use only an explicitly configured asset group ID, with clearer errors when the group is missing or inaccessible.
- Validated cached Seedance asset references before reusing them so stale TokenRouter, Token360, BytePlus, or Volcengine asset IDs are refreshed instead of sent blindly.
- Fixed the MCP HTTP worker listener and Node runtime resolution used by the local StreamableHTTP server.
- Bumped the plugin version to `1.18.0`.

## 1.17.2

- Added Token360 as a Seedance video provider for `seedance-2.0` and `seedance-2.0-fast`.
- Added Token360 video task creation, polling, and download support.
- Added optional Token360 asset group uploads for RealFace / Virtual Portrait image references.
- Routed Token360 local reference media through temporary HTTPS URLs when asset upload is not configured.
- Bumped the plugin version to `1.17.2`.

## 1.17.1

- Added MuleRouter as a video provider.
- Added Wan 2.7 Spicy I2V as an explicit opt-in video model.
- Routed MuleRouter image and audio references through Bragi temporary relay URLs before provider calls.
- Preserved explicit provider-model connection semantics so the new model is addable but not auto-enabled for existing users.
- Bumped the plugin version to `1.17.1`.

## 1.17.0

- Refined the provider and model settings flow so provider credentials are only saved after selected models are connected.
- Added explicit provider-model connection preferences and a centralized settings migration pipeline.
- Updated Add Model, Manage Models, Remove Provider, MCP `list_models`, and the generate bar to respect connected provider-model pairs.
- Polished model/provider settings empty states and row layouts.
- Added an update reminder modal that checks the latest GitHub release when a canvas is opened or activated.
- Added the `Bragi Canvas: Check for updates` command and update-check verification script.
- Documented the update-check network request in the README.
- Bumped the plugin version to `1.17.0`.

## 1.16.0

- Added image collage composition for multi-selected image nodes, creating a new composed PNG node and source edges.
- Added TokenRouter ModelArk asset flow for Seedance reference media, including asset group creation, upload, review polling, and cached `asset://` references.
- Added provider-scoped Seedance asset IDs for TokenRouter, BytePlus, and Volcengine, with MCP `set_asset_id` support for the provider namespace.
- Added ElevenLabs voice cloning from upstream audio references, plus stability, similarity, style, and speed controls for ElevenLabs TTS.
- Added MiniMax voice cloning from upstream audio references.
- Improved range and number parameter controls in the generate bar.
- Fixed GPT Image 2 sizing by mapping selected aspect ratio and image tier to explicit OpenAI-compatible sizes.
- Bumped the plugin version to `1.16.0`.

## 1.15.1

- Removed runtime filesystem-based CSS hot reload code from the plugin bundle.
- Replaced the MCP SDK runtime dependency with a lightweight local JSON-RPC HTTP server.
- Scoped canvas listing, migration, and cleanup flows to Bragi-known canvases and indexed/generated assets instead of full vault enumeration.
- Replaced automatic clipboard writes in error details with a selectable read-only text area.
- Removed dynamic Pannellum script injection and imported the viewer bundle normally.
- Cleaned up community CSS lint warnings for `!important` and `:has()`.
- Bumped the plugin version to `1.15.1`.

## 1.15.0

- Added provider-aware multimodal text input validation for upstream images, PDFs, videos, and audio.
- Added native DashScope Qwen 3.6 Plus text generation with multimodal refs.
- Exposed `supportedInputs` and `unsupportedInputs` for text models through MCP `list_models`.
- Preserved uploaded Gemini and TokenRouter file refs so large multimodal inputs are sent correctly.
- Included the Bragi theme, canvas UI polish, and improved placeholder overlays from the latest mainline UI work.
- Bumped the plugin version to `1.15.0`.

## 1.14.3

- Added APIMart GPT-5.5 text provider support.
- Added Gemini 3.5 Flash text generation via Google Gemini and TokenRouter.
- Added Gemini multimodal text references for upstream video, audio, and PDF inputs.
- Split MCP tool registration into a dedicated registry module.
- Fixed Gemini text errors so Google quota and API-key details surface clearly.
- Bumped the plugin version to `1.14.3`.

## 1.14.2

- Added APIMart support for Nano Banana Pro and Nano Banana 2.
- Routed APIMart image requests through each model's selected API model ID instead of hardcoding GPT Image 2.
- Expanded APIMart task failure details so structured provider errors no longer show as `[object Object]`.
- Bumped the plugin version to `1.14.2`.

## 1.14.1

- Added TokenRouter support for Seedance 2.0 and Seedance 2.0 Fast using the Dreamina model IDs.
- Aligned TokenRouter Seedance video generation with the TokenRouter video task API, including `images`, `audios`, `videos`, and Seedance controls in `metadata`.
- Kept existing TokenRouter image/text and HappyHorse video behavior unchanged.
- Bumped the plugin version to `1.14.1`.

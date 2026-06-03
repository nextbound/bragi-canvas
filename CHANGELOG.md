# Changelog

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

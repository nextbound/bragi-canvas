# Changelog

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

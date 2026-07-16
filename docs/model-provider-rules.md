# Model Provider Rules

Use these checks when adding a built-in model/provider pairing:

- Add the model as a `ModelConfig` in `src/models/*`, then register it in `ALL_MODELS`.
- Put provider-specific model IDs in `supportedProviders`; runtime code should receive the API model ID through `params.modelId`.
- Add `makeImage`, `makeVideo`, `makeText`, or `makeAudio` on the provider spec only for modalities the provider can actually run.
- Keep model params aligned with provider validation so saved settings or stale UI state fail with a clear message.
- For async video, return `{ done: false, taskId }` from `generateVideo`, implement `checkStatus`, and download the completed asset into `outputDir`. There is no polling timeout — a task runs until it succeeds or fails; the user can delete the placeholder node or rerun.
- Upload local upstream media with the built-in Bragi temporary relay before sending it to providers that require public URLs.

## Modeling provider differences

Everything that makes a provider differ from the base model lives in its `supportedProviders[providerId]` entry (`ProviderConfig`) or in a param's `providerOverrides`. Do not fork a whole second model entry for a "neutered" provider.

- `apiModelId` — the upstream model id this provider uses. The id editor in settings is **locked (static label) by default**.
- `editableApiModelId?: boolean` — opt-in. Set `true` to expose the pencil editor for providers that accept arbitrary upstream model ids (e.g. BytePlus C-Dance). Ignored when `aggregated` is set.
- `aggregated?: boolean` — the provider routes the model's modes to multiple upstream ids internally (e.g. DashScope Wan 2.7 -> t2v/i2v/r2v/videoedit; DashScope voice -> tts/enrollment models). Routing stays hard-coded in the provider; the catalog only marks it. Aggregated locks the id editor and shows a static label. Must not also set `editableApiModelId`.
- `modes?: Mode[]` — restrict this provider to a subset of the model's `modes`. The mode dropdown and MCP schema only show the active provider's effective modes; unsupported modes are hidden (never shown as disabled / "not supported"). Provider resolution is strict-to-active — there is no mode-based provider fallback.
- Param `providerOverrides[providerId]` — narrow a param's `options`/`default`/`min`/`max`/`step`/`unit` for one provider, or set `hidden: true` to drop the param entirely for that provider (e.g. MuleRouter Wan 2.7 omits `ratio` and uses lowercase resolutions).

Example: Wan 2.7 (`src/models/wan.ts`) is one model with DashScope (aggregated, all modes) and MuleRouter (`modes: ['first-frame']`, lowercase resolution override, hidden `ratio`).

## Static catalog check

`npm run check:catalog` (also part of root `npm run verify`) statically validates the catalog with no network. It fails the build when:

- a `supportedProviders` key is not a real provider id;
- `supportedProviders[p].modes` is not a subset of `model.modes`;
- a `model.modes` entry is offered by no provider (orphan mode);
- a `providerOverrides` key references a provider not in `supportedProviders`;
- an entry sets both `aggregated` and `editableApiModelId`, or `aggregated` has an empty `apiModelId`;
- a DashScope voice model with `clone`/`design`/`modelIds` does not mark its DashScope entry `aggregated: true`.

When you add a model/provider, run the check; if it fails, fix the catalog rather than the script.

## APIMart Omni-Flash-Ext

- Endpoint: `POST https://api.apimart.ai/v1/videos/generations`.
- Model ID: `Omni-Flash-Ext`.
- Task status: `GET https://api.apimart.ai/v1/tasks/{task_id}`.
- Supported video modes in Bragi: text-to-video, first-frame image-to-video, three-image reference fusion, and one reference video.
- All APIMart reference media must be sent as Bragi temporary relay URLs. Data URIs and external URLs must be uploaded or re-uploaded with `uploadRef` before they are assigned to `image_urls` or `video_urls`.
- Reference image count must be 0, 1, or 3. Two images are rejected by the provider.
- Reference video count must be 0 or 1. When `video_urls` is present, omit `duration`.
- Supported duration values are 4, 6, 8, and 10 seconds.
- Supported resolution values are `720p`, `1080p`, and `4k`.

## Kling 3.0 Omni

- Bragi model ID: `kling-3.0-omni`; upstream model ID on both providers: `kling-v3-omni`.
- Native Kling endpoint: `POST /v1/videos/omni-video`; Bragi tries the existing global `https://api.klingai.com` region first and falls back to the documented Beijing host when the AK is not registered globally. Task polling probes both regional hosts.
- APIMart endpoint: `POST https://api.apimart.ai/v1/videos/generations`; task status uses `GET /v1/tasks/{task_id}`.
- Supported modes are text-to-video, first-frame, first-last-frame, image reference, feature-video reference, and base-video edit.
- Native Kling uses `image_list` entries with `first_frame` / `end_frame`; APIMart uses `image_with_roles` with `first_frame` / `last_frame`.
- Reference-image mode adds missing `<<<image_N>>>` tokens so every ordered canvas image participates. Native Kling accepts up to 7 images without a video and 4 with either a feature or base video; APIMart feature-video mode accepts at most one first-frame image.
- Video reference maps to `video_list.refer_type = feature`; video edit maps to `base` and may combine the base video with ordinary reference images (`image_list` on Kling, `image_urls` on APIMart). Video edit adds missing image tokens, omits duration/aspect ratio, disables generated audio, and follows the source clip duration.
- Duration is an integer from 3 through 15. Quality values are `std`, `pro`, and `4k`. Generated audio is unavailable when `video_list` is present.
- Keep the generator bar compact: expose duration, ratio, quality, the mode-relevant audio control, and a `Multi shots` / `Single shot` toggle. `Multi shots` is the default and maps to intelligent splitting (`multi_shot = true`, `shot_type = intelligence`). Advanced callers may still pass custom `multi_prompt` shot lists and `element_list` directly.

## SuChuang Gemini Omni

- Endpoint: `POST https://api.wuyinkeji.com/api/async/video_google_omni`.
- Result status: `GET https://api.wuyinkeji.com/api/async/detail?id={task_id}`.
- Send the API key as both `Authorization` and `key` query parameter because the provider docs show both auth paths.
- Map Bragi `resolution` + `aspect_ratio` to SuChuang `size`: `1280x720` / `720x1280` for 720p, `1920x1080` / `1080x1920` for 1080p.
- SuChuang does not document 4K output for this endpoint. Reject `4k` clearly instead of silently downscaling.
- SuChuang reference images must be sent as Bragi temporary relay URLs in the comma-separated `images` field, capped at 7 images.
- SuChuang does not support reference videos for this endpoint.
- Treat status `0` / `1` as pending, `2` as success, and `3` as failure.

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
- `editableApiModelId?: boolean` — opt-in. Set `true` to expose the pencil editor for providers that accept arbitrary upstream model ids. BytePlus is the case in point: a model can be addressed by its public id (`seedream-5-0-lite-260128`) or by a custom inference endpoint (`ep-20260601093313-4dt9g`), so all four BytePlus entries set it. Ignored when `aggregated` is set.
- The rule lives in exactly one place — `isApiModelIdEditable(model, providerId)` in `src/models/index.ts` — and both the settings pencil and `pruneApiModelIdOverrides()` consume it. Do not copy the `aggregated` / opt-in check into a UI or a migration; a second copy is how the editor and the stored overrides drift apart.
- Overrides are stored per provider×model in `apiModelIdOverrides`, and `resolveApiModelId` prefers them over the catalog id unconditionally. That makes an unreachable override dangerous: it keeps rewriting requests while the UI offers no way to see or clear it. `pruneApiModelIdOverrides()` therefore runs on every load and drops overrides whose model left the catalog, whose provider dropped the model, or whose pairing is not editable.
- `aggregated?: boolean` — the provider routes the model to multiple upstream ids internally. The key can be the mode (DashScope Wan 2.7 -> t2v/i2v/r2v/videoedit; HappyHorse 1.1 -> the same four; DashScope voice -> tts/enrollment models) or a param (APIMart GPT Image 2.5 -> `variant` picks flare/sunburst). Reach for this whenever the catalog `apiModelId` is a display-only umbrella that upstream will not accept on its own; forking one catalog entry per upstream build is the wrong answer, because speed/quality builds of one model are a switch inside it, not separate models. Routing stays hard-coded in the provider; the catalog only marks it. Aggregated locks the id editor and shows a static label. Must not also set `editableApiModelId`.
- `modes?: Mode[]` — restrict this provider to a subset of the model's `modes`. The mode dropdown and MCP schema only show the active provider's effective modes; unsupported modes are hidden (never shown as disabled / "not supported"). Provider resolution is strict-to-active — there is no mode-based provider fallback.
- Param `providerOverrides[providerId]` — narrow a param's `options`/`optionsByMode`/`default`/`min`/`max`/`step`/`unit` for one provider, or set `hidden: true` to drop it entirely for that provider (e.g. MuleRouter Wan 2.7 omits `ratio`; xAI Grok Video 1.5 extends reference-to-video duration to 15 seconds while the legacy fal route remains capped at 10).

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

## Legnext Midjourney V8.2

- Bragi keeps the stable model ID `midjourney-v8` while displaying Midjourney V8.2 and injecting `--v 8.2` when the prompt does not already contain `--v` or `--version`.
- Legnext accepts model and render controls inside the `/v1/diffusion` `text` field. V8.2 exposes aspect ratio, Standard/2K resolution (`--hd`), stylize, chaos, raw style, stop, and weird controls. It does not expose the rejected `--q` / `--quality` flag.
- Explicit user-authored Midjourney flags win. Detect long and short aliases as complete tokens so `--s` does not collide with `--seed` and `--c` does not collide with `--cref`.
- Completed image tasks prefer the first non-empty URL in `output.image_urls`; use `output.image_url` only as a backward-compatible grid fallback.

## GPT Image 2.5 (APIMart)

- Bragi model ID: `gpt-image-2.5`, aggregated on APIMart. The upstream ids are `gpt-image-2.5-flare` (faster; everyday generation) and `gpt-image-2.5-sunburst` (editing precision), and the `variant` param picks one — `resolveApimartImageModelId` appends it, defaulting to `flare` for anything unrecognized. The bare `gpt-image-2.5` id is NOT callable, which is exactly why the entry is aggregated and the id editor stays locked.
- The two builds share one endpoint, one request schema, one mode, and one param set, so they are a speed/quality switch inside one model rather than two models. Do not split them back into separate catalog entries.
- A third id, `gpt-image-2.5-ext`, is listed by `/v1/models` with an empty `supported_endpoint_types` and is deliberately not wired.
- `variant` is consumed when building the request and never forwarded: the APIMart image body is an explicit whitelist (`model`, `prompt`, `size`, `resolution`, `n`, optional `quality` / `image_urls`).
- Endpoint: `POST https://api.apimart.ai/v1/images/generations`; task status uses the existing `GET /v1/tasks/{task_id}` poll, and the completed URL is read from `result.images[0].url[0]`.
- The request reuses the GPT Image 2 payload shape: the selected aspect ratio goes in `size` and the size tier goes in `resolution`. `resolution` accepts `1k` / `2k` / `4k` only, so the 2.5 models do not offer the Auto size tier.
- Both 2.5 builds honor `quality`, which adds the `xhigh` and `max` tiers on top of `auto` / `low` / `medium` / `high`. `honorsQuality()` in `apimart.ts` gates the field to the official GPT Image 2 channel plus every `gpt-image-2.5*` id; the non-official `gpt-image-2` route still omits it.
- Reference images ride the existing `image_urls` array through Bragi Relay, capped at 16.

## HappyHorse 1.1 (DashScope)

- Bragi model ID: `happyhorse-1.1`, aggregated on DashScope. The canvas mode selects the upstream id inside `DashScopeVideoProvider`: `text-to-video` → `happyhorse-1.1-t2v`, `first-frame` → `happyhorse-1.1-i2v`, `image-ref` → `happyhorse-1.1-r2v`, `video-edit` → `happyhorse-1.0-video-edit`.
- The editing model deliberately stays on 1.0: Alibaba ships no `happyhorse-1.1-video-edit`, and requesting it returns `404 InvalidParameter — Model not exist.` Verify with a probe before "upgrading" that id.
- All four ids post to `POST {baseUrl}/services/aigc/video-generation/video-synthesis` with `X-DashScope-Async: enable` and poll through the shared `GET {baseUrl}/tasks/{task_id}`, so HappyHorse reuses Wan's `checkStatus` and download path unchanged.
- The model, endpoint URL, and API key must belong to the same region. The DashScope base URL in provider settings decides the region; cross-region calls fail.
- `resolution` is `480P` / `720P` / `1080P` (default `1080P`) except video editing, which accepts `720P` / `1080P` only — expressed as an `optionsByMode` override rather than a second model.
- `ratio` (9 values, default `16:9`) applies to t2v and r2v only: i2v derives the frame from the input image and video editing follows the source clip. `duration` is 3-15s (default 5) for t2v / i2v / r2v; video editing follows the source clip length. `audio_setting` (`auto` / `origin`) is video-edit only. `watermark` is always sent as `false`.
- Reference limits: i2v takes exactly one `first_frame`; r2v takes 1-9 `reference_image` entries; video editing takes exactly one `video` plus 0-5 `reference_image` entries. Reference media is delivered as Bragi Relay HTTPS URLs (DashScope's `defaultRefDelivery`).
- HappyHorse 1.0 T2V / I2V were TokenRouter-only entries and are fully removed — catalog, TokenRouter payload branch, and stale `modelPrefs` / `modelOrder` / `apiModelIdOverrides` keys (settings schema 13).

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

## APIMart MiniMax-H3

- Bragi model ID: `minimax-h3`; APIMart model ID: `MiniMax-H3`.
- Submit with `POST https://api.apimart.ai/v1/videos/generations`; poll with `GET https://api.apimart.ai/v1/tasks/{task_id}` and read the completed URL from `result.videos[0].url`.
- Supported Bragi modes are `text-to-video`, `first-frame`, `first-last-frame`, `image-ref`, and `video-ref`. APIMart infers its upstream mode from the submitted reference fields; do not send a `mode` field.
- `first-frame` and `first-last-frame` use `first_frame_image` / `last_frame_image`. They require exactly one or two ordered images, ignore aspect ratio, and cannot include reference image/video/audio fields.
- `image-ref` sends up to 9 images in `image_urls` and may add up to 3 `audio_urls`. `video-ref` sends up to 3 `video_urls` and may combine them with up to 9 images and 3 audios. Audio cannot be the only reference modality.
- Every image, video, and audio reference must be re-uploaded through Bragi Relay. The APIMart request receives only temporary HTTPS URLs; never send data URIs or arbitrary external URLs directly.
- Prompt is required in every mode and must not exceed 7000 characters. Duration is a whole number from 4 through 15. Resolution is `2K` or `768P`.
- Ratios are `21:9`, `16:9`, `4:3`, `1:1`, `3:4`, and `9:16`. `adaptive` is accepted for reference generation; text-to-video normalizes it to `16:9`, while frame-controlled modes omit the field.
- `watermark` is a boolean and defaults to `false`. Webhooks are intentionally not exposed in the canvas model because Bragi's persistent task queue already owns completion tracking.

## Volcengine and BytePlus Seedance 2.5

- Bragi model ID: `seedance-2.5`; Volcengine model ID: `doubao-seedance-2-5-260628`; BytePlus model ID: `dreamina-seedance-2-5-260628`.
- Volcengine submits to `POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks`. BytePlus defaults to `POST https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks`, and its provider settings can override the complete Seedance task endpoint for Seedance 2.0, 2.0 Fast, and 2.5. Both poll by appending `/{task_id}` to the configured task endpoint through the existing `SeedanceProvider`.
- Supported Bragi modes are text-to-video, first-frame, first-last-frame, image reference, video reference, video extension, and video edit. First-frame inputs use `role: first_frame`; the second image in first-last-frame uses `role: last_frame`; multimodal references use `reference_image`, `reference_video`, and `reference_audio`.
- Multimodal limits are 30 images, 10 videos, and 10 audio clips (50 references total). Audio-only reference input is supported through `video-ref` mode.
- Duration defaults to Auto (`-1`) and accepts `-1` or 4–30 seconds. Video edit only accepts `-1`. Ratio defaults to `adaptive`; first-frame, first-last-frame, video-extend, and video-edit only accept `adaptive`. Text/reference generation also accepts `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, and `21:9`.
- Output resolution is 480p, 720p, or 1080p. Output format is MP4 or MOV; preserve a `.mov` extension when the completed task returns a MOV URL.
- Volcengine sends local reference media through temporary HTTPS relay URLs and passes manually bound `bytedance` `asset://` IDs through unchanged. With BytePlus native asset credentials, reference media uses the existing `asset://` flow; without those credentials, Bragi falls back to relay URLs. Face-containing media may still require a provider-approved asset.

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

## Pika Kling

- Base URL: `https://api.dev.pika.art`. Authenticate every request with the configured Pika key in the `X-API-Key` header.
- Bragi Kling 3.0 maps to Pika `kling-3.0`. Text-to-video and first-frame generation route through `/v1/media/kling/kling-3.0/text-to-video` and `/v1/media/kling/kling-3.0/image-to-video`; motion control uses `/v1/media/kling/kling-3.0/motion-control`.
- Pika does not expose Bragi's Kling 3.0 quality selector or first-last-frame generation, so hide the quality selector for this provider.
- Pika does not list a compatible Kling 3.0 Omni model, so Bragi does not expose Pika for Kling 3.0 Omni.
- Send Pika reference images and videos as Bragi temporary Relay HTTPS URLs.
- Poll all submitted tasks through `GET /v1/media/jobs/{id}`. On completion, use `output.video.url`, falling back to `GET /v1/media/jobs/{id}/content` when the status payload omits the content URL.
- Do not add Pika Kling O1 or map it to an existing Bragi model: Pika exposes it only as video-to-video and Bragi has no exact catalogue match. Pika also has no exact Kling 2.6 mapping.

## SuChuang Gemini Omni

- Endpoint: `POST https://api.wuyinkeji.com/api/async/video_google_omni`.
- Result status: `GET https://api.wuyinkeji.com/api/async/detail?id={task_id}`.
- Send the API key as both `Authorization` and `key` query parameter because the provider docs show both auth paths.
- Map Bragi `resolution` + `aspect_ratio` to SuChuang `size`: `1280x720` / `720x1280` for 720p, `1920x1080` / `1080x1920` for 1080p.
- SuChuang does not document 4K output for this endpoint. Reject `4k` clearly instead of silently downscaling.
- SuChuang reference images must be sent as Bragi temporary relay URLs in the comma-separated `images` field, capped at 7 images.
- SuChuang does not support reference videos for this endpoint.
- Treat status `0` / `1` as pending, `2` as success, and `3` as failure.

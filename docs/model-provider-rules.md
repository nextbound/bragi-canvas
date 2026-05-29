# Model Provider Rules

Use these checks when adding a built-in model/provider pairing:

- Add the model as a `ModelConfig` in `src/models/*`, then register it in `ALL_MODELS`.
- Put provider-specific model IDs in `supportedProviders`; runtime code should receive the API model ID through `params.modelId`.
- Add `makeImage`, `makeVideo`, `makeText`, or `makeAudio` on the provider spec only for modalities the provider can actually run.
- Keep model params aligned with provider validation so saved settings or stale UI state fail with a clear message.
- For async video, return `{ done: false, taskId }` from `generateVideo`, implement `checkStatus`, and download the completed asset into `outputDir`.
- Upload local upstream media with the built-in Bragi temporary relay before sending it to providers that require public URLs.

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

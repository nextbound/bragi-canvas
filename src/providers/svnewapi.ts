/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and gateway payloads are runtime-shaped data that this plugin narrows at use sites. */
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import type {
	ImageProvider, VideoProvider, AudioProvider,
	GenerateImageResult, GenerateVideoResult, GenerateAudioResult,
} from './types'
import { uploadRef } from './upload'
import { resolveOpenAIImageSize } from './openai-image-size'
import { resolveSeedreamImageSize } from './seedream'

/**
 * SV NewAPI — our self-hosted new-api / One-API gateway. It exposes stable `sv-*`
 * virtual model names (mapped to real upstreams via the channel `model_mapping`)
 * over an OpenAI-compatible surface:
 *   - text   → POST /v1/chat/completions   (handled by OpenAITextProvider in the registry)
 *   - image  → POST /v1/images/tasks        (async APIMart tasks; fallback to /images/generations)
 *   - video  → POST /v1/videos             (async task; poll GET /v1/videos/{id})
 *   - audio  → POST /v1/audio/speech       (synchronous binary stream)
 * Auth is a single bearer token. Reference media is delivered as public relay URLs.
 * Contract source: the gateway's client API reference (new-api / One-API).
 */

// Model ids that need special-casing (these are the gateway `sv-*` virtual names).
const SV_IMAGE_BANANA_PRO = 'sv-nano-banana-pro'    // APIMart gemini-3-pro-image-preview rejects `size`
// gpt-image-2 family on the APIMart channel (sv-gpt-image-2 and sv-gpt-image-2-official):
// aspect-ratio `size` + 1k/2k/4k `resolution` tier — same shape as the direct APIMart provider.
const SV_IMAGE_GPT_RE = /^sv-gpt-image-2(-official)?$/
const SV_IMAGE_GPT_OFFICIAL = 'sv-gpt-image-2-official' // only this one honors `quality`
const SV_VIDEO_SEEDANCE = 'sv-seedance-2.0'         // byteplus seedance: params go in `metadata`, not top-level
// Seedream's Ark upstream enforces a per-tier minimum pixel count, so its `size` must come
// from the Seedream-specific map, not the smaller generic OpenAI table (kept as a fallback for
// other OpenAI-compatible image models).
const SV_IMAGE_SEEDREAM_RE = /seedream/i

const DONE_STATUSES = new Set(['SUCCESS', 'SUCCEEDED', 'COMPLETED'])
const FAILED_STATUSES = new Set(['FAILURE', 'FAILED', 'ERROR', 'CANCELLED', 'CANCELED'])
const IMAGE_TASK_FIRST_POLL_DELAY_MS = 3000
const IMAGE_TASK_POLL_INTERVAL_MS = 3000
const IMAGE_TASK_MAX_WAIT_MS = 300000

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : []
}

function stringParam(value: unknown, fallback = ''): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	return fallback
}

function optionalString(value: unknown): string | undefined {
	const text = stringParam(value, '').trim()
	return text || undefined
}

function numericParam(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value !== 'string' || !value.trim()) return undefined
	const parsed = parseFloat(value)
	return Number.isFinite(parsed) ? parsed : undefined
}

function booleanParam(value: unknown): boolean | undefined {
	if (typeof value === 'boolean') return value
	if (value === 'true') return true
	if (value === 'false') return false
	return undefined
}

function isHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value)
}

function parseProviderError(label: string, resp: { status: number; text?: string; json?: unknown }): string {
	const body = asRecord(resp.json) || (() => {
		try { return asRecord(JSON.parse(resp.text || '')) } catch { return null }
	})()
	const error = asRecord(body?.error)
	const msg = stringParam(error?.message || body?.message || resp.text, `HTTP ${resp.status}`)
	const code = stringParam(error?.code || error?.type || body?.code, '')
	return `${label}: ${code ? code + ' — ' : ''}${msg}`
}

function extensionForMime(mimeType: string): string {
	if (mimeType.includes('webp')) return 'webp'
	if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg'
	if (mimeType.includes('png')) return 'png'
	if (mimeType.includes('wav')) return 'wav'
	if (mimeType.includes('mp4') || mimeType.includes('aac')) return 'm4a'
	if (mimeType.includes('ogg') || mimeType.includes('opus')) return 'ogg'
	if (mimeType.includes('flac')) return 'flac'
	if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3'
	return 'bin'
}

function dataUriToBytes(dataUri: string): { bytes: Uint8Array; ext: string; mimeType: string } | null {
	const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
	if (!match) return null
	const mime = match[1]
	return {
		bytes: Uint8Array.from(atob(match[2]), c => c.charCodeAt(0)),
		ext: extensionForMime(mime),
		mimeType: mime,
	}
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength)
	copy.set(bytes)
	return copy.buffer
}

async function sleep(ms: number): Promise<void> {
	return new Promise(r => window.setTimeout(r, ms))
}

function imageExtFromUrl(url: string): string {
	const clean = url.split('?')[0].toLowerCase()
	if (clean.endsWith('.webp')) return 'webp'
	if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'jpg'
	return 'png'
}

function videoExtFromUrl(url: string): string {
	const clean = url.split('?')[0].toLowerCase()
	if (clean.endsWith('.mov')) return 'mov'
	if (clean.endsWith('.webm')) return 'webm'
	return 'mp4'
}

// ── OpenAI image response: data[0].url or data[0].b64_json ──
function extractImageSource(data: unknown): string {
	const body = asRecord(data)
	const first = asRecord(asArray(body?.data)[0])
	const url = stringParam(first?.url, '').trim()
	if (url) return url
	const b64 = stringParam(first?.b64_json, '').trim()
	if (b64) return `data:image/png;base64,${b64}`
	return ''
}

// ── OpenAI video task: { id, status, metadata: { url } } ──
function unwrapData(data: unknown): JsonRecord {
	const body = asRecord(data) || {}
	return asRecord(body.data) || body
}

function extractTaskId(data: unknown): string {
	const body = asRecord(data)
	const nested = asRecord(body?.data)
	return stringParam(body?.id || body?.task_id || nested?.id || nested?.task_id, '').trim()
}

function extractStatus(data: unknown): string {
	return stringParam(unwrapData(data).status, '').trim()
}

function extractVideoUrl(data: unknown): string {
	const body = unwrapData(data)
	const metadata = asRecord(body.metadata)
	for (const value of [metadata?.url, metadata?.result_url, body.url, body.video_url, body.result_url]) {
		const url = stringParam(value, '').trim()
		if (url) return url
	}
	return ''
}

function extractFailure(data: unknown, fallback: string): string {
	const body = unwrapData(data)
	const error = asRecord(body.error)
	for (const value of [body.fail_reason, body.error_message, error?.message]) {
		const msg = stringParam(value, '').trim()
		if (msg) return msg
	}
	return fallback
}

function extractImageTaskFailure(data: unknown, fallback: string): string {
	const body = unwrapData(data)
	const errorValue = body.error
	if (typeof errorValue === 'string' && errorValue.trim()) return errorValue.trim()
	const error = asRecord(errorValue)
	for (const value of [body.fail_reason, body.error_message, error?.message, body.message]) {
		const msg = stringParam(value, '').trim()
		if (msg) return msg
	}
	return fallback
}

function shouldFallbackToSyncImage(resp: { status: number; text?: string; json?: unknown }): boolean {
	if (resp.status === 404 || resp.status === 405) return true
	if (resp.status !== 400) return false
	const body = asRecord(resp.json) || (() => {
		try { return asRecord(JSON.parse(resp.text || '')) } catch { return null }
	})()
	const message = stringParam(body?.error || body?.message || resp.text, '').toLowerCase()
	return message.includes('async image tasks are only supported for apimart channels')
		|| message.includes('only supported for apimart')
}

// Reference media is delivered to the gateway as public URLs or provider asset:// ids.
// http(s) inputs and asset:// refs pass through unchanged (asset:// is produced by the
// gateway asset-registration flow, see svnewapi-asset-flow.ts); data URIs (any modality
// — image/audio/video) are uploaded to the relay.
async function uploadRefMedia(label: string, ref: string): Promise<string> {
	if (isHttpUrl(ref) || ref.startsWith('asset://')) return ref
	const decoded = dataUriToBytes(ref)
	if (!decoded) throw new Error(`${label}: unsupported reference media format`)
	return uploadRef(undefined, copyToArrayBuffer(decoded.bytes), `ref.${decoded.ext}`, decoded.mimeType)
}

export class SvNewApiImageProvider implements ImageProvider {
	name = 'SV NewAPI'
	private apiKey: string
	private app: App
	private outputDir: string
	private baseUrl: string

	constructor(apiKey: string, app: App, outputDir: string, baseUrl: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
		this.baseUrl = baseUrl.replace(/\/$/, '')
	}

	async generateImage(prompt: string, params?: Record<string, unknown>): Promise<GenerateImageResult> {
		const modelId = stringParam(params?.modelId)
		if (!modelId) throw new Error('SV NewAPI image: modelId required')

		const refImages: string[] = Array.isArray(params?.refImages) ? params.refImages as string[] : []
		const body: JsonRecord = { model: modelId, prompt, n: 1 }
		// Banana Pro (gemini-3-pro-image-preview) expects APIMart's shape:
		// aspect-ratio `size` plus a 1k/2k/4k `resolution` tier. Seedream needs
		// its own larger size map (the Ark upstream rejects the smaller generic
		// sizes). Everything else takes an OpenAI pixel `size`.
		if (modelId === SV_IMAGE_BANANA_PRO) {
			body.size = stringParam(params?.aspectRatio, '1:1')
			const tier = stringParam(params?.imageSize ?? params?.resolution, '1K').toLowerCase()
			body.resolution = tier === 'auto' ? '1k' : tier
		} else if (SV_IMAGE_GPT_RE.test(modelId)) {
			// Both sv-gpt-image-2 and sv-gpt-image-2-official route to the APIMart channel,
			// which takes an aspect-ratio `size` plus a 1k/2k/4k `resolution` clarity tier
			// (same shape as the direct APIMart provider) and bills per quality × resolution —
			// so send the tier explicitly rather than a derived pixel size.
			body.size = stringParam(params?.aspectRatio, '1:1')
			const tier = stringParam(params?.imageSize ?? params?.resolution, '2K').toLowerCase()
			body.resolution = tier === 'auto' ? '2k' : tier
		} else if (SV_IMAGE_SEEDREAM_RE.test(modelId)) {
			body.size = resolveSeedreamImageSize(
				stringParam(params?.resolution ?? params?.imageSize, '2K'),
				stringParam(params?.aspectRatio, '1:1'),
			)
		} else {
			body.size = resolveOpenAIImageSize({
				...params,
				imageSize: params?.imageSize ?? params?.resolution,
			})
		}
		// `quality` is forwarded ONLY for sv-gpt-image-2-official, whose upstream honors it.
		// Plain sv-gpt-image-2's upstream rejects the model UI's OpenAI-style enum
		// ("invalid quality: medium, allowed: standard/hd/4k/ultra/high"), so omit it there
		// and let that upstream default the quality.
		if (modelId === SV_IMAGE_GPT_OFFICIAL) {
			const quality = optionalString(params?.quality)
			if (quality) body.quality = quality
		}
		if (refImages.length > 0) {
			const imageUrls = await Promise.all(refImages.map(ref => uploadRefMedia('SV NewAPI image', ref)))
			body.image = imageUrls
			body.image_urls = imageUrls
		}

		return this.generateImageAsync(body)
	}

	private async generateImageAsync(body: JsonRecord): Promise<GenerateImageResult> {
		const resp = await requestUrl({
			url: `${this.baseUrl}/v1/images/tasks`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
			throw: false,
			body: JSON.stringify(body),
		})

		if (shouldFallbackToSyncImage(resp)) return this.generateImageSync(body)
		if (resp.status >= 400) throw new Error(parseProviderError('SV NewAPI image task', resp))

		const immediateSource = extractImageSource(resp.json)
		if (immediateSource) return this.saveImage(immediateSource)

		const taskId = extractTaskId(resp.json)
		if (!taskId) throw new Error('SV NewAPI image task: task id was not returned')
		return this.pollImageTask(taskId)
	}

	private async generateImageSync(body: JsonRecord): Promise<GenerateImageResult> {
		const resp = await requestUrl({
			url: `${this.baseUrl}/v1/images/generations`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
			throw: false,
			body: JSON.stringify(body),
		})
		if (resp.status >= 400) throw new Error(parseProviderError('SV NewAPI image', resp))

		const source = extractImageSource(resp.json)
		if (!source) throw new Error('SV NewAPI image: no image in response')
		return this.saveImage(source)
	}

	private async pollImageTask(taskId: string): Promise<GenerateImageResult> {
		await sleep(IMAGE_TASK_FIRST_POLL_DELAY_MS)
		const deadline = Date.now() + IMAGE_TASK_MAX_WAIT_MS - IMAGE_TASK_FIRST_POLL_DELAY_MS

		while (Date.now() < deadline) {
			const resp = await requestUrl({
				url: `${this.baseUrl}/v1/images/tasks/${encodeURIComponent(taskId)}`,
				method: 'GET',
				headers: { 'Authorization': `Bearer ${this.apiKey}` },
				throw: false,
			})
			if (resp.status >= 400) throw new Error(parseProviderError('SV NewAPI image task', resp))

			const status = extractStatus(resp.json).toUpperCase()
			const source = extractImageSource(resp.json)
			if (DONE_STATUSES.has(status) || source) {
				if (!source) throw new Error('SV NewAPI image task: completed task has no image URL')
				return this.saveImage(source)
			}
			if (FAILED_STATUSES.has(status)) {
				throw new Error(`SV NewAPI image task: ${extractImageTaskFailure(resp.json, 'task failed')}`)
			}

			await sleep(IMAGE_TASK_POLL_INTERVAL_MS)
		}
		throw new Error(`SV NewAPI image task: timed out after ${IMAGE_TASK_MAX_WAIT_MS / 1000}s`)
	}

	private async saveImage(source: string): Promise<GenerateImageResult> {
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) await adapter.mkdir(this.outputDir)

		if (/^data:image\//i.test(source)) {
			const decoded = dataUriToBytes(source)
			if (!decoded) throw new Error('SV NewAPI image: invalid data URI')
			const filePath = `${this.outputDir}/svnewapi_${Date.now()}.${decoded.ext}`
			await adapter.writeBinary(filePath, copyToArrayBuffer(decoded.bytes))
			return { filePath }
		}

		if (!isHttpUrl(source)) throw new Error('SV NewAPI image: unsupported image source')
		const imageResp = await requestUrl({ url: source })
		const filePath = `${this.outputDir}/svnewapi_${Date.now()}.${imageExtFromUrl(source)}`
		await adapter.writeBinary(filePath, imageResp.arrayBuffer)
		return { filePath }
	}
}

export class SvNewApiVideoProvider implements VideoProvider {
	name = 'SV NewAPI'
	private apiKey: string
	private app: App
	private outputDir: string
	private baseUrl: string

	constructor(apiKey: string, app: App, outputDir: string, baseUrl: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
		this.baseUrl = baseUrl.replace(/\/$/, '')
	}

	async generateVideo(prompt: string, params?: Record<string, unknown>): Promise<GenerateVideoResult> {
		const modelId = stringParam(params?.modelId)
		if (!modelId) throw new Error('SV NewAPI video: modelId required')

		const refImages: string[] = Array.isArray(params?.refImages) ? params.refImages as string[] : []
		const refAudios: string[] = Array.isArray(params?.refAudios) ? params.refAudios as string[] : []
		const refVideos: string[] = Array.isArray(params?.refVideos) ? params.refVideos as string[] : []
		const imageUrls = await Promise.all(refImages.map(ref => uploadRefMedia('SV NewAPI video', ref)))
		const audioUrls = await Promise.all(refAudios.map(ref => uploadRefMedia('SV NewAPI video', ref)))
		const videoUrls = await Promise.all(refVideos.map(ref => uploadRefMedia('SV NewAPI video', ref)))
		const body = buildVideoBody(modelId, prompt, params || {}, imageUrls, audioUrls, videoUrls)

		const resp = await requestUrl({
			url: `${this.baseUrl}/v1/videos`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
			throw: false,
			body: JSON.stringify(body),
		})
		if (resp.status >= 400) throw new Error(parseProviderError('SV NewAPI video', resp))

		const taskId = extractTaskId(resp.json)
		if (!taskId) throw new Error('SV NewAPI video: task id was not returned')
		return { done: false, taskId }
	}

	async checkStatus(taskId: string): Promise<GenerateVideoResult> {
		const resp = await requestUrl({
			url: `${this.baseUrl}/v1/videos/${encodeURIComponent(taskId)}`,
			method: 'GET',
			headers: { 'Authorization': `Bearer ${this.apiKey}` },
			throw: false,
		})
		if (resp.status >= 400) throw new Error(parseProviderError('SV NewAPI video', resp))

		const normalized = extractStatus(resp.json).toUpperCase()
		const videoUrl = extractVideoUrl(resp.json)
		if (DONE_STATUSES.has(normalized) || videoUrl) {
			if (!videoUrl) throw new Error('SV NewAPI video: completed task has no video URL')
			return { done: true, filePath: await this.downloadVideo(videoUrl) }
		}
		if (FAILED_STATUSES.has(normalized)) {
			throw new Error(`SV NewAPI video: ${extractFailure(resp.json, 'task failed')}`)
		}
		return { done: false, taskId }
	}

	private async downloadVideo(url: string): Promise<string> {
		const resp = await requestUrl({ url })
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) await adapter.mkdir(this.outputDir)
		const filePath = `${this.outputDir}/svnewapi_video_${Date.now()}.${videoExtFromUrl(url)}`
		await adapter.writeBinary(filePath, resp.arrayBuffer)
		return filePath
	}
}

/**
 * The gateway forwards to different upstreams that disagree on where params live:
 * Seedance (byteplus, Ark) reads ratio/duration/watermark from a `metadata` object and
 * builds an Ark `content[]` from the top-level `images`/`audios`/`videos` arrays (each
 * tagged with a reference role). The fal-routed models (kling/grok/veo/sora) take the
 * top-level `images` array plus top-level params; the gateway picks the fal sub-endpoint
 * by input shape (e.g. grok: 2+ images -> reference-to-video, a video -> extend-video).
 */
function buildVideoBody(
	modelId: string,
	prompt: string,
	params: Record<string, unknown>,
	imageUrls: string[],
	audioUrls: string[],
	videoUrls: string[],
): JsonRecord {
	const body: JsonRecord = { model: modelId, prompt }
	const ratio = optionalString(params.ratio || params.aspect_ratio || params.aspectRatio)
	const duration = optionalString(params.duration || params.durationSeconds)
	const resolution = optionalString(params.resolution)

	if (modelId === SV_VIDEO_SEEDANCE) {
		const metadata: JsonRecord = { watermark: false }
		if (ratio) metadata.ratio = ratio
		if (duration) metadata.duration = duration === '-1' ? -1 : parseInt(duration, 10)
		if (resolution) metadata.resolution = resolution
		if (params.generate_audio !== undefined) metadata.generate_audio = params.generate_audio !== 'false'
		body.metadata = metadata
		// The gateway converts each entry to an Ark content[] reference part
		// (image_url/reference_image, audio_url/reference_audio, video_url/reference_video).
		// Without these, refs are dropped and seedance runs as pure text-to-video.
		if (imageUrls.length) body.images = imageUrls
		if (audioUrls.length) body.audios = audioUrls
		if (videoUrls.length) body.videos = videoUrls
	} else {
		// Send the full ordered images array (plural) so the gateway can do first-frame,
		// first-last-frame, or multi-image reference modes; `videos` enables video-extend.
		if (imageUrls.length) body.images = imageUrls
		if (videoUrls.length) body.videos = videoUrls
		if (ratio) body.aspect_ratio = ratio
		if (duration && duration !== '-1') body.duration = duration
		if (resolution) body.resolution = resolution
	}
	return body
}

export class SvNewApiAudioProvider implements AudioProvider {
	name = 'SV NewAPI'
	private apiKey: string
	private app: App
	private outputDir: string
	private baseUrl: string

	constructor(apiKey: string, app: App, outputDir: string, baseUrl: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
		this.baseUrl = baseUrl.replace(/\/$/, '')
	}

	async generateAudio(prompt: string, options: { mode: 'tts' | 'music' | 'sound-effect', modelId?: string, [k: string]: unknown }): Promise<GenerateAudioResult> {
		const modelId = options.modelId
		if (!modelId) throw new Error('SV NewAPI audio: modelId required')

		const body: JsonRecord = { model: modelId, input: prompt }
		const metadata: JsonRecord = {}
		// Sound-effect models take no voice; TTS forwards the selected voice id/name.
		if (options.mode !== 'sound-effect') {
			const voice = optionalString(options.voice)
			if (voice) body.voice = voice
		}
		const speed = numericParam(options.speed)
		if (speed !== undefined) body.speed = speed

		if (options.mode === 'sound-effect') {
			const duration = numericParam(options.duration)
			if (duration !== undefined) metadata.duration_seconds = duration
		}

		const voiceSettings: JsonRecord = {}
		const stability = numericParam(options.stability)
		const similarityBoost = numericParam(options.similarity_boost)
		const style = numericParam(options.style)
		const useSpeakerBoost = booleanParam(options.use_speaker_boost)
		if (stability !== undefined) voiceSettings.stability = stability
		if (similarityBoost !== undefined) voiceSettings.similarity_boost = similarityBoost
		if (style !== undefined) voiceSettings.style = style
		if (useSpeakerBoost !== undefined) voiceSettings.use_speaker_boost = useSpeakerBoost
		if (Object.keys(voiceSettings).length > 0) metadata.voice_settings = voiceSettings
		if (Object.keys(metadata).length > 0) body.metadata = metadata

		const resp = await requestUrl({
			url: `${this.baseUrl}/v1/audio/speech`,
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.apiKey}` },
			throw: false,
			body: JSON.stringify(body),
		})
		if (resp.status >= 400) throw new Error(parseProviderError('SV NewAPI audio', resp))

		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) await adapter.mkdir(this.outputDir)

		// The gateway 302-redirects /v1/audio/speech to the upstream media URL (e.g. fal.media),
		// and Obsidian's requestUrl does not reliably auto-follow. It may also (rarely) return a
		// JSON envelope wrapping the URL. Resolve both to the final binary audio response.
		const audioResp = await this.resolveAudioResponse(resp)
		const ext = extensionForMime(stringParam(audioResp.headers?.['content-type'] || audioResp.headers?.['Content-Type'], 'audio/mpeg'))
		const filePath = `${this.outputDir}/svnewapi_audio_${Date.now()}.${ext === 'bin' ? 'mp3' : ext}`
		await adapter.writeBinary(filePath, audioResp.arrayBuffer)
		return { filePath }
	}

	private async resolveAudioResponse(resp: { status: number; headers?: Record<string, string>; json?: unknown; arrayBuffer: ArrayBuffer }): Promise<{ headers?: Record<string, string>; arrayBuffer: ArrayBuffer }> {
		if (resp.status >= 300 && resp.status < 400) {
			const location = stringParam(resp.headers?.['location'] || resp.headers?.['Location']).trim()
			if (!location) throw new Error('SV NewAPI audio: redirect without Location header')
			return requestUrl({ url: location })
		}
		const contentType = stringParam(resp.headers?.['content-type'] || resp.headers?.['Content-Type'])
		if (contentType.includes('application/json')) {
			const body = asRecord(resp.json)
			const url = stringParam(body?.url || asRecord(body?.data)?.url || asRecord(body?.audio)?.url, '').trim()
			if (!url) throw new Error(parseProviderError('SV NewAPI audio', resp))
			return requestUrl({ url })
		}
		return resp
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

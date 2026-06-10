/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and gateway payloads are runtime-shaped data that this plugin narrows at use sites. */
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import type {
	ImageProvider, VideoProvider, AudioProvider,
	GenerateImageResult, GenerateVideoResult, GenerateAudioResult,
} from './types'
import { uploadRef } from './upload'
import { resolveOpenAIImageSize } from './openai-image-size'

/**
 * SV NewAPI — our self-hosted new-api / One-API gateway. It exposes stable `sv-*`
 * virtual model names (mapped to real upstreams via the channel `model_mapping`)
 * over an OpenAI-compatible surface:
 *   - text   → POST /v1/chat/completions   (handled by OpenAITextProvider in the registry)
 *   - image  → POST /v1/images/generations (synchronous; the gateway polls async upstreams internally)
 *   - video  → POST /v1/videos             (async task; poll GET /v1/videos/{id})
 *   - audio  → POST /v1/audio/speech       (synchronous binary stream)
 * Auth is a single bearer token. Reference media is delivered as public relay URLs.
 * Contract source: the gateway's client API reference (new-api / One-API).
 */

// Model ids that need special-casing (these are the gateway `sv-*` virtual names).
const SV_IMAGE_BANANA_PRO = 'sv-image-banana-pro'   // APIMart gemini-3-pro-image-preview rejects `size`
const SV_VIDEO_SEEDANCE = 'sv-video-seedance'       // byteplus seedance: params go in `metadata`, not top-level

const DONE_STATUSES = new Set(['SUCCESS', 'SUCCEEDED', 'COMPLETED'])
const FAILED_STATUSES = new Set(['FAILURE', 'FAILED', 'ERROR', 'CANCELLED', 'CANCELED'])

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

async function uploadRefImage(label: string, ref: string): Promise<string> {
	if (isHttpUrl(ref)) return ref
	const decoded = dataUriToBytes(ref)
	if (!decoded) throw new Error(`${label}: unsupported reference image format`)
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

		const body: JsonRecord = { model: modelId, prompt, n: 1 }
		// Banana Pro (gemini-3-pro-image-preview) maps `size` to its own aspect_ratio and
		// rejects arbitrary pixel sizes — omit it. Everything else takes an OpenAI `size`.
		if (modelId !== SV_IMAGE_BANANA_PRO) {
			body.size = resolveOpenAIImageSize({
				...params,
				imageSize: params?.imageSize ?? params?.resolution,
			})
		}

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
		const imageUrls = await Promise.all(refImages.map(ref => uploadRefImage('SV NewAPI video', ref)))
		const body = buildVideoBody(modelId, prompt, params || {}, imageUrls)

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
 * Seedance (byteplus) reads ratio/duration/watermark from a `metadata` object; the
 * fal-routed models (kling/grok/veo) take a top-level `image` plus top-level params.
 */
function buildVideoBody(modelId: string, prompt: string, params: Record<string, unknown>, imageUrls: string[]): JsonRecord {
	const body: JsonRecord = { model: modelId, prompt }
	const ratio = optionalString(params.ratio || params.aspect_ratio || params.aspectRatio)
	const duration = optionalString(params.duration || params.durationSeconds)
	const resolution = optionalString(params.resolution)

	if (modelId === SV_VIDEO_SEEDANCE) {
		const metadata: JsonRecord = { watermark: false }
		if (ratio) metadata.ratio = ratio
		if (duration && duration !== '-1') metadata.duration = parseInt(duration, 10)
		if (resolution) metadata.resolution = resolution
		if (params.generate_audio !== undefined) metadata.generate_audio = params.generate_audio !== 'false'
		body.metadata = metadata
	} else {
		if (imageUrls[0]) body.image = imageUrls[0]
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
		// Sound-effect models take no voice; TTS forwards the selected voice id/name.
		if (options.mode !== 'sound-effect') {
			const voice = optionalString(options.voice)
			if (voice) body.voice = voice
		}

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

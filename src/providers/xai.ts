import { writeTaskResult, pollRequest, TaskPollingError, assertPendingStatus } from '../task-errors'
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import type { ImageProvider, GenerateImageResult, VideoProvider, GenerateVideoResult, AudioProvider, GenerateAudioResult, ListVoicesOptions, VoiceOption } from './types'
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import { uploadRef } from './upload'

const XAI_BASE = 'https://api.x.ai/v1'

function parseErr(resp: { status: number; text?: string; json?: unknown }): string {
	const body = resp.json ?? (() => { try { return JSON.parse(resp.text || '') } catch { return null } })()
	const msg = body?.error?.message || body?.error || body?.message || resp.text || ''
	return typeof msg === 'string' ? msg : JSON.stringify(msg).substring(0, 200)
}

/**
 * Normalize any ref image (data: URI or http URL) to the xAI ImageUrl struct shape.
 * xAI rejects bare strings with `invalid type: string, expected struct ImageUrl`.
 */
function toImageUrlStruct(ref: string): { url: string } {
	return { url: ref }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number') return String(value)
	return ''
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
		: []
}

function integerValue(value: unknown, fallback: number): number {
	if (value === undefined || value === null || value === '') return fallback
	const parsed = typeof value === 'number' ? value : Number.parseInt(stringValue(value), 10)
	return parsed
}

const XAI_IMAGE_MODEL = 'grok-imagine-image-2.0'
const XAI_VIDEO_MODEL = 'grok-imagine-video-1.5'
const XAI_LEGACY_VIDEO_MODEL = 'grok-imagine-video'
const XAI_IMAGE_RATIOS = new Set([
	'auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2',
	'19.5:9', '9:19.5', '20:9', '9:20',
])
const XAI_VIDEO_RATIOS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3'])
const XAI_VIDEO_RESOLUTIONS = new Set(['480p', '720p', '1080p'])

function normalizeXaiVoice(record: Record<string, unknown>, source: VoiceOption['source']): VoiceOption | null {
	const id = stringValue(record.voice_id || record.id)
	if (!id) return null
	const name = stringValue(record.name || record.voice_id || id)
	return {
		id,
		name: name || id,
		language: stringValue(record.language) || undefined,
		gender: stringValue(record.gender) || undefined,
		age: stringValue(record.age) || undefined,
		category: source === 'custom' ? 'Custom' : 'System',
		source,
	}
}

/**
 * xAI Grok Imagine image generation + editing.
 *
 * Endpoints:
 *   POST /v1/images/generations   — text-to-image, sync, returns hosted jpeg URL
 *   POST /v1/images/edits          — image-ref editing (up to 3 refs)
 *
 * Model: grok-imagine-image-2.0.
 */
export class XAIImageProvider implements ImageProvider {
	name = 'xAI'
	private apiKey: string
	private app: App
	private outputDir: string

	constructor(apiKey: string, app: App, outputDir: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
	}

	async generateImage(prompt: string, params?: Record<string, unknown>): Promise<GenerateImageResult> {
		const modelId = stringValue(params?.modelId) || XAI_IMAGE_MODEL
		const aspectRatio = stringValue(params?.aspectRatio) || 'auto'
		const resolution = stringValue(params?.resolution) || '1k'
		const quality = stringValue(params?.quality) || 'medium'
		const refImages = stringArray(params?.refImages)

		if (!XAI_IMAGE_RATIOS.has(aspectRatio)) throw new Error(`xAI: unsupported image aspect ratio ${aspectRatio}`)
		if (resolution !== '1k' && resolution !== '2k') throw new Error('xAI: image resolution must be 1k or 2k')
		if (quality !== 'low' && quality !== 'medium') throw new Error('xAI: image quality must be low or medium')
		if (refImages.length > 3) throw new Error('xAI: Grok Imagine 2.0 supports at most 3 reference images')

		const isEdit = refImages.length > 0
		const url = isEdit ? `${XAI_BASE}/images/edits` : `${XAI_BASE}/images/generations`

		const body: Record<string, unknown> = {
			model: modelId,
			prompt,
			n: 1,
			resolution,
			quality,
			response_format: 'url',
		}
		// Omitting auto preserves the first input image's ratio for editing and lets
		// the model choose a ratio for text-to-image.
		if (aspectRatio !== 'auto') body.aspect_ratio = aspectRatio

		if (isEdit) {
			// xAI accepts EITHER `image` (single) OR `images` (array) — sending both → 400.
			if (refImages.length === 1) {
				body.image = toImageUrlStruct(refImages[0])
			} else {
				body.images = refImages.map(toImageUrlStruct)
			}
		}

		const resp = await requestUrl({
			url,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(body),
			throw: false,
		})

		if (resp.status === 401 || resp.status === 403) throw new Error('xAI: invalid API key')
		if (resp.status >= 400) throw new Error(`xAI: ${parseErr(resp)}`)

		const imageUrl = resp.json?.data?.[0]?.url
		if (!imageUrl) throw new Error(`xAI: no image URL in response — ${JSON.stringify(resp.json).substring(0, 200)}`)

		const imgResp = await requestUrl({ url: imageUrl })
		const ext = imageUrl.includes('.png') ? 'png' : 'jpg'
		const fileName = `grok_${Date.now()}.${ext}`
		const filePath = `${this.outputDir}/${fileName}`

		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) await adapter.mkdir(this.outputDir)
		await adapter.writeBinary(filePath, imgResp.arrayBuffer)
		return { filePath }
	}
}

/**
 * xAI Grok Imagine Video 1.5 — one model, five modes routed via field selection:
 *   text-to-video:       /v1/videos/generations  { prompt }
 *   first-frame (image): /v1/videos/generations  { prompt, image:{url} }
 *   image-ref:           /v1/videos/generations  { prompt, reference_images:[{url},…] }
 *   video-edit:          /v1/videos/edits        { prompt, video:{url} }
 *   video-extend:        /v1/videos/extensions   { prompt, video:{url}, duration:2–10 }
 *
 * All async: POST returns {request_id}; poll GET /v1/videos/{id} (202 pending / 200 done).
 */
export class XAIVideoProvider implements VideoProvider {
	name = 'xAI'
	private apiKey: string
	private app: App
	private outputDir: string

	constructor(apiKey: string, app: App, outputDir: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
	}

	async generateVideo(prompt: string, params?: Record<string, unknown>): Promise<GenerateVideoResult> {
		const modelId = stringValue(params?.modelId) || XAI_VIDEO_MODEL
		const aspectRatio = stringValue(params?.aspect_ratio || params?.aspectRatio) || '16:9'
		const duration = integerValue(params?.duration ?? params?.durationSeconds, 5)
		const resolution = stringValue(params?.resolution) || '720p'
		const refImages = stringArray(params?.refImages)
		const refVideos = stringArray(params?.refVideos)
		const genMode = stringValue(params?.genMode) || 'text-to-video'
		const allowedModes = new Set(['text-to-video', 'first-frame', 'image-ref', 'video-edit', 'video-extend'])

		if (!allowedModes.has(genMode)) throw new Error(`xAI: unsupported Grok Video mode ${genMode}`)

		// Video 1.5 supports generation, first-frame, and reference-to-video. The
		// official edit/extension endpoints still reject 1.5 and require the legacy
		// Grok video model, so the xAI catalogue entry is intentionally aggregated.
		const requestModelId = genMode === 'video-edit' || genMode === 'video-extend'
			? XAI_LEGACY_VIDEO_MODEL
			: modelId
		const body: Record<string, unknown> = { model: requestModelId, prompt }
		let endpoint = `${XAI_BASE}/videos/generations`

		if (genMode === 'video-edit' || genMode === 'video-extend') {
			if (refVideos.length !== 1) throw new Error(`xAI ${genMode} requires exactly one upstream video.`)
			if (refImages.length > 0) throw new Error(`xAI ${genMode} does not accept reference images.`)
			if (genMode === 'video-edit') {
				endpoint = `${XAI_BASE}/videos/edits`
			} else {
				if (!Number.isInteger(duration) || duration < 2 || duration > 10) {
					throw new Error('xAI video-extend duration must be a whole number from 2 to 10 seconds')
				}
				endpoint = `${XAI_BASE}/videos/extensions`
				body.duration = duration
			}
			body.video = { url: await this.ensureUrl(refVideos[0]) }
		} else {
			if (!Number.isInteger(duration) || duration < 1 || duration > 15) {
				throw new Error('xAI: video duration must be a whole number from 1 to 15 seconds')
			}
			if (!XAI_VIDEO_RATIOS.has(aspectRatio)) throw new Error(`xAI: unsupported video aspect ratio ${aspectRatio}`)
			if (!XAI_VIDEO_RESOLUTIONS.has(resolution)) throw new Error(`xAI: unsupported video resolution ${resolution}`)
			if (refVideos.length > 0) throw new Error(`xAI ${genMode} does not accept reference videos.`)
			body.duration = duration
			body.aspect_ratio = aspectRatio
			body.resolution = resolution

			if (genMode === 'text-to-video') {
				if (refImages.length > 0) throw new Error('xAI text-to-video does not accept reference images.')
			} else if (genMode === 'first-frame') {
				if (refImages.length !== 1) throw new Error('xAI first-frame requires exactly one reference image.')
				body.image = { url: await this.ensureUrl(refImages[0]) }
			} else {
				if (refImages.length === 0) throw new Error('xAI image-ref requires at least one reference image.')
				if (refImages.length > 7) throw new Error('xAI image-ref supports at most 7 reference images.')
				if (resolution === '1080p') throw new Error('xAI image-ref supports up to 720p resolution.')
				const urls = await Promise.all(refImages.map(ref => this.ensureUrl(ref)))
				body.reference_images = urls.map(url => ({ url }))
			}
		}

		const resp = await requestUrl({
			url: endpoint,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(body),
			throw: false,
		})

		if (resp.status === 401 || resp.status === 403) throw new Error('xAI: invalid API key')
		if (resp.status >= 400) throw new Error(`xAI: ${parseErr(resp)}`)

		const requestId = resp.json?.request_id
		if (!requestId) throw new Error(`xAI: no request_id — ${JSON.stringify(resp.json).substring(0, 200)}`)
		return { done: false, taskId: requestId }
	}

	async checkStatus(taskId: string): Promise<GenerateVideoResult> {
		const resp = await pollRequest({
			url: `${XAI_BASE}/videos/${taskId}`,
			method: 'GET',
			headers: { 'Authorization': `Bearer ${this.apiKey}` },
			throw: false,
		})

		if (resp.status === 401 || resp.status === 403) throw new Error('xAI: invalid API key')
		if (resp.status === 202) return { done: false, taskId }
		if (resp.status >= 400) throw new Error(`xAI: ${parseErr(resp)}`)

		const body = resp.json
		const status = body?.status
		if (status === 'pending') return { done: false, taskId }
		if (status === 'failed' || status === 'expired') {
			const code = stringValue(body?.error?.code)
			const message = stringValue(body?.error?.message) || 'no reason provided'
			throw new TaskPollingError(`xAI: video ${status}${code ? ` [${code}]` : ''} — ${message}`, 'terminal')
		}
		if (status === 'done') {
			const videoUrl = body?.video?.url
			if (!videoUrl) throw new Error('xAI: completed task has no video URL')
			const videoResp = await pollRequest({ url: videoUrl })
			const fileName = `grok_video_${Date.now()}.mp4`
			const filePath = `${this.outputDir}/${fileName}`
			const adapter = this.app.vault.adapter
			if (!await adapter.exists(this.outputDir)) await adapter.mkdir(this.outputDir)
			await writeTaskResult(adapter, filePath, videoResp.arrayBuffer)
			return { done: true, filePath }
		}
		assertPendingStatus(status)
		return { done: false, taskId }
	}

	/** Accept a data URI or http(s) URL; upload data URIs to Bragi temporary storage. */
	private async ensureUrl(ref: string): Promise<string> {
		if (/^https?:/.test(ref)) return ref
		const match = ref.match(/^data:([^;]+);base64,(.+)$/)
		if (!match) throw new Error('xAI: unsupported reference media format')
		const mime = match[1]
		const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0))
		const ext = mime.includes('png') ? 'png'
			: mime.includes('webp') ? 'webp'
				: mime.includes('video') ? 'mp4'
					: 'jpg'
		return uploadRef(undefined, bytes.buffer, `ref.${ext}`, mime)
	}
}

/**
 * xAI Grok TTS — POST /v1/tts returns raw audio bytes (sync).
 * No `model` field: the endpoint is unified. Voice + language + codec drive the output.
 */
export class XAIAudioProvider implements AudioProvider {
	name = 'xAI'
	private apiKey: string
	private app: App
	private outputDir: string

	constructor(apiKey: string, app: App, outputDir: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
	}

	async generateAudio(prompt: string, options: { mode: 'tts' | 'music' | 'sound-effect'; modelId?: string; [k: string]: unknown }): Promise<GenerateAudioResult> {
		if (options.mode !== 'tts') {
			throw new Error('xAI only supports TTS; use ElevenLabs or fal.ai for music and sound effects.')
		}

		const voice = options.voice || 'eve'
		const language = options.language || 'auto'

		const resp = await requestUrl({
			url: `${XAI_BASE}/tts`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				text: prompt,
				language,
				voice_id: voice,
				output_format: { codec: 'mp3', sample_rate: 24000, bit_rate: 128000 },
			}),
			throw: false,
		})

		if (resp.status === 401 || resp.status === 403) throw new Error('xAI: invalid API key or TTS not authorized')
		if (resp.status >= 400) throw new Error(`xAI: ${parseErr(resp)}`)

		const fileName = `grok_tts_${Date.now()}.mp3`
		const filePath = `${this.outputDir}/${fileName}`
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) await adapter.mkdir(this.outputDir)
		await adapter.writeBinary(filePath, resp.arrayBuffer)
		return { filePath }
	}

	async listVoices(options?: ListVoicesOptions): Promise<VoiceOption[]> {
		const source = options?.source || 'all'
		const voices: VoiceOption[] = []
		if (source !== 'custom') voices.push(...await this.fetchVoices(`${XAI_BASE}/tts/voices`, 'builtin'))
		if (source !== 'builtin') {
			try {
				voices.push(...await this.fetchVoices(`${XAI_BASE}/custom-voices`, 'custom'))
			} catch (err) {
				if (voices.length === 0) throw err
			}
		}

		const query = options?.query?.trim().toLowerCase()
		if (!query) return voices
		return voices.filter(voice => [
			voice.id,
			voice.name,
			voice.description,
			voice.gender,
			voice.age,
			voice.language,
			voice.category,
		].some(value => String(value || '').toLowerCase().includes(query)))
	}

	private async fetchVoices(url: string, source: VoiceOption['source']): Promise<VoiceOption[]> {
		const resp = await requestUrl({
			url,
			method: 'GET',
			headers: { 'Authorization': `Bearer ${this.apiKey}` },
			throw: false,
		})
		if (resp.status === 401 || resp.status === 403) throw new Error('xAI: invalid API key or TTS not authorized')
		if (resp.status >= 400) throw new Error(`xAI voices: ${parseErr(resp)}`)
		const list: unknown[] = Array.isArray(resp.json?.voices) ? resp.json.voices : Array.isArray(resp.json?.data) ? resp.json.data : []
		return list
			.filter(isRecord)
			.map(record => normalizeXaiVoice(record, source))
			.filter((voice): voice is VoiceOption => !!voice)
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Resume strict linting after the runtime-shaped data boundary. */

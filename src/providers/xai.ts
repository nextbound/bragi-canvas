/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
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
 *   POST /v1/images/edits          — image-ref editing (up to 5 refs)
 *
 * Models: grok-imagine-image ($0.02), grok-imagine-image-quality ($0.04, recommended),
 * grok-imagine-image-pro ($0.07, deprecated but still live).
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
		// `quality` param (quality|normal) overrides the default apiModelId so we can expose one
		// "Grok Imagine" card in the UI but still hit the right tier on xAI.
		const tier = params?.quality === 'normal' ? 'grok-imagine-image' : 'grok-imagine-image-quality'
		const modelId = tier
		const aspectRatio = params?.aspectRatio || '1:1'
		const refImages: string[] = params?.refImages || []

		const isEdit = refImages.length > 0
		const url = isEdit ? `${XAI_BASE}/images/edits` : `${XAI_BASE}/images/generations`

		const body: unknown = {
			model: modelId,
			prompt,
			n: 1,
			aspect_ratio: aspectRatio,
			response_format: 'url',
		}

		if (isEdit) {
			// xAI accepts EITHER `image` (single) OR `images` (array) — sending both → 400.
			if (refImages.length === 1) {
				body.image = toImageUrlStruct(refImages[0])
			} else {
				body.images = refImages.slice(0, 5).map(toImageUrlStruct)
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
 * xAI Grok Imagine video — one model, three modes routed via field selection:
 *   text-to-video:       /v1/videos/generations  { prompt }
 *   first-frame (image): /v1/videos/generations  { prompt, image:{url} }
 *   image-ref:           /v1/videos/generations  { prompt, reference_images:[{url},…] }
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
		const modelId = params?.modelId || 'grok-imagine-video'
		const aspectRatio = params?.aspect_ratio || params?.aspectRatio || '16:9'
		let duration = parseInt(params?.duration || params?.durationSeconds || '5')
		const resolution = params?.resolution || '720p'
		const refImages: string[] = params?.refImages || []
		const refVideos: string[] = params?.refVideos || []
		const genMode = params?.genMode || 'text-to-video'

		// Per-mode duration caps (verified against live API, 2026-05-07):
		//   text-to-video / first-frame / video-extend: 1–15s
		//   reference-to-video:                         1–10s
		if (genMode === 'image-ref' && duration > 10) duration = 10

		const body: unknown = {
			model: modelId,
			prompt,
			aspect_ratio: aspectRatio,
			duration,
			resolution,
		}

		let endpoint = `${XAI_BASE}/videos/generations`

		if (genMode === 'video-extend') {
			if (refVideos.length === 0) {
				throw new Error('xAI video-extend requires an upstream video URL.')
			}
			endpoint = `${XAI_BASE}/videos/extensions`
			body.video = { url: refVideos[0] }
			// aspect_ratio/resolution are ignored on extend; the server follows the source video.
		} else if (genMode === 'first-frame') {
			if (refImages.length === 0) throw new Error('xAI first-frame requires one reference image.')
			// Data: URIs must be uploaded first — xAI rejects data:-uri for image field in practice
			// (server sometimes accepts it inline, sometimes rejects as too large). Upload to Bragi
			// Relay to be safe + keep request bodies small.
			body.image = { url: await this.ensureUrl(refImages[0]) }
		} else if (genMode === 'image-ref') {
			if (refImages.length === 0) throw new Error('xAI image-ref requires at least one reference image.')
			const urls = await Promise.all(refImages.slice(0, 3).map(r => this.ensureUrl(r)))
			body.reference_images = urls.map(u => ({ url: u }))
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
		const resp = await requestUrl({
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
			throw new Error(`xAI: video ${status} — ${body?.error?.message || 'no reason provided'}`)
		}
		if (status === 'done') {
			const videoUrl = body?.video?.url
			if (!videoUrl) throw new Error('xAI: completed task has no video URL')
			const videoResp = await requestUrl({ url: videoUrl })
			const fileName = `grok_video_${Date.now()}.mp4`
			const filePath = `${this.outputDir}/${fileName}`
			const adapter = this.app.vault.adapter
			if (!await adapter.exists(this.outputDir)) await adapter.mkdir(this.outputDir)
			await adapter.writeBinary(filePath, videoResp.arrayBuffer)
			return { done: true, filePath }
		}
		return { done: false, taskId }
	}

	/** Accept data: URI or http(s) URL; upload data URIs to Bragi temporary storage for a short public URL. */
	private async ensureUrl(ref: string): Promise<string> {
		if (/^https?:/.test(ref)) return ref
		const match = ref.match(/^data:([^;]+);base64,(.+)$/)
		if (!match) throw new Error('xAI: unsupported reference image format')
		const mime = match[1]
		const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0))
		const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg'
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
		const list = Array.isArray(resp.json?.voices) ? resp.json.voices : Array.isArray(resp.json?.data) ? resp.json.data : []
		return list
			.filter(isRecord)
			.map(record => normalizeXaiVoice(record, source))
			.filter((voice): voice is VoiceOption => !!voice)
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Resume strict linting after the runtime-shaped data boundary. */

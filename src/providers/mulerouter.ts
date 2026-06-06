/* eslint-disable @typescript-eslint/no-unsafe-assignment -- MuleRouter responses are runtime-shaped and narrowed at the provider boundary. */
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import type { GenerateImageResult, GenerateVideoResult, ImageProvider, VideoProvider } from './types'
import { uploadRef } from './upload'

const BASE_URL = 'https://api.mulerouter.ai'
const Z_IMAGE_SPICY_PATH = '/vendors/carrothub/v1/z-image-spicy/generation'
const QWEN_IMAGE_EDIT_SPICY_PATH = '/vendors/carrothub/v1/qwen-image-edit-spicy/generation'
const WAN27_I2V_SPICY_PATH = '/vendors/carrothub/v1/wan2.7-i2v-spicy/generation'
const IMAGE_POLL_INITIAL_DELAY_MS = 10000
const IMAGE_POLL_INTERVAL_MS = 3000
const IMAGE_POLL_MAX_WAIT_MS = 300000
const DONE_STATUSES = new Set(['completed'])
const FAILED_STATUSES = new Set(['failed'])
const Z_IMAGE_SIZES: Record<string, { width: number; height: number }> = {
	'1:1': { width: 1024, height: 1024 },
	'2:3': { width: 1024, height: 1536 },
	'3:2': { width: 1536, height: 1024 },
	'3:4': { width: 1152, height: 1536 },
	'4:3': { width: 1536, height: 1152 },
	'4:5': { width: 1024, height: 1280 },
	'5:4': { width: 1280, height: 1024 },
	'9:16': { width: 864, height: 1536 },
	'16:9': { width: 1536, height: 864 },
}

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function stringParam(value: unknown, fallback = ''): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	return fallback
}

function isHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value)
}

async function sleep(ms: number): Promise<void> {
	return new Promise(r => window.setTimeout(r, ms))
}

function extensionForMime(mimeType: string): string {
	if (mimeType.includes('webp')) return 'webp'
	if (mimeType.includes('bmp')) return 'bmp'
	if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg'
	if (mimeType.includes('wav')) return 'wav'
	if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3'
	if (mimeType.includes('mp4')) return 'mp4'
	return 'png'
}

function imageExtFromUrl(url: string): string {
	const clean = url.split(/[?#]/)[0].toLowerCase()
	if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'jpg'
	if (clean.endsWith('.webp')) return 'webp'
	if (clean.endsWith('.gif')) return 'gif'
	return 'png'
}

function videoExtFromUrl(url: string): string {
	const clean = url.split(/[?#]/)[0].toLowerCase()
	if (clean.endsWith('.mov')) return 'mov'
	if (clean.endsWith('.webm')) return 'webm'
	return 'mp4'
}

function dataUriToBytes(dataUri: string): { bytes: Uint8Array; ext: string; mimeType: string } | null {
	const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
	if (!match) return null
	const mimeType = match[1]
	return {
		bytes: Uint8Array.from(atob(match[2]), c => c.charCodeAt(0)),
		ext: extensionForMime(mimeType),
		mimeType,
	}
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength)
	copy.set(bytes)
	return copy.buffer
}

function taskInfo(data: unknown): JsonRecord {
	return asRecord(asRecord(data)?.task_info) || {}
}

function providerErrorMessage(data: unknown, fallback: string): string {
	const body = asRecord(data) || {}
	const info = taskInfo(body)
	const taskError = asRecord(info.error)
	const error = asRecord(body.error)
	const code = stringParam(taskError?.code || error?.code, '')
	const title = stringParam(taskError?.title || error?.title, '')
	const detail = stringParam(taskError?.detail || error?.message || body.message, '')
	const parts = [code, title, detail].filter(Boolean)
	return parts.length > 0 ? parts.join(' — ') : fallback
}

function extractTaskId(data: unknown): string {
	return stringParam(taskInfo(data).id || asRecord(data)?.id, '').trim()
}

function extractStatus(data: unknown): string {
	return stringParam(taskInfo(data).status || asRecord(data)?.status, '').trim().toLowerCase()
}

function extractVideoUrl(data: unknown): string {
	const body = asRecord(data) || {}
	const videos = Array.isArray(body.videos) ? body.videos : []
	return stringParam(videos[0], '').trim()
}

function extractImageUrl(data: unknown): string {
	const body = asRecord(data) || {}
	const images = Array.isArray(body.images) ? body.images : []
	return stringParam(images[0], '').trim()
}

function parseZImageSize(value: unknown): { width: number; height: number } {
	return Z_IMAGE_SIZES[stringParam(value, '2:3')] || Z_IMAGE_SIZES['2:3']
}

function parseDuration(value: unknown): number {
	const parsed = typeof value === 'number' ? value : parseInt(stringParam(value, '5'), 10)
	if (!Number.isFinite(parsed)) return 5
	return Math.min(Math.max(parsed, 2), 15)
}

function parsePromptExtend(value: unknown): boolean {
	if (typeof value === 'boolean') return value
	return stringParam(value, 'true') !== 'false'
}

export class MuleRouterImageProvider implements ImageProvider {
	name = 'MuleRouter'

	constructor(
		private apiKey: string,
		private app: App,
		private outputDir: string,
		private baseUrl = BASE_URL,
	) {
		this.baseUrl = this.baseUrl.replace(/\/$/, '')
	}

	async generateImage(prompt: string, params?: Record<string, unknown>): Promise<GenerateImageResult> {
		const modelId = stringParam(params?.modelId, 'z-image-spicy')
		if (modelId === 'qwen-image-edit-spicy') return this.generateQwenImageEdit(prompt, params)
		return this.generateZImage(prompt, params)
	}

	private async generateZImage(prompt: string, params?: Record<string, unknown>): Promise<GenerateImageResult> {
		const size = parseZImageSize(params?.aspectRatio)
		const body: JsonRecord = {
			prompt,
			width: size.width,
			height: size.height,
			prompt_extend: parsePromptExtend(params?.prompt_extend),
		}

		const taskId = await this.submitImageTask(Z_IMAGE_SPICY_PATH, body, 'MuleRouter Z-Image Spicy')
		const imageUrl = await this.pollImageTask(Z_IMAGE_SPICY_PATH, taskId, 'MuleRouter Z-Image Spicy')
		return this.downloadImage(imageUrl, 'z_image_spicy')
	}

	private async generateQwenImageEdit(prompt: string, params?: Record<string, unknown>): Promise<GenerateImageResult> {
		const refImages: string[] = Array.isArray(params?.refImages) ? params.refImages : []
		if (!refImages[0]) throw new Error('MuleRouter Qwen Image Edit Spicy requires one upstream image.')

		const body: JsonRecord = {
			image: await this.ensurePublicUrl(refImages[0], 'image', 'MuleRouter Qwen Image Edit Spicy'),
			prompt,
		}

		const taskId = await this.submitImageTask(QWEN_IMAGE_EDIT_SPICY_PATH, body, 'MuleRouter Qwen Image Edit Spicy')
		const imageUrl = await this.pollImageTask(QWEN_IMAGE_EDIT_SPICY_PATH, taskId, 'MuleRouter Qwen Image Edit Spicy')
		return this.downloadImage(imageUrl, 'qwen_image_edit_spicy')
	}

	private async submitImageTask(path: string, body: JsonRecord, label: string): Promise<string> {
		const resp = await requestUrl({
			url: `${this.baseUrl}${path}`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(body),
			throw: false,
		})

		if (resp.status >= 400) {
			throw new Error(`${label}: ${providerErrorMessage(resp.json || resp.text, `HTTP ${resp.status}`)}`)
		}
		const taskId = extractTaskId(resp.json)
		if (!taskId) throw new Error(`${label}: task_info.id was not returned`)
		return taskId
	}

	private async pollImageTask(path: string, taskId: string, label: string): Promise<string> {
		await sleep(IMAGE_POLL_INITIAL_DELAY_MS)
		const deadline = Date.now() + IMAGE_POLL_MAX_WAIT_MS - IMAGE_POLL_INITIAL_DELAY_MS

		while (Date.now() < deadline) {
			const resp = await requestUrl({
				url: `${this.baseUrl}${path}/${encodeURIComponent(taskId)}`,
				method: 'GET',
				headers: { 'Authorization': `Bearer ${this.apiKey}` },
				throw: false,
			})

			if (resp.status >= 400) {
				throw new Error(`${label}: ${providerErrorMessage(resp.json || resp.text, `HTTP ${resp.status}`)}`)
			}

			const status = extractStatus(resp.json)
			if (DONE_STATUSES.has(status)) {
				const imageUrl = extractImageUrl(resp.json)
				if (!imageUrl) throw new Error(`${label}: completed task has no image URL`)
				return imageUrl
			}
			if (FAILED_STATUSES.has(status)) {
				throw new Error(`${label}: ${providerErrorMessage(resp.json, 'Task failed')}`)
			}
			await sleep(IMAGE_POLL_INTERVAL_MS)
		}
		throw new Error(`${label}: timed out after ${IMAGE_POLL_MAX_WAIT_MS / 1000}s`)
	}

	private async ensurePublicUrl(ref: string, kind: 'image', label: string): Promise<string> {
		if (isHttpUrl(ref)) return ref
		const decoded = dataUriToBytes(ref)
		if (!decoded) throw new Error(`${label}: unsupported reference ${kind} format`)
		return uploadRef(undefined, copyToArrayBuffer(decoded.bytes), `ref.${decoded.ext}`, decoded.mimeType)
	}

	private async downloadImage(url: string, basename: string): Promise<GenerateImageResult> {
		const resp = await requestUrl({ url })
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) await adapter.mkdir(this.outputDir)
		const filePath = `${this.outputDir}/mulerouter_${basename}_${Date.now()}.${imageExtFromUrl(url)}`
		await adapter.writeBinary(filePath, resp.arrayBuffer)
		return { filePath }
	}
}

export class MuleRouterVideoProvider implements VideoProvider {
	name = 'MuleRouter'

	constructor(
		private apiKey: string,
		private app: App,
		private outputDir: string,
		private baseUrl = BASE_URL,
	) {
		this.baseUrl = this.baseUrl.replace(/\/$/, '')
	}

	async generateVideo(prompt: string, params?: Record<string, unknown>): Promise<GenerateVideoResult> {
		const refImages: string[] = Array.isArray(params?.refImages) ? params.refImages : []
		const refAudios: string[] = Array.isArray(params?.refAudios) ? params.refAudios : []
		if (!refImages[0]) throw new Error('MuleRouter Wan 2.7 Spicy I2V requires one upstream image.')

		const body: JsonRecord = {
			prompt,
			image: await this.ensurePublicUrl(refImages[0], 'image'),
			resolution: stringParam(params?.resolution, '1080p') === '720p' ? '720p' : '1080p',
			duration: parseDuration(params?.duration),
			prompt_extend: parsePromptExtend(params?.prompt_extend),
		}
		if (refAudios[0]) body.audio_url = await this.ensurePublicUrl(refAudios[0], 'audio')

		const resp = await requestUrl({
			url: `${this.baseUrl}${WAN27_I2V_SPICY_PATH}`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(body),
			throw: false,
		})

		if (resp.status >= 400) {
			throw new Error(`MuleRouter video: ${providerErrorMessage(resp.json || resp.text, `HTTP ${resp.status}`)}`)
		}
		const taskId = extractTaskId(resp.json)
		if (!taskId) throw new Error('MuleRouter video: task_info.id was not returned')
		return { done: false, taskId }
	}

	async checkStatus(taskId: string): Promise<GenerateVideoResult> {
		const resp = await requestUrl({
			url: `${this.baseUrl}${WAN27_I2V_SPICY_PATH}/${encodeURIComponent(taskId)}`,
			method: 'GET',
			headers: { 'Authorization': `Bearer ${this.apiKey}` },
			throw: false,
		})

		if (resp.status >= 400) {
			throw new Error(`MuleRouter video: ${providerErrorMessage(resp.json || resp.text, `HTTP ${resp.status}`)}`)
		}

		const status = extractStatus(resp.json)
		if (DONE_STATUSES.has(status)) {
			const videoUrl = extractVideoUrl(resp.json)
			if (!videoUrl) throw new Error('MuleRouter video: completed task has no video URL')
			return { done: true, filePath: await this.downloadVideo(videoUrl) }
		}
		if (FAILED_STATUSES.has(status)) {
			throw new Error(`MuleRouter video: ${providerErrorMessage(resp.json, 'Task failed')}`)
		}
		return { done: false, taskId }
	}

	private async ensurePublicUrl(ref: string, kind: 'image' | 'audio'): Promise<string> {
		if (isHttpUrl(ref)) return ref
		const decoded = dataUriToBytes(ref)
		if (!decoded) throw new Error(`MuleRouter video: unsupported reference ${kind} format`)
		return uploadRef(undefined, copyToArrayBuffer(decoded.bytes), `ref.${decoded.ext}`, decoded.mimeType)
	}

	private async downloadVideo(url: string): Promise<string> {
		const resp = await requestUrl({ url })
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) await adapter.mkdir(this.outputDir)
		const filePath = `${this.outputDir}/mulerouter_wan27_${Date.now()}.${videoExtFromUrl(url)}`
		await adapter.writeBinary(filePath, resp.arrayBuffer)
		return filePath
	}
}

export async function testMuleRouterConnection(apiKey: string): Promise<{ ok: boolean; message: string }> {
	if (!apiKey) return { ok: false, message: 'API key is empty.' }
	try {
		const resp = await requestUrl({
			url: `${BASE_URL}${WAN27_I2V_SPICY_PATH}`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${apiKey}`,
			},
			body: '{}',
			throw: false,
		})
		if (resp.status === 401 || resp.status === 403) return { ok: false, message: 'Invalid API key.' }
		if (resp.status < 500) return { ok: true, message: 'Connected.' }
		return { ok: false, message: `Unexpected status ${resp.status}.` }
	} catch (err: unknown) {
		return { ok: false, message: `Network error: ${err?.message || err}` }
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment -- Resume strict linting after the runtime-shaped data boundary. */

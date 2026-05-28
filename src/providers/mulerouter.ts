/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- MuleRouter responses are runtime-shaped and narrowed at the provider boundary. */
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import type { GenerateVideoResult, VideoProvider } from './types'
import { uploadRef } from './upload'

const BASE_URL = 'https://api.mulerouter.ai'
const WAN27_I2V_SPICY_PATH = '/vendors/carrothub/v1/wan2.7-i2v-spicy/generation'
const DONE_STATUSES = new Set(['completed'])
const FAILED_STATUSES = new Set(['failed'])

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
	return /^https:\/\//i.test(value)
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

function parseDuration(value: unknown): number {
	const parsed = typeof value === 'number' ? value : parseInt(stringParam(value, '5'), 10)
	if (!Number.isFinite(parsed)) return 5
	return Math.min(Math.max(parsed, 2), 15)
}

function parsePromptExtend(value: unknown): boolean {
	if (typeof value === 'boolean') return value
	return stringParam(value, 'true') !== 'false'
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

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

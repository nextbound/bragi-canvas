import { requestUrl, type App } from 'obsidian'
import type { AudioProvider, GenerateAudioResult } from './types'

export const SONILO_BASE_URL = 'https://api.sonilo.com/v1'
const USER_AGENT = 'bragi-canvas/sonilo-music'

type SoniloInput = { path: '/text-to-music' | '/video-to-music'; fields: Record<string, string> }

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function parseJson(text: string): Record<string, unknown> {
	try { return record(JSON.parse(text) as unknown) } catch { return {} }
}

function message(data: Record<string, unknown>, fallback: string): string {
	const error = record(data.error)
	return typeof error.message === 'string' ? error.message
		: typeof data.message === 'string' ? data.message : fallback
}

function responseError(status: number, body: Record<string, unknown>): Error {
	const fallback: Record<number, string> = {
		401: 'Invalid API key.', 402: 'Insufficient Sonilo balance.',
		403: 'Service unavailable for this API key.', 422: 'Invalid generation parameters.',
		429: 'Rate or concurrency limit reached.',
	}
	return new Error(`Sonilo: ${message(body, fallback[status] || `HTTP ${status}`)}`)
}

export function buildSoniloRequest(prompt: string, options: Record<string, unknown>): SoniloInput {
	const source = options.mode
	if (source !== 'music' && source !== 'video-to-music') throw new Error('Sonilo: invalid music mode.')
	const outputFormat = options.output_format ?? 'mp3'
	if (typeof outputFormat !== 'string' || !['mp3', 'm4a', 'wav'].includes(outputFormat)) throw new Error('Sonilo: invalid output format.')
	const fields: Record<string, string> = { mode: 'async', output_format: outputFormat, variants_num: '1' }
	const trimmedPrompt = prompt.trim()
	if (source === 'music') {
		const duration = Number(options.duration ?? 30)
		if (!trimmedPrompt) throw new Error('Sonilo: music prompt is required.')
		if (!Number.isInteger(duration) || duration < 5 || duration > 360) throw new Error('Sonilo: duration must be 5–360 seconds.')
		fields.prompt = trimmedPrompt
		fields.duration = String(duration)
		return { path: '/text-to-music', fields }
	}
	const refs = options.refVideos
	if (!Array.isArray(refs) || refs.length !== 1 || typeof refs[0] !== 'string' || !refs[0].startsWith('https://')) {
		throw new Error('Sonilo video music needs exactly one upstream video.')
	}
	fields.video_url = refs[0]
	if (trimmedPrompt) fields.prompt = trimmedPrompt
	const influence = Number(options.prompt_influence ?? 0.5)
	if (!Number.isFinite(influence) || influence < 0 || influence > 1) throw new Error('Sonilo: prompt influence must be 0–1.')
	fields.prompt_influence = String(influence)
	return { path: '/video-to-music', fields }
}

export function encodeMultipartFields(fields: Record<string, string>, boundary: string): ArrayBuffer {
	const encoder = new TextEncoder()
	const parts = Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
	return encoder.encode(`${parts.join('')}--${boundary}--\r\n`).buffer
}

export class SoniloProvider implements AudioProvider {
	name = 'Sonilo'
	private retries = new Map<string, { count: number; nextAt: number }>()

	constructor(private apiKey: string, private app: App, private outputDir: string) {}

	private headers(): Record<string, string> {
		return { Authorization: `Bearer ${this.apiKey}`, 'User-Agent': USER_AGENT }
	}

	async generateAudio(prompt: string, options: { mode: 'tts' | 'music' | 'video-to-music' | 'sound-effect'; [key: string]: unknown }): Promise<GenerateAudioResult> {
		if (options.mode !== 'music' && options.mode !== 'video-to-music') throw new Error('Sonilo only supports music mode.')
		const input = buildSoniloRequest(prompt, options)
		const boundary = `----BragiSonilo${crypto.randomUUID()}`
		const response = await requestUrl({
			url: `${SONILO_BASE_URL}${input.path}`, method: 'POST',
			headers: { ...this.headers(), 'Content-Type': `multipart/form-data; boundary=${boundary}` },
			body: encodeMultipartFields(input.fields, boundary), throw: false,
		})
		const data = parseJson(response.text)
		if (response.status >= 400) throw responseError(response.status, data)
		const id = data.task_id
		if (response.status !== 202 || typeof id !== 'string' || !id.trim()) {
			throw new Error('Sonilo: generation did not return an async task ID.')
		}
		return { done: false, taskId: `sonilo:${id}` }
	}

	async checkStatus(taskId: string): Promise<GenerateAudioResult> {
		if (!taskId.startsWith('sonilo:') || taskId.length <= 7) throw new Error('Sonilo: invalid task ID.')
		const retry = this.retries.get(taskId)
		if (retry && Date.now() < retry.nextAt) return { done: false, taskId }
		const id = taskId.slice(7)
		let response: Awaited<ReturnType<typeof requestUrl>>
		try {
			response = await requestUrl({
				url: `${SONILO_BASE_URL}/tasks/${encodeURIComponent(id)}`,
				method: 'GET', headers: this.headers(), throw: false,
			})
		} catch {
			return this.transientFailure(taskId)
		}
		const data = parseJson(response.text)
		if (response.status === 429 || response.status >= 500) {
			const retryAfter = Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1]
			const retryAfterSeconds = retryAfter ? Number(retryAfter) : 0
			return this.transientFailure(taskId, retryAfterSeconds)
		}
		if (response.status >= 400) throw responseError(response.status, data)
		const status = data.status
		if (status === 'processing' || status === 'queued' || status === 'running') {
			this.retries.delete(taskId)
			return { done: false, taskId }
		}
		if (status === 'failed' || status === 'canceled') throw new Error(`Sonilo: ${message(data, `task ${status}`)}`)
		if (status !== 'succeeded' && status !== 'completed') throw new Error(`Sonilo: unknown task status ${String(status)}`)
		const audio = Array.isArray(data.audio) ? record(data.audio[0]) : {}
		const url = audio.url
		if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error('Sonilo: completed task has no audio URL.')
		const format = this.audioFormat(audio)
		let download: Awaited<ReturnType<typeof requestUrl>>
		try {
			download = await requestUrl({ url, method: 'GET', throw: false })
		} catch {
			return this.transientFailure(taskId)
		}
		if (download.status === 429 || download.status >= 500) {
			return this.transientFailure(taskId)
		}
		if (download.status >= 400) throw new Error(`Sonilo: audio download failed (HTTP ${download.status}).`)
		if (!download.arrayBuffer.byteLength) throw new Error('Sonilo: downloaded audio is empty.')
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) await adapter.mkdir(this.outputDir)
		const safeId = id.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 48)
		const filePath = `${this.outputDir}/sonilo_music_${safeId}_${Date.now()}.${format}`
		await adapter.writeBinary(filePath, download.arrayBuffer)
		this.retries.delete(taskId)
		return { done: true, filePath }
	}

	private audioFormat(audio: Record<string, unknown>): 'm4a' | 'mp3' | 'wav' {
		const mime = typeof audio.content_type === 'string' ? audio.content_type.toLowerCase() : ''
		if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
		if (mime.includes('wav')) return 'wav'
		if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a'
		const path = typeof audio.url === 'string' ? audio.url.split('?')[0].toLowerCase() : ''
		if (path.endsWith('.mp3')) return 'mp3'
		if (path.endsWith('.wav')) return 'wav'
		return 'm4a'
	}

	private transientFailure(taskId: string, retryAfterSeconds = 0): GenerateAudioResult {
		// Keep the accepted task alive: a transient poll/download error does not mean generation failed.
		const count = Math.min((this.retries.get(taskId)?.count || 0) + 1, 6)
		const backoffMs = Math.min(60_000, 2000 * 2 ** (count - 1))
		const retryAfterMs = Number.isFinite(retryAfterSeconds) ? Math.max(0, retryAfterSeconds * 1000) : 0
		this.retries.set(taskId, { count, nextAt: Date.now() + Math.max(backoffMs, retryAfterMs) })
		return { done: false, taskId }
	}
}

export async function testSoniloConnection(apiKey: string): Promise<{ ok: boolean; message: string }> {
	if (!apiKey) return { ok: false, message: 'API key is empty.' }
	try {
		const response = await requestUrl({
			url: `${SONILO_BASE_URL}/account/services`, method: 'GET',
			headers: { Authorization: `Bearer ${apiKey}`, 'User-Agent': USER_AGENT }, throw: false,
		})
		const data = parseJson(response.text)
		if (response.status !== 200) return { ok: false, message: responseError(response.status, data).message }
		const services = Array.isArray(data.available_services) ? data.available_services : []
		const hasMusic = services.some(s => s === 'text_to_music' || s === 'video_to_music')
		return hasMusic ? { ok: true, message: 'Connected.' } : { ok: false, message: 'Music service is not enabled.' }
	} catch (error: unknown) {
		return { ok: false, message: `Network error: ${error instanceof Error ? error.message : String(error)}` }
	}
}

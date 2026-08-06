import { requestUrl, type App } from 'obsidian'
import type { AudioProvider, GenerateAudioResult } from './types'

export const MUREKA_BASE_URL = 'https://api.mureka.ai'

type MurekaTaskKind = 'song' | 'instrumental'

interface MurekaRequest {
	path: '/v1/song/easy-generate' | '/v1/song/generate' | '/v1/instrumental/generate'
	body: Record<string, unknown>
	taskKind: MurekaTaskKind
}

function stringValue(value: unknown): string {
	if (typeof value === 'string' && value.trim()) return value.trim()
	if (typeof value === 'number' && Number.isFinite(value)) return String(value)
	return ''
}

function lyricsFrom(options: Record<string, unknown>): string {
	if (!Array.isArray(options.upstreamPrompts)) return ''
	return options.upstreamPrompts
		.filter((value): value is string => typeof value === 'string' && !!value.trim())
		.join('\n')
		.trim()
}

export function buildMurekaRequest(prompt: string, options: Record<string, unknown>): MurekaRequest {
	const generationMode = options.generation_mode || 'prompt'
	const model = stringValue(options.modelId) || 'auto'
	const nodePrompt = stringValue(options.nodePrompt) || prompt.trim()
	const common = { model, n: 1, stream: false }

	if (generationMode === 'prompt') {
		return {
			path: '/v1/song/easy-generate',
			body: { ...common, prompt: nodePrompt },
			taskKind: 'song',
		}
	}
	if (generationMode === 'lyrics') {
		const lyrics = lyricsFrom(options)
		if (!lyrics) throw new Error('Mureka Music with lyrics needs an upstream lyrics text node.')
		return {
			path: '/v1/song/generate',
			body: { ...common, lyrics, prompt: nodePrompt },
			taskKind: 'song',
		}
	}
	if (generationMode === 'instrumental') {
		return {
			path: '/v1/instrumental/generate',
			body: { ...common, prompt: nodePrompt },
			taskKind: 'instrumental',
		}
	}
	const modeLabel = typeof generationMode === 'string' ? generationMode : JSON.stringify(generationMode)
	throw new Error(`Mureka: unsupported generation mode "${modeLabel}"`)
}

export function encodeMurekaTaskId(kind: MurekaTaskKind, id: string): string {
	return `${kind}:${id}`
}

export function decodeMurekaTaskId(taskId: string): { kind: MurekaTaskKind; id: string } {
	if (taskId.startsWith('song:') && taskId.length > 5) return { kind: 'song', id: taskId.slice(5) }
	if (taskId.startsWith('instrumental:') && taskId.length > 13) return { kind: 'instrumental', id: taskId.slice(13) }
	throw new Error(`Mureka: invalid task ID "${taskId}"`)
}

function responseError(data: unknown, fallback: string): string {
	if (!data || typeof data !== 'object') return fallback
	const record = data as Record<string, unknown>
	const error = record.error
	if (typeof error === 'string' && error) return error
	if (error && typeof error === 'object') {
		const message = stringValue((error as Record<string, unknown>).message)
		if (message) return message
	}
	return stringValue(record.message) || stringValue(record.detail) || fallback
}

export class MurekaProvider implements AudioProvider {
	name = 'Mureka'

	constructor(
		private apiKey: string,
		private app: App,
		private outputDir: string,
	) {}

	async generateAudio(prompt: string, options: { mode: 'tts' | 'music' | 'sound-effect', modelId?: string, [k: string]: unknown }): Promise<GenerateAudioResult> {
		if (options.mode !== 'music') throw new Error(`Mureka: unsupported audio mode "${options.mode}"`)
		const request = buildMurekaRequest(prompt, options)
		const response = await requestUrl({
			url: `${MUREKA_BASE_URL}${request.path}`,
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${this.apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(request.body),
			throw: false,
		})
		if (response.status === 401 || response.status === 403) throw new Error('Mureka: invalid API key')
		if (response.status >= 400) throw new Error(`Mureka: ${responseError(response.json, `status ${response.status}`)}`)
		const id = stringValue(response.json?.id)
		if (!id) throw new Error('Mureka: no task ID in response')
		return { done: false, taskId: encodeMurekaTaskId(request.taskKind, id) }
	}

	async checkStatus(taskId: string): Promise<GenerateAudioResult> {
		const { kind, id } = decodeMurekaTaskId(taskId)
		const response = await requestUrl({
			url: `${MUREKA_BASE_URL}/v1/${kind}/query/${encodeURIComponent(id)}`,
			method: 'GET',
			headers: { 'Authorization': `Bearer ${this.apiKey}` },
			throw: false,
		})
		if (response.status === 401 || response.status === 403) throw new Error('Mureka: invalid API key')
		if (response.status >= 400) throw new Error(`Mureka: ${responseError(response.json, `status ${response.status}`)}`)

		const data = response.json
		const status = stringValue(data?.status).toLowerCase()
		if (status === 'succeeded') {
			const audioUrl = stringValue(data?.choices?.[0]?.url)
			if (!audioUrl) throw new Error('Mureka: completed task has no audio URL')
			return { done: true, filePath: await this.downloadAudio(audioUrl, id) }
		}
		if (['failed', 'timeouted', 'cancelled'].includes(status)) {
			throw new Error(`Mureka: ${stringValue(data?.failed_reason) || `task ${status}`}`)
		}
		if (!['preparing', 'queued', 'running', 'streaming'].includes(status)) {
			throw new Error(`Mureka: unknown task status "${status || 'empty'}"`)
		}
		return { done: false, taskId }
	}

	private async downloadAudio(url: string, taskId: string): Promise<string> {
		const response = await requestUrl({ url, method: 'GET', throw: false })
		if (response.status >= 400) throw new Error(`Mureka audio download: status ${response.status}`)
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) await adapter.mkdir(this.outputDir)
		const safeTaskId = taskId.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 48) || 'result'
		const filePath = `${this.outputDir}/mureka_music_${safeTaskId}_${Date.now()}.mp3`
		await adapter.writeBinary(filePath, response.arrayBuffer)
		return filePath
	}
}

export async function testMurekaConnection(apiKey: string): Promise<{ ok: boolean; message: string }> {
	if (!apiKey) return { ok: false, message: 'API key is empty.' }
	try {
		const response = await requestUrl({
			url: `${MUREKA_BASE_URL}/v1/account/billing`,
			method: 'GET',
			headers: { 'Authorization': `Bearer ${apiKey}` },
			throw: false,
		})
		if (response.status === 200) return { ok: true, message: 'Connected.' }
		if (response.status === 401 || response.status === 403) return { ok: false, message: 'Invalid API key.' }
		return { ok: false, message: `Unexpected status ${response.status}.` }
	} catch (err: unknown) {
		return { ok: false, message: `Network error: ${err instanceof Error ? err.message : String(err)}` }
	}
}

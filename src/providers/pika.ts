import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import type { GenerateVideoResult, VideoProvider } from './types'
import { buildPikaH3Request } from './pika-minimax-h3-payload'

const PIKA_API_BASE = 'https://api.dev.pika.art'
const KLING_3_MODEL_ID = 'kling-3.0'
const KLING_V3_DURATIONS = new Set(['5', '10'])
const KLING_3_RATIOS = new Set(['16:9', '9:16', '1:1'])
const PIKA_SOUNDS = new Set(['on', 'off'])
const MOTION_ORIENTATIONS = new Set(['image', 'video'])
const KEEP_SOUND_VALUES = new Set(['yes', 'no'])

type UnknownRecord = Record<string, unknown>

export interface PikaVideoRequest {
	path: string
	body: Record<string, unknown>
}

function isRecord(value: unknown): value is UnknownRecord {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown, fallback = ''): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	return fallback
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return []
	return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
}

function optionalString(body: UnknownRecord, key: string, value: unknown): void {
	if (typeof value === 'string' && value.trim()) body[key] = value
}

function parseV3Duration(value: unknown): string {
	const duration = stringValue(value, '5')
	if (!KLING_V3_DURATIONS.has(duration)) {
		throw new Error('Pika Kling 3.0 duration must be 5 or 10 seconds.')
	}
	return duration
}

function parseAspectRatio(value: unknown): string {
	const ratio = stringValue(value, '16:9')
	if (!KLING_3_RATIOS.has(ratio)) {
		throw new Error('Pika aspect ratio must be 16:9, 9:16, or 1:1.')
	}
	return ratio
}

function addCommonOptionalParams(body: UnknownRecord, params: UnknownRecord): void {
	if (params.sound !== undefined) {
		const sound = stringValue(params.sound)
		if (!PIKA_SOUNDS.has(sound)) throw new Error('Pika sound must be on or off.')
		body.sound = sound
	}
	optionalString(body, 'negative_prompt', params.negative_prompt)
	if (params.cfg_scale !== undefined) {
		const cfgScale = typeof params.cfg_scale === 'number'
			? params.cfg_scale
			: Number.parseFloat(stringValue(params.cfg_scale))
		if (!Number.isFinite(cfgScale) || cfgScale < 0 || cfgScale > 1) {
			throw new Error('Pika CFG scale must be between 0 and 1.')
		}
		body.cfg_scale = cfgScale
	}
}

export function buildPikaVideoRequest(
	prompt: string,
	params: Record<string, unknown> = {},
): PikaVideoRequest {
	const modelId = stringValue(params.modelId, KLING_3_MODEL_ID)
	const genMode = stringValue(params.genMode, 'text-to-video')
	const refImages = stringArray(params.refImages)
	const refVideos = stringArray(params.refVideos)

	if (!prompt.trim()) throw new Error('Pika requires a prompt.')
	if (modelId === 'minimax/h3') return buildPikaH3Request(prompt, params)

	if (modelId !== KLING_3_MODEL_ID) {
		throw new Error(`Pika does not support model "${modelId}".`)
	}
	if (genMode === 'first-last-frame') {
		throw new Error('Pika Kling 3.0 does not support first-last-frame generation.')
	}
	if (genMode === 'motion-control') {
		if (refImages.length < 1 || refVideos.length < 1) {
			throw new Error('Pika Kling 3.0 motion control requires one reference image and one reference video.')
		}
		const orientation = stringValue(params.character_orientation, 'video')
		if (!MOTION_ORIENTATIONS.has(orientation)) {
			throw new Error('Pika motion-control orientation must be image or video.')
		}
		const keepOriginalSound = stringValue(params.keep_original_sound, 'yes')
		if (!KEEP_SOUND_VALUES.has(keepOriginalSound)) {
			throw new Error('Pika motion-control source audio must be yes or no.')
		}
		return {
			path: `/v1/media/kling/${KLING_3_MODEL_ID}/motion-control`,
			body: {
				prompt,
				image_url: refImages[0],
				video_url: refVideos[0],
				character_orientation: orientation,
				keep_original_sound: keepOriginalSound,
			},
		}
	}
	if (genMode !== 'text-to-video' && genMode !== 'first-frame') {
		throw new Error(`Pika Kling 3.0 does not support ${genMode || 'the selected mode'}.`)
	}

	const body: UnknownRecord = {
		prompt,
		duration: parseV3Duration(params.duration),
		aspect_ratio: parseAspectRatio(params.aspect_ratio ?? params.aspectRatio),
	}
	addCommonOptionalParams(body, params)

	if (genMode === 'first-frame') {
		if (refImages.length < 1) {
			throw new Error('Pika Kling 3.0 first-frame generation requires one reference image.')
		}
		body.image = refImages[0]
	}

	return {
		path: `/v1/media/kling/${KLING_3_MODEL_ID}/${genMode === 'first-frame' ? 'image-to-video' : 'text-to-video'}`,
		body,
	}
}

function errorDetail(response: { status: number; json?: unknown; text?: string }): string {
	const data = isRecord(response.json) ? response.json : null
	const detail = data?.message ?? data?.error ?? response.text ?? `HTTP ${response.status}`
	if (typeof detail === 'string') return detail
	if (isRecord(detail)) return stringValue(detail.message, stringValue(detail.code, `HTTP ${response.status}`))
	try {
		return JSON.stringify(detail)
	} catch {
		return `HTTP ${response.status}`
	}
}

function jobStatus(data: UnknownRecord): string {
	return stringValue(data.status)
}

function jobError(data: UnknownRecord, fallback: string): string {
	return typeof data.error === 'string' ? data.error
		: isRecord(data.error) ? stringValue(data.error.message, stringValue(data.error.code, fallback))
		: fallback
}

function completedVideoUrl(data: UnknownRecord): string {
	const output = isRecord(data.output) ? data.output : null
	const video = output && isRecord(output.video) ? output.video : null
	return stringValue(video?.url)
}

export class PikaVideoProvider implements VideoProvider {
	name = 'Pika'
	private apiKey: string
	private app: App
	private outputDir: string

	constructor(apiKey: string, app: App, outputDir: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
	}

	async generateVideo(prompt: string, params?: Record<string, unknown>): Promise<GenerateVideoResult> {
		const request = buildPikaVideoRequest(prompt, params)
		const response = await requestUrl({
			url: `${PIKA_API_BASE}${request.path}`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-API-Key': this.apiKey,
			},
			body: JSON.stringify(request.body),
			throw: false,
		})
		if (response.status === 401 || (response.status === 403 && !isRecord(response.json?.error))) {
			throw new Error('Pika: invalid API key')
		}
		if (response.status >= 400) throw new Error(`Pika: ${errorDetail(response)}`)

		const data: unknown = response.json
		if (!isRecord(data)) throw new Error('Pika: malformed task response')
		const taskId = stringValue(data.id)
		if (!taskId) throw new Error('Pika: no task ID in response')
		if (jobStatus(data) === 'failed') {
			throw new Error(`Pika: ${jobError(data, 'task submission failed')}`)
		}
		return { done: false, taskId }
	}

	async checkStatus(taskId: string): Promise<GenerateVideoResult> {
		const response = await requestUrl({
			url: `${PIKA_API_BASE}/v1/media/jobs/${encodeURIComponent(taskId)}`,
			method: 'GET',
			headers: { 'X-API-Key': this.apiKey },
			throw: false,
		})
		if (response.status === 401 || response.status === 403) throw new Error('Pika: invalid API key')
		if (response.status >= 400) throw new Error(`Pika: ${errorDetail(response)}`)

		const data: unknown = response.json
		if (!isRecord(data)) throw new Error('Pika: malformed task status response')
		const status = jobStatus(data)
		if (status === 'queued' || status === 'running') return { done: false, taskId }
		if (status === 'failed') {
			throw new Error(`Pika: task failed — ${jobError(data, 'no reason provided')}`)
		}
		if (status !== 'completed') {
			throw new Error(`Pika: unknown task status "${status || 'missing'}"`)
		}

		let url = completedVideoUrl(data)
		if (!url) {
			const contentResponse = await requestUrl({
				url: `${PIKA_API_BASE}/v1/media/jobs/${encodeURIComponent(taskId)}/content`,
				method: 'GET',
				headers: { 'X-API-Key': this.apiKey },
				throw: false,
			})
			if (contentResponse.status >= 400) throw new Error(`Pika: ${errorDetail(contentResponse)}`)
			const content: unknown = contentResponse.json
			url = isRecord(content) ? stringValue(content.url) : ''
		}
		if (!url) throw new Error('Pika: completed task has no video URL')

		return { done: true, filePath: await this.downloadVideo(url) }
	}

	private async downloadVideo(url: string): Promise<string> {
		const response = await requestUrl({ url, throw: false })
		if (response.status >= 400) throw new Error(`Pika: failed to download video — HTTP ${response.status}`)
		const filePath = `${this.outputDir}/pika_video_${Date.now()}.mp4`
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) await adapter.mkdir(this.outputDir)
		await adapter.writeBinary(filePath, response.arrayBuffer)
		return filePath
	}
}

export async function testPikaConnection(apiKey: string): Promise<{ ok: boolean; message: string }> {
	if (!apiKey.trim()) return { ok: false, message: 'API key is empty.' }
	try {
		const response = await requestUrl({
			url: `${PIKA_API_BASE}/billing/balance`,
			method: 'GET',
			headers: { 'X-API-Key': apiKey },
			throw: false,
		})
		if (response.status === 200) return { ok: true, message: 'Connected.' }
		if (response.status === 401 || response.status === 403) return { ok: false, message: 'Invalid API key.' }
		return { ok: false, message: `Unexpected status ${response.status}.` }
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error)
		return { ok: false, message: `Network error: ${message}` }
	}
}

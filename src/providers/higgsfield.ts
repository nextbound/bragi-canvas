import { normalizePath, requestUrl, type App, type RequestUrlResponse } from 'obsidian'
import { MAGI_2_API_MODEL_ID, MAGI_2_DURATION, MAGI_2_MAX_SEED, MAGI_2_RATIOS, MAGI_2_RESOLUTION, MAGI_2_TEXT_API_MODEL_ID } from '../models/magi-2'
import { assertPendingStatus, pollRequest, TaskPollingError, withTimeout, writeTaskResult } from '../task-errors'
import type { GenerateVideoResult, VideoProvider } from './types'

const API_BASE = 'https://api.higgsfield.ai'
const MAX_PROMPT_LENGTH = 15000

function integerParam(value: unknown, fallback: number): number {
	if (value === undefined) return fallback
	if (typeof value === 'number') return value
	if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value)
	return NaN
}

export interface Magi2References {
	images: string[]
	videos: string[]
	audios: string[]
	pdfs: string[]
}

export function validateMagi2Inputs(prompt: string, mode: unknown, { images, videos, audios, pdfs }: Magi2References): void {
	if (Array.from(prompt).length > MAX_PROMPT_LENGTH || (mode === 'text-to-video' && !prompt.trim())) {
		throw new Error('MAGI-2 requires a prompt of 1 to 15000 characters when text is used.')
	}
	if (pdfs.length) throw new Error('MAGI-2 does not support PDF references.')
	switch (mode) {
		case 'text-to-video':
			if (images.length || videos.length || audios.length) throw new Error('MAGI-2 text-to-video requires a prompt without media references.')
			return
		case 'first-frame':
		case 'first-last-frame': {
			const count = mode === 'first-frame' ? 1 : 2
			if (images.length !== count || videos.length || audios.length) {
				throw new Error(`MAGI-2 ${mode} requires exactly ${count} image${count === 1 ? '' : 's'} and no video or audio.`)
			}
			return
		}
		case 'reference-to-video':
			if (!images.length && !videos.length && !audios.length) throw new Error('MAGI-2 reference-to-video requires an image, video, or audio reference.')
			if (images.length > 10 || videos.length > 5 || audios.length > 5) {
				throw new Error('MAGI-2 supports up to 10 images, 5 videos, and 5 audio clips.')
			}
			return
		default:
			throw new Error('Unsupported MAGI-2 generation mode.')
	}
}

export async function validateMagi2Media(app: App, { images, videos, audios }: Magi2References): Promise<void> {
	if (videos.some(path => !/\.(mp4|mov)$/i.test(path)) || audios.some(path => !/\.(wav|mp3)$/i.test(path))) {
		throw new Error('MAGI-2 references must use MP4 or MOV for video and WAV or MP3 for audio.')
	}
	for (const [paths, maxBytes, label] of [
		[images, 29_999_999, 'images under 30 MB'],
		[videos, 200_000_000, 'videos up to 200 MB'],
		[audios, 15_000_000, 'audio clips up to 15 MB'],
	] as const) {
		for (const path of paths) {
			const stat = await app.vault.adapter.stat(path)
			if (!stat || stat.type !== 'file' || !stat.size) throw new Error('A MAGI-2 reference is missing or empty.')
			if (stat.size > maxBytes) throw new Error(`MAGI-2 requires ${label}.`)
		}
	}
}

function referenceList(value: unknown): string[] {
	if (value === undefined) return []
	if (!Array.isArray(value) || !value.every((url: unknown): url is string => typeof url === 'string' && url.length <= 8192 && /^https:\/\/[^/\s?#]+(?:[/?#]\S*)?$/.test(url))) {
		throw new Error('MAGI-2 references must use public HTTPS URLs.')
	}
	return value
}

function videoRequest(prompt: string, params: Record<string, unknown>) {
	const mode = params.genMode ?? 'text-to-video'
	const refs = {
		images: referenceList(params.refImages),
		videos: referenceList(params.refVideos),
		audios: referenceList(params.refAudios),
		pdfs: referenceList(params.refPdfs),
	}
	validateMagi2Inputs(prompt, mode, refs)
	const duration = integerParam(params.duration, MAGI_2_DURATION.default)
	if (!Number.isInteger(duration) || duration < MAGI_2_DURATION.min || duration > MAGI_2_DURATION.max) {
		throw new Error('MAGI-2 duration must be a whole number from 4 to 30 seconds.')
	}
	const aspectRatio = params.aspect_ratio ?? '16:9'
	if (typeof aspectRatio !== 'string' || !MAGI_2_RATIOS.includes(aspectRatio)) {
		throw new Error('Choose one of the supported MAGI-2 ratios.')
	}
	const resolution = params.resolution ?? MAGI_2_RESOLUTION
	if (resolution !== MAGI_2_RESOLUTION) throw new Error('MAGI-2 resolution must be 1080p.')
	const audio = params.generate_audio ?? true
	if (audio !== true && audio !== false && audio !== 'true' && audio !== 'false') {
		throw new Error('MAGI-2 audio must be on or off.')
	}
	const seed = integerParam(params.seed, -1)
	if (!Number.isInteger(seed) || seed < -1 || seed > MAGI_2_MAX_SEED) {
		throw new Error('MAGI-2 seed must be -1 for random or a whole number from 0 to 4294967295.')
	}
	const body = {
		...(prompt.trim() ? { prompt } : {}),
		duration,
		aspect_ratio: aspectRatio,
		resolution,
		generate_audio: audio === true || audio === 'true',
		...(seed === -1 ? {} : { seed }),
	}
	if (mode === 'first-frame' || mode === 'first-last-frame') {
		return {
			modelId: `${MAGI_2_API_MODEL_ID}/image-to-video`,
			body: { ...body, image_url: refs.images[0], ...(mode === 'first-last-frame' ? { end_image_url: refs.images[1] } : {}) },
		}
	}
	if (mode === 'reference-to-video') {
		return {
			modelId: `${MAGI_2_API_MODEL_ID}/reference-to-video`,
			body: {
				...body,
				...(refs.images.length ? { image_urls: refs.images } : {}),
				...(refs.videos.length ? { video_urls: refs.videos } : {}),
				...(refs.audios.length ? { audio_urls: refs.audios } : {}),
			},
		}
	}
	return { modelId: MAGI_2_TEXT_API_MODEL_ID, body }
}

function responseData(response: RequestUrlResponse): Record<string, unknown> {
	try {
		const value: unknown = response.json
		if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
	} catch {
		// Gateways can return an empty or non-JSON HTTP error body.
	}
	return {}
}

function responseError(response: RequestUrlResponse, data: Record<string, unknown>): string {
	if (response.status === 401) return 'Higgsfield: invalid API key.'
	const detail = Array.isArray(data.detail) ? data.detail.map(errorDetail).filter(Boolean).join('. ') : errorDetail(data.detail)
	if (detail) return `Higgsfield: ${detail}`
	return `Higgsfield request failed (HTTP ${response.status}).`
}

function errorDetail(value: unknown): string {
	if (typeof value === 'string') return value.trim()
	if (!value || typeof value !== 'object') return ''
	if ('message' in value && typeof value.message === 'string') return value.message.trim()
	if ('msg' in value && typeof value.msg === 'string') return value.msg.trim()
	return ''
}

function authorization(apiKey: string): Record<string, string> {
	return { Authorization: `Key ${apiKey.trim()}` }
}

export class HiggsfieldVideoProvider implements VideoProvider {
	name = 'Higgsfield'

	constructor(private apiKey: string, private app: App, private outputDir: string) {}

	async generateVideo(prompt: string, params: Record<string, unknown> = {}): Promise<GenerateVideoResult> {
		if (params.modelId !== undefined && params.modelId !== MAGI_2_API_MODEL_ID && params.modelId !== MAGI_2_TEXT_API_MODEL_ID) {
			throw new Error('Unsupported Higgsfield video model.')
		}
		const { modelId, body } = videoRequest(prompt, params)
		const response = await withTimeout(requestUrl({
			url: `${API_BASE}/${modelId}`,
			method: 'POST',
			headers: { ...authorization(this.apiKey), 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
			body: JSON.stringify(body),
			throw: false,
		}), 90000, new Error('Higgsfield submission timed out. Check whether the request was accepted before trying again.'))
		const data = responseData(response)
		if (response.status >= 400) throw new Error(responseError(response, data))
		if (typeof data.request_id !== 'string' || !data.request_id.trim()) throw new Error('Higgsfield returned no request ID.')
		return { done: false, taskId: data.request_id }
	}

	async checkStatus(taskId: string, onProgress?: (phase: 'downloading') => void): Promise<GenerateVideoResult> {
		const response = await pollRequest({
			url: `${API_BASE}/requests/${encodeURIComponent(taskId)}/status`,
			headers: authorization(this.apiKey),
			throw: false,
		})
		const data = responseData(response)
		if (response.status >= 400) throw new TaskPollingError(responseError(response, data), 'attention')
		if (data.status === 'failed' || data.status === 'nsfw' || data.status === 'canceled') {
			const detail = errorDetail(data.error) || `request ${data.status}`
			throw new TaskPollingError(`Higgsfield: ${detail}`, 'terminal')
		}
		if (data.status !== 'completed') {
			assertPendingStatus(data.status)
			return { done: false, taskId }
		}
		const video = data.video
		const url = video && typeof video === 'object' && 'url' in video ? video.url : undefined
		if (typeof url !== 'string' || !url.startsWith('https://')) {
			throw new TaskPollingError('Higgsfield completed the request without an HTTPS video URL.', 'attention')
		}
		onProgress?.('downloading')
		const download = await pollRequest(url, 180000)
		if (!download.arrayBuffer.byteLength) throw new TaskPollingError('Higgsfield returned an empty video file.', 'attention')
		const directory = normalizePath(this.outputDir)
		const filePath = normalizePath(`${directory}/magi_2_${encodeURIComponent(taskId)}.mp4`)
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(directory)) await adapter.mkdir(directory)
		await writeTaskResult(adapter, filePath, download.arrayBuffer)
		return { done: true, filePath }
	}
}

export async function testHiggsfieldConnection(apiKey: string): Promise<{ ok: boolean; message: string }> {
	if (!/^[^\s:]+:[^\s:]+$/.test(apiKey.trim())) return { ok: false, message: 'Enter the API key as key ID:secret.' }
	try {
		// The required prompt is deliberately absent so this request cannot generate a video.
		const response = await withTimeout(requestUrl({
			url: `${API_BASE}/${MAGI_2_TEXT_API_MODEL_ID}`,
			method: 'POST',
			headers: { ...authorization(apiKey), 'Content-Type': 'application/json' },
			body: '{}',
			throw: false,
		}), 20000, new Error('Higgsfield connection test timed out.'))
		const data = responseData(response)
		if (response.status === 400 && typeof data.detail === 'string' && /['"]prompt['"] is a required property/.test(data.detail)) {
			return { ok: true, message: 'Connected.' }
		}
		return { ok: false, message: responseError(response, data) }
	} catch {
		return { ok: false, message: 'Could not reach Higgsfield. Check your connection and try again.' }
	}
}

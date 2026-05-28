import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import type { GenerateVideoResult, VideoProvider } from './types'
import { uploadRef } from './upload'

const BASE_URL = 'https://api.token360.ai/v1'
const DONE_STATUSES = new Set(['completed', 'succeeded', 'success'])
const FAILED_STATUSES = new Set(['failed', 'failure', 'error', 'cancelled', 'canceled'])

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
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

function optionalBoolean(value: unknown): boolean | undefined {
	if (typeof value === 'boolean') return value
	if (typeof value === 'number') return value !== 0
	if (typeof value !== 'string') return undefined
	const normalized = value.trim().toLowerCase()
	if (!normalized) return undefined
	if (['false', '0', 'no', 'off'].includes(normalized)) return false
	return true
}

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function isHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value)
}

function extensionForMime(mimeType: string): string {
	if (mimeType.includes('webp')) return 'webp'
	if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg'
	if (mimeType.includes('png')) return 'png'
	if (mimeType.includes('quicktime')) return 'mov'
	if (mimeType.includes('webm')) return 'webm'
	if (mimeType.includes('wav')) return 'wav'
	if (mimeType.includes('mp4')) return 'mp4'
	if (mimeType.includes('aac')) return 'aac'
	if (mimeType.includes('flac')) return 'flac'
	if (mimeType.includes('ogg')) return 'ogg'
	if (mimeType.includes('opus')) return 'opus'
	if (mimeType.includes('mpeg')) return 'mp3'
	return 'bin'
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
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

function videoExtFromUrl(url: string): string {
	const clean = url.split('?')[0].toLowerCase()
	if (clean.endsWith('.mov')) return 'mov'
	if (clean.endsWith('.webm')) return 'webm'
	return 'mp4'
}

function parseProviderError(resp: { status: number; text?: string; json?: unknown }): string {
	const body = asRecord(resp.json) || (() => {
		try { return asRecord(JSON.parse(resp.text || '')) } catch { return null }
	})()
	const error = asRecord(body?.error)
	const msg = stringParam(error?.message || body?.message || resp.text, `HTTP ${resp.status}`)
	const code = stringParam(error?.code || error?.type || body?.code, '')
	return `Token360 video: ${code ? code + ' - ' : ''}${msg}`
}

function extractTaskId(data: unknown): string {
	const body = asRecord(data)
	return stringParam(body?.id || body?.task_id || body?.video_id, '')
}

function extractStatus(data: unknown): string {
	const body = asRecord(data)
	return stringParam(body?.status || body?.state, '')
}

function extractFailure(data: unknown): string {
	const body = asRecord(data)
	const error = asRecord(body?.error)
	return stringParam(error?.message || body?.message || body?.failure_reason, 'Task failed')
}

function extractVideoUrl(data: unknown): string {
	const body = asRecord(data)
	if (!body) return ''
	const topLevel = stringParam(body.url || body.video_url, '')
	if (topLevel) return topLevel
	const content = asRecord(body.content)
	return stringParam(content?.video_url || content?.url, '')
}

function addCommonParams(body: JsonRecord, params: Record<string, unknown>): void {
	const duration = optionalString(params.duration ?? params.durationSeconds)
	if (duration && duration !== '-1') {
		const parsed = parseInt(duration, 10)
		if (Number.isFinite(parsed)) body.duration = parsed
	}

	const ratio = optionalString(params.ratio ?? params.aspect_ratio ?? params.aspectRatio)
	if (ratio) body.aspect_ratio = ratio

	const resolution = optionalString(params.resolution)
	if (resolution) body.resolution = resolution

	const generateAudio = optionalBoolean(params.generate_audio)
	if (generateAudio !== undefined) body.generate_audio = generateAudio
}

export class Token360VideoProvider implements VideoProvider {
	name = 'Token360'
	private apiKey: string
	private app: App
	private outputDir: string

	constructor(apiKey: string, app: App, outputDir: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
	}

	async generateVideo(prompt: string, params?: Record<string, unknown>): Promise<GenerateVideoResult> {
		const modelId = stringParam(params?.modelId, 'seedance-2.0')
		const genMode = stringParam(params?.genMode, 'text-to-video')
		const imageUrls = await Promise.all(stringList(params?.refImages).map(ref => this.ensureUrl(ref, 'image')))
		const audioUrls = await Promise.all(stringList(params?.refAudios).map(ref => this.ensureUrl(ref, 'audio')))
		const videoUrls = await Promise.all(stringList(params?.refVideos).map(ref => this.ensureUrl(ref, 'video')))

		if (imageUrls.length > 9) throw new Error('Token360 Seedance supports up to 9 reference images.')
		if (audioUrls.length > 3) throw new Error('Token360 Seedance supports up to 3 reference audio files.')
		if (videoUrls.length > 3) throw new Error('Token360 Seedance supports up to 3 reference videos.')

		const body: JsonRecord = { model: modelId, prompt }
		this.applyMedia(body, genMode, imageUrls, audioUrls, videoUrls)
		addCommonParams(body, params || {})

		const resp = await requestUrl({
			url: `${BASE_URL}/videos`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			throw: false,
			body: JSON.stringify(body),
		})

		if (resp.status >= 400) throw new Error(parseProviderError(resp))
		const taskId = extractTaskId(resp.json as unknown)
		if (!taskId) throw new Error('Token360 video: id was not returned')
		return { done: false, taskId }
	}

	async checkStatus(taskId: string): Promise<GenerateVideoResult> {
		const resp = await requestUrl({
			url: `${BASE_URL}/videos/${encodeURIComponent(taskId)}`,
			method: 'GET',
			headers: { 'Authorization': `Bearer ${this.apiKey}` },
			throw: false,
		})

		if (resp.status >= 400) throw new Error(parseProviderError(resp))

		const data = resp.json as unknown
		const normalized = extractStatus(data).toLowerCase()
		const videoUrl = extractVideoUrl(data)
		if (DONE_STATUSES.has(normalized) || videoUrl) {
			if (!videoUrl) throw new Error('Token360 video: completed task has no video URL')
			return { done: true, filePath: await this.downloadVideo(videoUrl) }
		}
		if (FAILED_STATUSES.has(normalized)) {
			throw new Error(`Token360 video: ${extractFailure(data)}`)
		}
		return { done: false, taskId }
	}

	private async ensureUrl(ref: string, kind: 'image' | 'audio' | 'video'): Promise<string> {
		if (isHttpUrl(ref)) return ref
		if (ref.startsWith('asset://')) return ref
		const decoded = dataUriToBytes(ref)
		if (!decoded) throw new Error(`Token360 video: unsupported reference ${kind} format`)
		return uploadRef(undefined, copyToArrayBuffer(decoded.bytes), `ref.${decoded.ext}`, decoded.mimeType)
	}

	private applyMedia(body: JsonRecord, genMode: string, imageUrls: string[], audioUrls: string[], videoUrls: string[]): void {
		if (genMode === 'first-frame') {
			if (!imageUrls[0]) throw new Error('Token360 Seedance first-frame mode requires one reference image.')
			body.frame_images = [{
				type: 'image_url',
				frame_type: 'first_frame',
				image_url: { url: imageUrls[0] },
			}]
			const refs = [
				...imageUrls.slice(1).map(url => this.imageReference(url)),
				...videoUrls.map(url => this.videoReference(url)),
				...audioUrls.map(url => this.audioReference(url)),
			]
			if (refs.length > 0) body.input_references = refs
			return
		}

		if (genMode !== 'text-to-video' && genMode !== 'image-ref' && genMode !== 'video-ref') {
			throw new Error(`Token360 Seedance does not support ${genMode} mode yet.`)
		}

		if (genMode === 'image-ref' && imageUrls.length === 0) {
			throw new Error('Token360 Seedance image-ref mode requires at least one reference image.')
		}
		if (genMode === 'video-ref' && imageUrls.length + audioUrls.length + videoUrls.length === 0) {
			throw new Error('Token360 Seedance video-ref mode requires at least one reference input.')
		}

		const refs = [
			...imageUrls.map(url => this.imageReference(url)),
			...videoUrls.map(url => this.videoReference(url)),
			...audioUrls.map(url => this.audioReference(url)),
		]
		if (refs.length > 0) body.input_references = refs
	}

	private imageReference(url: string): JsonRecord {
		return { type: 'image_url', role: 'reference', image_url: { url } }
	}

	private videoReference(url: string): JsonRecord {
		return { type: 'video_url', role: 'reference', video_url: { url } }
	}

	private audioReference(url: string): JsonRecord {
		return { type: 'audio_url', role: 'reference', audio_url: { url } }
	}

	private async downloadVideo(url: string): Promise<string> {
		const resp = await requestUrl({ url })
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) await adapter.mkdir(this.outputDir)
		const filePath = `${this.outputDir}/token360_video_${Date.now()}.${videoExtFromUrl(url)}`
		await adapter.writeBinary(filePath, resp.arrayBuffer)
		return filePath
	}
}

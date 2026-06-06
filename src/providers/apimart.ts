/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import type { ImageProvider, GenerateImageResult, GenerateVideoResult, VideoProvider } from './types'
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import { stringParam } from './params'
import { BUILTIN_BRAGI_RELAY } from './bragi-relay'
import { uploadRef } from './upload'

/**
 * APIMart provider.
 *
 * APIMart image models share the same async flow:
 *   1. POST /v1/images/generations → { data: [{ task_id, status }] }
 *   2. GET  /v1/tasks/{task_id}    → polls; on "completed" returns result.images[0].url[0]
 *   3. Download that URL and write to the vault.
 *
 * Omni-Flash-Ext video generation uses the same task endpoint, with
 * videos returned at result.videos[0].url[0].
 */
const DEFAULT_MODEL = 'gpt-image-2'
const DEFAULT_VIDEO_MODEL = 'Omni-Flash-Ext'

const API_BASE = 'https://api.apimart.ai/v1'
const POLL_INTERVAL_MS = 3000
const FIRST_POLL_DELAY_MS = 10000
const MAX_WAIT_MS = 300000
const VIDEO_DURATIONS = new Set([4, 6, 8, 10])
const BRAGI_RELAY_BASE = BUILTIN_BRAGI_RELAY.endpoint.replace(/\/+$/, '')
type RelayAssetKind = 'image' | 'video'

async function sleep(ms: number): Promise<void> {
	return new Promise(r => window.setTimeout(r, ms))
}

function stringifyDetail(value: unknown): string {
	if (typeof value === 'string') return value
	if (value == null) return ''
	try {
		return JSON.stringify(value)
	} catch {
		return 'unserializable error detail'
	}
}

function arrayParam(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
}

function parseApimartError(resp: { status: number; text?: string; json?: unknown }): string {
	const body = resp.json || (() => { try { return JSON.parse(resp.text || '') } catch { return null } })()
	const detail = body?.error?.message || body?.message || body?.error || resp.text || `HTTP ${resp.status}`
	const code = body?.error?.code || body?.code || body?.type || ''
	const msg = stringifyDetail(detail)
	return `${code ? code + ' — ' : ''}${msg}`
}

function firstUrl(value: unknown): string {
	if (typeof value === 'string') return value
	if (!Array.isArray(value)) return ''
	return value.find((item): item is string => typeof item === 'string' && item.length > 0) || ''
}

function videoExtension(url: string): string {
	const clean = url.split(/[?#]/)[0].toLowerCase()
	if (clean.endsWith('.mov')) return 'mov'
	if (clean.endsWith('.webm')) return 'webm'
	return 'mp4'
}

function isBragiRelayUrl(url: string): boolean {
	return url === BRAGI_RELAY_BASE || url.startsWith(`${BRAGI_RELAY_BASE}/`)
}

function extensionFromMime(mimeType: string, kind: RelayAssetKind): string {
	const mime = mimeType.split(';')[0].trim().toLowerCase()
	if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
	if (mime.includes('png')) return 'png'
	if (mime.includes('webp')) return 'webp'
	if (mime.includes('gif')) return 'gif'
	if (mime.includes('avif')) return 'avif'
	if (mime.includes('heic')) return 'heic'
	if (mime.includes('quicktime')) return 'mov'
	if (mime.includes('webm')) return 'webm'
	if (mime.includes('mp4')) return 'mp4'
	return kind === 'image' ? 'jpg' : 'mp4'
}

function extensionFromUrl(url: string, kind: RelayAssetKind): string {
	const clean = url.split(/[?#]/)[0].toLowerCase()
	const match = clean.match(/\.([a-z0-9]+)$/)
	if (match?.[1]) return match[1]
	return kind === 'image' ? 'jpg' : 'mp4'
}

function headerValue(headers: Record<string, string>, name: string): string {
	const target = name.toLowerCase()
	const key = Object.keys(headers).find(k => k.toLowerCase() === target)
	return key ? headers[key] : ''
}

function isGenericContentType(contentType: string): boolean {
	const mime = contentType.split(';')[0].trim().toLowerCase()
	return !mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream'
}

function fallbackMime(kind: RelayAssetKind, ext: string): string {
	if (kind === 'image') return ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
	if (ext === 'mov') return 'video/quicktime'
	return `video/${ext}`
}

export class APIMartProvider implements ImageProvider, VideoProvider {
	name = 'APIMart'
	private apiKey: string
	private app: App
	private outputDir: string

	constructor(apiKey: string, app: App, outputDir: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
	}

	async generateImage(prompt: string, params?: Record<string, unknown>): Promise<GenerateImageResult> {
		const modelId = stringParam(params?.modelId, DEFAULT_MODEL)
		const refImages = arrayParam(params?.refImages)

		const size = stringParam(params?.aspectRatio, '1:1')
		const tier = stringParam(params?.imageSize, '2K')
		const resolution = tier === 'auto' ? '2k' : tier.toLowerCase()

		const body: Record<string, unknown> = {
			model: modelId,
			prompt,
			size,
			resolution,
			n: 1,
		}
		// Quality is only honored by the official GPT Image 2 channel.
		if (modelId === 'gpt-image-2-official' && params?.quality) {
			body.quality = params.quality
		}
		if (refImages.length > 0) {
			body.image_urls = await Promise.all(refImages.slice(0, 16).map(ref => this.ensureRelayUrl(ref, 'image')))
		}

		// Submit
		const submitResp = await requestUrl({
			url: `${API_BASE}/images/generations`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(body),
		})
		const submitData = submitResp.json
		const first = submitData?.data?.[0]
		if (!first) {
			throw new Error(`APIMart: unexpected submit response — ${JSON.stringify(submitData).substring(0, 200)}`)
		}

		// Some accounts may return the image synchronously (unlikely but supported)
		if (first.b64_json) {
			return this.writeB64(first.b64_json)
		}
		if (first.url) {
			return this.downloadAndWrite(first.url)
		}
		if (!first.task_id) {
			throw new Error(`APIMart: no task_id/url/b64_json in submit response`)
		}

		// Poll
		const imageUrl = await this.poll(first.task_id)
		return this.downloadAndWrite(imageUrl)
	}

	async generateVideo(prompt: string, params?: Record<string, unknown>): Promise<GenerateVideoResult> {
		const modelId = stringParam(params?.modelId, DEFAULT_VIDEO_MODEL)
		const resolution = stringParam(params?.resolution, '720p').toLowerCase()
		const aspectRatio = stringParam(params?.aspect_ratio || params?.aspectRatio || params?.ratio, '16:9')
		const refImages = arrayParam(params?.refImages)
		const refVideos = arrayParam(params?.refVideos)

		if (refImages.length !== 0 && refImages.length !== 1 && refImages.length !== 3) {
			throw new Error('APIMart Omni-Flash-Ext supports 0, 1, or 3 reference images.')
		}
		if (refVideos.length > 1) {
			throw new Error('APIMart Omni-Flash-Ext supports at most 1 reference video.')
		}

		const body: Record<string, unknown> = {
			model: modelId,
			prompt,
			resolution,
			aspect_ratio: aspectRatio,
		}

		if (refVideos.length === 0) {
			const duration = Number.parseInt(stringParam(params?.duration || params?.durationSeconds, '6'), 10)
			if (!VIDEO_DURATIONS.has(duration)) {
				throw new Error('APIMart Omni-Flash-Ext duration must be one of 4, 6, 8, or 10 seconds.')
			}
			body.duration = duration
		}
		if (refImages.length > 0) {
			body.image_urls = await Promise.all(refImages.map(ref => this.ensureRelayUrl(ref, 'image')))
		}
		if (refVideos.length > 0) {
			body.video_urls = await Promise.all(refVideos.map(ref => this.ensureRelayUrl(ref, 'video')))
		}

		const resp = await requestUrl({
			url: `${API_BASE}/videos/generations`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(body),
			throw: false,
		})

		if (resp.status === 401 || resp.status === 403) throw new Error('APIMart: invalid API key')
		if (resp.status >= 400) throw new Error(`APIMart: ${parseApimartError(resp)}`)

		const submitData = resp.json
		const first = submitData?.data?.[0]
		const taskId = first?.task_id || first?.id
		if (!taskId) {
			throw new Error(`APIMart: no task_id in video submit response — ${JSON.stringify(submitData).substring(0, 200)}`)
		}
		return { done: false, taskId }
	}

	async checkStatus(taskId: string): Promise<GenerateVideoResult> {
		const resp = await requestUrl({
			url: `${API_BASE}/tasks/${encodeURIComponent(taskId)}`,
			method: 'GET',
			headers: { 'Authorization': `Bearer ${this.apiKey}` },
			throw: false,
		})

		if (resp.status === 401 || resp.status === 403) throw new Error('APIMart: invalid API key')
		if (resp.status >= 400) throw new Error(`APIMart: ${parseApimartError(resp)}`)

		const data = resp.json?.data
		if (!data) {
			throw new Error(`APIMart: malformed task response — ${JSON.stringify(resp.json).substring(0, 200)}`)
		}
		const status = data.status as string
		if (status === 'completed') {
			const videoUrl = firstUrl(data.result?.videos?.[0]?.url)
			if (!videoUrl) {
				throw new Error('APIMart: completed task has no video URL')
			}
			const filePath = await this.downloadVideo(videoUrl)
			return { done: true, filePath }
		}
		if (status === 'failed') {
			const detail = stringifyDetail(data.error) || stringifyDetail(data.message) || 'no reason provided'
			throw new Error(`APIMart: task failed — ${detail}`)
		}
		return { done: false, taskId }
	}

	private async poll(taskId: string): Promise<string> {
		await sleep(FIRST_POLL_DELAY_MS)
		const deadline = Date.now() + MAX_WAIT_MS - FIRST_POLL_DELAY_MS

		while (Date.now() < deadline) {
			const resp = await requestUrl({
				url: `${API_BASE}/tasks/${taskId}`,
				method: 'GET',
				headers: { 'Authorization': `Bearer ${this.apiKey}` },
			})
			const data = resp.json?.data
			if (!data) {
				throw new Error(`APIMart: malformed task response — ${JSON.stringify(resp.json).substring(0, 200)}`)
			}
			const status = data.status as string
			if (status === 'completed') {
				const urls: string[] = data.result?.images?.[0]?.url || []
				if (urls.length === 0) {
					throw new Error(`APIMart: completed task has no image URL`)
				}
				return urls[0]
			}
			if (status === 'failed') {
				const detail = stringifyDetail(data.error) || stringifyDetail(data.message) || 'no reason provided'
				throw new Error(`APIMart: task failed — ${detail}`)
			}
			// pending / in_progress / submitted — keep polling
			await sleep(POLL_INTERVAL_MS)
		}
		throw new Error(`APIMart: timed out after ${MAX_WAIT_MS / 1000}s`)
	}

	private async downloadAndWrite(url: string): Promise<GenerateImageResult> {
		const resp = await requestUrl({ url })
		const bytes = new Uint8Array(resp.arrayBuffer)
		return this.writeBytes(bytes)
	}

	private async writeB64(b64: string): Promise<GenerateImageResult> {
		const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
		return this.writeBytes(bytes)
	}

	private async writeBytes(bytes: Uint8Array): Promise<GenerateImageResult> {
		const timestamp = Date.now()
		const fileName = `img_${timestamp}.png`
		const filePath = `${this.outputDir}/${fileName}`
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) {
			await adapter.mkdir(this.outputDir)
		}
		await adapter.writeBinary(filePath, bytes.buffer)
		return { filePath }
	}

	private async downloadVideo(url: string): Promise<string> {
		const resp = await requestUrl({ url })
		const fileName = `apimart_video_${Date.now()}.${videoExtension(url)}`
		const filePath = `${this.outputDir}/${fileName}`
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) {
			await adapter.mkdir(this.outputDir)
		}
		await adapter.writeBinary(filePath, resp.arrayBuffer)
		return filePath
	}

	private async ensureRelayUrl(ref: string, kind: RelayAssetKind): Promise<string> {
		if (isBragiRelayUrl(ref)) return ref

		const dataUri = ref.match(/^data:([^;]+);base64,(.+)$/)
		if (dataUri) {
			const mime = dataUri[1]
			const bytes = Uint8Array.from(atob(dataUri[2]), c => c.charCodeAt(0))
			const ext = extensionFromMime(mime, kind)
			return uploadRef(undefined, bytes.buffer, `apimart-ref.${ext}`, mime)
		}

		if (/^https?:\/\//i.test(ref)) {
			const resp = await requestUrl({ url: ref, throw: false })
			if (resp.status >= 400) {
				throw new Error(`APIMart: failed to fetch reference ${kind} for relay upload — HTTP ${resp.status}`)
			}
			const contentType = headerValue(resp.headers, 'content-type')
			const useContentType = contentType && !isGenericContentType(contentType)
			const ext = useContentType ? extensionFromMime(contentType, kind) : extensionFromUrl(ref, kind)
			const mime = useContentType ? contentType : fallbackMime(kind, ext)
			return uploadRef(undefined, resp.arrayBuffer, `apimart-ref.${ext}`, mime)
		}

		throw new Error(`APIMart: unsupported reference ${kind} format; expected a data URI or http(s) URL.`)
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Resume strict linting after the runtime-shaped data boundary. */

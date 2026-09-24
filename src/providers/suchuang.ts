import { errorMessage } from '../task-errors'
import { writeTaskResult, pollRequest, TaskPollingError } from '../task-errors'
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import { stringParam } from './params'
import type { GenerateVideoResult, VideoProvider } from './types'
import { BUILTIN_BRAGI_RELAY } from './bragi-relay'
import { uploadRef } from './upload'

const API_BASE = 'https://api.wuyinkeji.com/api/async'
const CREATE_PATH = '/video_google_omni'
const DETAIL_PATH = '/detail'
const BRAGI_RELAY_BASE = BUILTIN_BRAGI_RELAY.endpoint.replace(/\/+$/, '')

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function recordParam(value: unknown): JsonRecord | null {
	if (typeof value === 'string') return asRecord(parseJsonText(value))
	return asRecord(value)
}

function arrayParam(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : []
}

function buildUrl(path: string, apiKey: string, params: Record<string, string> = {}): string {
	const url = new URL(`${API_BASE}${path}`)
	url.searchParams.set('key', apiKey)
	for (const [key, value] of Object.entries(params)) {
		url.searchParams.set(key, value)
	}
	return url.toString()
}

function stringifyDetail(value: unknown): string {
	if (typeof value === 'string') return value
	if (value == null) return ''
	try {
		return JSON.stringify(value)
	} catch {
		return 'unserializable detail'
	}
}

function parseJsonText(text: string | undefined): unknown {
	if (!text) return null
	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

function providerMessage(value: unknown): string {
	const body = asRecord(value)
	if (!body) return stringifyDetail(value)
	const msg = body.msg || body.message || body.error || body.debug
	return stringifyDetail(msg) || stringifyDetail(value)
}

function parseSuchuangError(resp: { status: number; text?: string; json?: unknown }): string {
	const body = resp.json || parseJsonText(resp.text)
	const record = asRecord(body)
	const code = record?.code
	const codeText = typeof code === 'string' || typeof code === 'number' || typeof code === 'boolean'
		? String(code)
		: stringifyDetail(code)
	const msg = providerMessage(body) || resp.text || `HTTP ${resp.status}`
	return `${codeText ? `${codeText} — ` : ''}${msg}`
}

function assertSuccessfulEnvelope(resp: { status: number; text?: string; json?: unknown }, label: string): void {
	if (resp.status === 401 || resp.status === 403) throw new Error(`${label}: invalid API key`)
	if (resp.status >= 400) throw new Error(`${label}: ${parseSuchuangError(resp)}`)
	const body = asRecord(resp.json)
	const code = body?.code
	if (typeof code === 'number' && code !== 200) {
		if (code === 401 || code === 403) throw new Error(`${label}: invalid API key`)
		throw new Error(`${label}: ${parseSuchuangError(resp)}`)
	}
	if (typeof code === 'string' && code.trim() && code !== '200') {
		if (code === '401' || code === '403') throw new Error(`${label}: invalid API key`)
		throw new Error(`${label}: ${parseSuchuangError(resp)}`)
	}
}

function extractTaskId(value: unknown): string {
	const body = asRecord(value)
	const data = recordParam(body?.data)
	const raw = data?.id || body?.id || body?.task_id || body?.taskId || (typeof body?.data === 'string' ? body.data : '')
	return stringParam(raw, '').trim()
}

type TaskState = 'pending' | 'succeeded' | 'failed' | 'unknown'

export function suchuangTaskState(value: unknown): TaskState {
	const body = asRecord(value)
	const data = recordParam(body?.data)
	const raw = data?.status || body?.status
	const status = stringParam(raw, '').trim().toLowerCase()
	if (status === '0' || status === '1' || status === 'init' || status === 'initializing' || status === 'pending' || status === 'running' || status === 'processing') return 'pending'
	if (status === '2' || status === 'success' || status === 'succeeded' || status === 'completed' || status === 'done') return 'succeeded'
	if (status === '3' || status === 'failed' || status === 'failure' || status === 'error' || status === 'cancelled' || status === 'canceled') return 'failed'
	return 'unknown'
}

function isHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value)
}

function findHttpUrl(value: unknown, seen = new WeakSet<object>()): string {
	if (typeof value === 'string') {
		const match = value.match(/https?:\/\/[^\s"'<>\\]+/i)
		return match?.[0] || ''
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findHttpUrl(item, seen)
			if (found) return found
		}
		return ''
	}
	if (!value || typeof value !== 'object') return ''
	if (seen.has(value)) return ''
	seen.add(value)
	const record = value as JsonRecord
	const priorityKeys = ['url', 'video_url', 'videoUrl', 'result_url', 'resultUrl', 'output', 'result', 'urls', 'videos', 'data']
	for (const key of priorityKeys) {
		const found = findHttpUrl(record[key], seen)
		if (found) return found
	}
	for (const nested of Object.values(record)) {
		const found = findHttpUrl(nested, seen)
		if (found) return found
	}
	return ''
}

export function extractSuchuangVideoUrl(value: unknown): string {
	const body = asRecord(value)
	const data = body?.data
	return findHttpUrl(data) || findHttpUrl(value)
}

function videoExtension(url: string): string {
	const clean = url.split(/[?#]/)[0].toLowerCase()
	if (clean.endsWith('.mov')) return 'mov'
	if (clean.endsWith('.webm')) return 'webm'
	return 'mp4'
}

function extensionFromMime(mimeType: string): string {
	const mime = mimeType.split(';')[0].trim().toLowerCase()
	if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
	if (mime.includes('png')) return 'png'
	if (mime.includes('webp')) return 'webp'
	if (mime.includes('gif')) return 'gif'
	if (mime.includes('avif')) return 'avif'
	if (mime.includes('heic')) return 'heic'
	return 'jpg'
}

function extensionFromUrl(url: string): string {
	const clean = url.split(/[?#]/)[0].toLowerCase()
	const match = clean.match(/\.([a-z0-9]+)$/)
	return match?.[1] || 'jpg'
}

function headerValue(headers: Record<string, string>, name: string): string {
	const target = name.toLowerCase()
	const key = Object.keys(headers).find(k => k.toLowerCase() === target)
	return key ? headers[key] : ''
}

function fallbackMime(ext: string): string {
	if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
	if (ext === 'svg') return 'image/svg+xml'
	return `image/${ext}`
}

function isGenericContentType(contentType: string): boolean {
	const mime = contentType.split(';')[0].trim().toLowerCase()
	return !mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream'
}

function isBragiRelayUrl(url: string): boolean {
	return url === BRAGI_RELAY_BASE || url.startsWith(`${BRAGI_RELAY_BASE}/`)
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength)
	copy.set(bytes)
	return copy.buffer
}

function suchuangSize(resolutionValue: unknown, aspectValue: unknown): string {
	const resolution = stringParam(resolutionValue, '720p').trim().toLowerCase()
	const aspect = stringParam(aspectValue, '16:9').trim()
	if (resolution === '4k') {
		throw new Error('SuChuang Gemini Omni supports 720p and 1080p only. Use APIMart for Omni-Flash-Ext 4K output.')
	}
	const portrait = aspect === '9:16'
	if (resolution === '1080p') return portrait ? '1080x1920' : '1920x1080'
	return portrait ? '720x1280' : '1280x720'
}

export class SuchuangVideoProvider implements VideoProvider {
	name = 'SuChuang'

	constructor(
		private apiKey: string,
		private app: App,
		private outputDir: string,
	) {}

	async generateVideo(prompt: string, params?: Record<string, unknown>): Promise<GenerateVideoResult> {
		const refImages = arrayParam(params?.refImages).slice(0, 7)
		const refVideos = arrayParam(params?.refVideos)
		if (refVideos.length > 0) {
			throw new Error('SuChuang Gemini Omni does not support reference video inputs.')
		}

		const body: JsonRecord = {
			prompt,
			size: suchuangSize(params?.resolution, params?.aspect_ratio || params?.aspectRatio || params?.ratio),
			duration: stringParam(params?.duration || params?.durationSeconds, '10'),
		}

		if (refImages.length > 0) {
			const urls = await Promise.all(refImages.map(ref => this.ensureRelayImageUrl(ref)))
			body.images = urls.join(',')
		}

		const resp = await requestUrl({
			url: buildUrl(CREATE_PATH, this.apiKey),
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': this.apiKey,
			},
			body: JSON.stringify(body),
			throw: false,
		})
		assertSuccessfulEnvelope(resp, 'SuChuang Gemini Omni')

		const taskId = extractTaskId(resp.json)
		if (!taskId) {
			throw new Error(`SuChuang Gemini Omni: no task id in response — ${JSON.stringify(resp.json).substring(0, 240)}`)
		}
		return { done: false, taskId }
	}

	async checkStatus(taskId: string): Promise<GenerateVideoResult> {
		const resp = await pollRequest({
			url: buildUrl(DETAIL_PATH, this.apiKey, { id: taskId }),
			method: 'GET',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': this.apiKey,
			},
			throw: false,
		})
		assertSuccessfulEnvelope(resp, 'SuChuang Gemini Omni')

		const state = suchuangTaskState(resp.json)
		if (state === 'pending') return { done: false, taskId }
		if (state === 'failed') {
			const data = recordParam(asRecord(resp.json)?.data)
			const detail = stringifyDetail(data?.message) || providerMessage(resp.json) || 'no reason provided'
			throw new TaskPollingError(`SuChuang Gemini Omni: task failed — ${detail}`, 'terminal')
		}

		const videoUrl = extractSuchuangVideoUrl(resp.json)
		if (state !== 'succeeded' && !videoUrl) throw new Error('SuChuang: unknown task status')
		if (!videoUrl) {
			throw new Error(`SuChuang Gemini Omni: completed task has no video URL — ${JSON.stringify(resp.json).substring(0, 240)}`)
		}
		const filePath = await this.downloadVideo(videoUrl)
		return { done: true, filePath }
	}

	private async downloadVideo(url: string): Promise<string> {
		const resp = await pollRequest({ url })
		const fileName = `suchuang_google_omni_${Date.now()}.${videoExtension(url)}`
		const filePath = `${this.outputDir}/${fileName}`
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) {
			await adapter.mkdir(this.outputDir)
		}
		await writeTaskResult(adapter, filePath, resp.arrayBuffer)
		return filePath
	}

	private async ensureRelayImageUrl(ref: string): Promise<string> {
		if (isBragiRelayUrl(ref)) return ref

		const dataUri = ref.match(/^data:([^;]+);base64,(.+)$/)
		if (dataUri) {
			const mime = dataUri[1]
			const bytes = Uint8Array.from(atob(dataUri[2]), c => c.charCodeAt(0))
			const ext = extensionFromMime(mime)
			return uploadRef(undefined, copyToArrayBuffer(bytes), `suchuang-ref.${ext}`, mime)
		}

		if (isHttpUrl(ref)) {
			const resp = await requestUrl({ url: ref, throw: false })
			if (resp.status >= 400) {
				throw new Error(`SuChuang Gemini Omni: failed to fetch reference image for relay upload — HTTP ${resp.status}`)
			}
			const contentType = headerValue(resp.headers, 'content-type')
			const useContentType = contentType && !isGenericContentType(contentType)
			const ext = useContentType ? extensionFromMime(contentType) : extensionFromUrl(ref)
			const mime = useContentType ? contentType : fallbackMime(ext)
			return uploadRef(undefined, resp.arrayBuffer, `suchuang-ref.${ext}`, mime)
		}

		throw new Error('SuChuang Gemini Omni: unsupported reference image format; expected a data URI or http(s) URL.')
	}
}

export async function testSuchuangConnection(apiKey: string): Promise<{ ok: boolean; message: string }> {
	if (!apiKey) return { ok: false, message: 'API key is empty.' }
	try {
		const resp = await requestUrl({
			url: buildUrl(DETAIL_PATH, apiKey, { id: 'bragi_connection_test' }),
			method: 'GET',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': apiKey,
			},
			throw: false,
		})
		if (resp.status === 401 || resp.status === 403) return { ok: false, message: 'Invalid API key.' }
		const body = asRecord(resp.json)
		if (body?.code === 401 || body?.code === 403 || body?.code === '401' || body?.code === '403') {
			return { ok: false, message: 'Invalid API key.' }
		}
		if (resp.status >= 400) return { ok: false, message: `Unexpected status ${resp.status}.` }
		return { ok: true, message: 'Connected.' }
	} catch (err: unknown) {
		const message = err instanceof Error ? errorMessage(err) : String(err)
		return { ok: false, message: `Network error: ${message}` }
	}
}

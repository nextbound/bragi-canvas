/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import type { GenerateImageResult, GenerateVideoResult, ImageProvider, VideoProvider } from './types'
import type { TextGenProvider, TextGenResult } from './text-gen'
import { uploadRef } from './upload'

const DEFAULT_BASE_URL = 'https://api.tokenrouter.com/v1'
const IMAGE_GENERATION_MODELS = new Set([
	'openai/gpt-5.4-image-2',
])

const DONE_STATUSES = new Set(['SUCCESS', 'SUCCEEDED', 'COMPLETED'])
const FAILED_STATUSES = new Set(['FAILURE', 'FAILED', 'ERROR', 'CANCELLED', 'CANCELED'])

const SYSTEM_PROMPT = `You are a helpful assistant on a visual canvas. Follow the user's instructions precisely.
If the user asks you to produce multiple separate items (e.g. "split into 3 chapters", "give me 5 titles", "break this into sections"), output each item separated by a line containing only ---SPLIT--- on its own. Do NOT use ---SPLIT--- for any other purpose. If the output is a single piece of content, do not use ---SPLIT--- at all.`

type JsonRecord = Record<string, unknown>

function asRecord(value: unknown): JsonRecord | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : []
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

function parseProviderError(provider: string, resp: { status: number; text?: string; json?: unknown }): string {
	const body = asRecord(resp.json) || (() => {
		try { return asRecord(JSON.parse(resp.text || '')) } catch { return null }
	})()
	const error = asRecord(body?.error)
	const msg = stringParam(error?.message || body?.message || resp.text, `HTTP ${resp.status}`)
	const code = stringParam(error?.code || error?.type || body?.code, '')
	return `${provider}: ${code ? code + ' — ' : ''}${msg}`
}

function isHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value)
}

function extensionForMime(mimeType: string): string {
	if (mimeType === 'application/pdf') return 'pdf'
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
	const mime = match[1]
	return {
		bytes: Uint8Array.from(atob(match[2]), c => c.charCodeAt(0)),
		ext: extensionForMime(mime),
		mimeType: mime,
	}
}

function imageExtFromUrl(url: string): string {
	const clean = url.split('?')[0].toLowerCase()
	if (clean.endsWith('.webp')) return 'webp'
	if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'jpg'
	return 'png'
}

function videoExtFromUrl(url: string): string {
	const clean = url.split('?')[0].toLowerCase()
	if (clean.endsWith('.mov')) return 'mov'
	if (clean.endsWith('.webm')) return 'webm'
	return 'mp4'
}

function pushUnique(target: string[], value: string): void {
	const text = value.trim()
	if (text && !target.includes(text)) target.push(text)
}

function extractImageSources(data: unknown): string[] {
	const result: string[] = []
	const visit = (value: unknown, depth = 0): void => {
		if (depth > 8 || value == null) return

		if (typeof value === 'string') {
			const markdownRe = /!\[[^\]]*\]\(([^)]+)\)/g
			let match: RegExpExecArray | null
			while ((match = markdownRe.exec(value))) pushUnique(result, match[1])
			if (/^data:image\//i.test(value) || isHttpUrl(value)) pushUnique(result, value)
			return
		}

		if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1)
			return
		}

		const record = asRecord(value)
		if (!record) return

		const b64 = stringParam(record.b64_json, '')
		if (b64) {
			const mime = stringParam(record.mime_type || record.mimeType || record.format, 'image/png')
			const normalizedMime = mime.startsWith('image/') ? mime : `image/${mime}`
			pushUnique(result, `data:${normalizedMime};base64,${b64}`)
		}

		const imageUrl = record.image_url
		if (typeof imageUrl === 'string') pushUnique(result, imageUrl)
		else visit(imageUrl, depth + 1)

		for (const key of ['url', 'image', 'image_large_url', 'result_url']) {
			const valueAtKey = record[key]
			if (typeof valueAtKey === 'string') pushUnique(result, valueAtKey)
		}

		for (const key of ['data', 'images', 'output', 'choices', 'message', 'content']) {
			visit(record[key], depth + 1)
		}
	}

	visit(data)
	return result.filter(source => /^data:image\//i.test(source) || isHttpUrl(source))
}

function extractText(data: unknown): string {
	const record = asRecord(data)
	const choices = asArray(record?.choices)
	const message = asRecord(asRecord(choices[0])?.message)
	const content = message?.content
	if (typeof content === 'string') return content.trim()
	if (Array.isArray(content)) {
		return content
			.map(part => asRecord(part))
			.filter(Boolean)
			.filter(part => part?.type === 'text')
			.map(part => stringParam(part?.text, ''))
			.join('\n')
			.trim()
	}
	return ''
}

function extractTaskId(data: unknown): string {
	const body = asRecord(data)
	const nested = asRecord(body?.data)
	return stringParam(body?.task_id || body?.id || nested?.task_id || nested?.id, '').trim()
}

function unwrapData(data: unknown): JsonRecord {
	const body = asRecord(data) || {}
	return asRecord(body.data) || body
}

function extractStatus(data: unknown): string {
	const body = unwrapData(data)
	return stringParam(body.status, '').trim()
}

function extractVideoUrl(data: unknown): string {
	const body = unwrapData(data)
	const nested = asRecord(body.data) || {}
	const metadata = asRecord(body.metadata)
	const content = asRecord(body.content)
	const nestedContent = asRecord(nested.content)
	for (const value of [
		body.result_url,
		body.video_url,
		body.url,
		metadata?.url,
		metadata?.result_url,
		content?.video_url,
		nested.result_url,
		nested.video_url,
		nested.url,
		nestedContent?.video_url,
	]) {
		const url = stringParam(value, '').trim()
		if (url) return url
	}
	return ''
}

function extractFailure(data: unknown, fallback: string): string {
	const body = unwrapData(data)
	const nested = asRecord(body.data) || {}
	const error = asRecord(body.error)
	const nestedError = asRecord(nested.error)
	for (const value of [
		body.fail_reason,
		body.reason,
		error?.message,
		nested.fail_reason,
		nested.reason,
		nestedError?.message,
	]) {
		const msg = stringParam(value, '').trim()
		if (msg) return msg
	}
	return fallback
}

function isSeedanceModel(modelId: string): boolean {
	return modelId.includes('seedance')
}

function imageSizeFromAspectRatio(aspectRatio: string): string {
	const parts = aspectRatio.split(':').map(Number)
	if (parts.length !== 2 || !parts[0] || !parts[1]) return '1024x1024'
	const ratio = parts[0] / parts[1]
	if (ratio > 1.15) return '1536x1024'
	if (ratio < 0.87) return '1024x1536'
	return '1024x1024'
}

function appendMultipartField(parts: Uint8Array[], boundary: string, name: string, value: string): void {
	const enc = new TextEncoder()
	parts.push(enc.encode(`--${boundary}\r\n`))
	parts.push(enc.encode(`Content-Disposition: form-data; name="${name}"\r\n\r\n`))
	parts.push(enc.encode(value))
	parts.push(enc.encode('\r\n'))
}

function appendMultipartFile(parts: Uint8Array[], boundary: string, name: string, filename: string, mime: string, bytes: Uint8Array): void {
	const enc = new TextEncoder()
	parts.push(enc.encode(`--${boundary}\r\n`))
	parts.push(enc.encode(`Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`))
	parts.push(enc.encode(`Content-Type: ${mime}\r\n\r\n`))
	parts.push(bytes)
	parts.push(enc.encode('\r\n'))
}

function concatBytes(parts: Uint8Array[]): ArrayBuffer {
	let total = 0
	for (const part of parts) total += part.length
	const body = new Uint8Array(total)
	let offset = 0
	for (const part of parts) {
		body.set(part, offset)
		offset += part.length
	}
	return body.buffer
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength)
	copy.set(bytes)
	return copy.buffer
}

export class TokenRouterTextProvider implements TextGenProvider {
	name = 'TokenRouter'
	private apiKey: string
	private baseUrl: string

	constructor(apiKey: string, baseUrl = DEFAULT_BASE_URL) {
		this.apiKey = apiKey
		this.baseUrl = baseUrl.replace(/\/$/, '')
	}

	async generateText(prompt: string, params?: Record<string, unknown>): Promise<TextGenResult> {
		const modelId = stringParam(params?.modelId, 'openai/gpt-5.5')
		const refImages: string[] = Array.isArray(params?.refImages) ? params.refImages : []
		const refVideos: string[] = Array.isArray(params?.refVideos) ? params.refVideos : []
		const refAudios: string[] = Array.isArray(params?.refAudios) ? params.refAudios : []
		const refPdfs: string[] = Array.isArray(params?.refPdfs) ? params.refPdfs : []
		const content: unknown[] = []

		for (const ref of refImages) {
			content.push({ type: 'image_url', image_url: { url: ref } })
		}
		for (let i = 0; i < refVideos.length; i++) {
			content.push(this.fileContentPart(refVideos[i], `video-${i + 1}`))
		}
		for (let i = 0; i < refAudios.length; i++) {
			content.push(this.fileContentPart(refAudios[i], `audio-${i + 1}`))
		}
		for (let i = 0; i < refPdfs.length; i++) {
			content.push(this.fileContentPart(refPdfs[i], `document-${i + 1}`))
		}
		content.push({ type: 'text', text: prompt })

		const resp = await requestUrl({
			url: `${this.baseUrl}/chat/completions`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			throw: false,
			body: JSON.stringify({
				model: modelId,
				messages: [
					{ role: 'system', content: SYSTEM_PROMPT },
					{ role: 'user', content },
				],
				max_tokens: 4096,
			}),
		})

		if (resp.status >= 400) throw new Error(parseProviderError('TokenRouter', resp))
		const text = extractText(resp.json)
		if (!text) throw new Error('TokenRouter: No text in response')
		return { text }
	}

	private fileContentPart(ref: string, basename: string): unknown {
		const decoded = dataUriToBytes(ref)
		if (!decoded) {
			return {
				type: 'file',
				file: { file_id: ref, filename: basename },
			}
		}
		return {
			type: 'file',
			file: {
				filename: `${basename}.${decoded.ext}`,
				file_data: ref,
			},
		}
	}
}

export class TokenRouterImageProvider implements ImageProvider {
	name = 'TokenRouter'
	private apiKey: string
	private app: App
	private outputDir: string
	private baseUrl: string

	constructor(apiKey: string, app: App, outputDir: string, baseUrl = DEFAULT_BASE_URL) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
		this.baseUrl = baseUrl.replace(/\/$/, '')
	}

	async generateImage(prompt: string, params?: Record<string, unknown>): Promise<GenerateImageResult> {
		const modelId = stringParam(params?.modelId, 'openai/gpt-5.4-image-2')
		const refImages: string[] = Array.isArray(params?.refImages) ? params.refImages : []
		const sources = IMAGE_GENERATION_MODELS.has(modelId)
			? await this.generateViaImagesApi(modelId, prompt, params || {}, refImages)
			: await this.generateViaChat(modelId, prompt, refImages)

		const source = sources[0]
		if (!source) throw new Error('TokenRouter image: No image in response')
		return this.saveImage(source)
	}

	private async generateViaImagesApi(modelId: string, prompt: string, params: Record<string, unknown>, refImages: string[]): Promise<string[]> {
		if (refImages.length > 0) return this.editWithRefs(modelId, prompt, params, refImages)

		const imageSize = stringParam(params.imageSize, 'auto')
		const size = imageSize === 'auto' ? 'auto' : imageSizeFromAspectRatio(stringParam(params.aspectRatio, '1:1'))
		const quality = stringParam(params.quality, 'auto')

		const resp = await requestUrl({
			url: `${this.baseUrl}/images/generations`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			throw: false,
			body: JSON.stringify({ model: modelId, prompt, size, quality, n: 1 }),
		})

		if (resp.status >= 400) throw new Error(parseProviderError('TokenRouter image', resp))
		return extractImageSources(resp.json)
	}

	private async editWithRefs(modelId: string, prompt: string, params: Record<string, unknown>, refImages: string[]): Promise<string[]> {
		const boundary = '----BragiTokenRouterFormBoundary' + Math.random().toString(36).slice(2)
		const parts: Uint8Array[] = []
		appendMultipartField(parts, boundary, 'model', modelId)
		appendMultipartField(parts, boundary, 'prompt', prompt)
		appendMultipartField(parts, boundary, 'size', imageSizeFromAspectRatio(stringParam(params.aspectRatio, '1:1')))
		appendMultipartField(parts, boundary, 'quality', stringParam(params.quality, 'auto'))
		appendMultipartField(parts, boundary, 'n', '1')

		for (let i = 0; i < refImages.length; i++) {
			const match = refImages[i].match(/^data:([^;]+);base64,(.+)$/)
			if (!match) continue
			const mime = match[1]
			const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0))
			const ext = mime.includes('webp') ? 'webp' : mime.includes('png') ? 'png' : 'jpg'
			appendMultipartFile(parts, boundary, 'image[]', `ref${i}.${ext}`, mime, bytes)
		}
		parts.push(new TextEncoder().encode(`--${boundary}--\r\n`))

		const resp = await requestUrl({
			url: `${this.baseUrl}/images/edits`,
			method: 'POST',
			headers: {
				'Content-Type': `multipart/form-data; boundary=${boundary}`,
				'Authorization': `Bearer ${this.apiKey}`,
			},
			throw: false,
			body: concatBytes(parts),
		})

		if (resp.status >= 400) throw new Error(parseProviderError('TokenRouter image edit', resp))
		return extractImageSources(resp.json)
	}

	private async generateViaChat(modelId: string, prompt: string, refImages: string[]): Promise<string[]> {
		const content: unknown[] = []
		for (const ref of refImages) {
			content.push({ type: 'image_url', image_url: { url: ref } })
		}
		content.push({ type: 'text', text: prompt })

		const resp = await requestUrl({
			url: `${this.baseUrl}/chat/completions`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			throw: false,
			body: JSON.stringify({
				model: modelId,
				messages: [{ role: 'user', content }],
			}),
		})

		if (resp.status >= 400) throw new Error(parseProviderError('TokenRouter image chat', resp))
		return extractImageSources(resp.json)
	}

	private async saveImage(source: string): Promise<GenerateImageResult> {
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) await adapter.mkdir(this.outputDir)

		if (/^data:image\//i.test(source)) {
			const decoded = dataUriToBytes(source)
			if (!decoded) throw new Error('TokenRouter image: Invalid data URI')
			const filePath = `${this.outputDir}/tokenrouter_${Date.now()}.${decoded.ext}`
			await adapter.writeBinary(filePath, copyToArrayBuffer(decoded.bytes))
			return { filePath }
		}

		if (!isHttpUrl(source)) throw new Error('TokenRouter image: Unsupported image source')
		const imageResp = await requestUrl({ url: source })
		const filePath = `${this.outputDir}/tokenrouter_${Date.now()}.${imageExtFromUrl(source)}`
		await adapter.writeBinary(filePath, imageResp.arrayBuffer)
		return { filePath }
	}
}

export class TokenRouterVideoProvider implements VideoProvider {
	name = 'TokenRouter'
	private apiKey: string
	private app: App
	private outputDir: string
	private baseUrl: string

	constructor(apiKey: string, app: App, outputDir: string, baseUrl = DEFAULT_BASE_URL) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
		this.baseUrl = baseUrl.replace(/\/$/, '')
	}

	async generateVideo(prompt: string, params?: Record<string, unknown>): Promise<GenerateVideoResult> {
		const modelId = stringParam(params?.modelId, 'dreamina-seedance-2-0-260128')
		const genMode = stringParam(params?.genMode, 'text-to-video')
		const isHappyHorse = modelId.startsWith('happyhorse-1.0-')
		const isSeedance = isSeedanceModel(modelId)
		const refImages: string[] = Array.isArray(params?.refImages) ? params.refImages : []
		const refVideos: string[] = Array.isArray(params?.refVideos) ? params.refVideos : []
		const refAudios: string[] = Array.isArray(params?.refAudios) ? params.refAudios : []
		const imageUrls = await Promise.all(refImages.map(ref => this.ensureImageUrl(ref)))
		const attachments: unknown[] = []

		for (const ref of imageUrls) attachments.push({ type: 'image', source: ref, data_url: ref })
		for (const ref of refVideos) attachments.push({ type: 'video', source: ref, data_url: ref })
		for (const ref of refAudios) attachments.push({ type: 'audio', source: ref, data_url: ref })

		const body: JsonRecord = {
			model: modelId,
			prompt,
		}
		if (!isSeedance) {
			body.metadata = {
				source: 'bragi-canvas',
				input_mode: genMode,
				attachment_count: attachments.length,
			}
		}

		if (isHappyHorse) {
			this.applyHappyHorseMedia(body, modelId, genMode, imageUrls)
		} else if (isSeedance) {
			this.applySeedanceMedia(body, imageUrls, refAudios, refVideos)
		} else if (imageUrls.length > 0) {
			body.image = imageUrls[0]
			body.images = imageUrls
			if (genMode === 'first-frame') body.first_frame_image = imageUrls[0]
			else if (genMode === 'image-ref') body.image_urls = imageUrls
		}
		if (!isHappyHorse && !isSeedance && attachments.length > 0) body.attachments = attachments
		this.applyVideoParams(body, params || {}, isSeedance)

		const resp = await requestUrl({
			url: `${this.baseUrl}/video/generations`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			throw: false,
			body: JSON.stringify(body),
		})

		if (resp.status >= 400) throw new Error(parseProviderError('TokenRouter video', resp))
		const taskId = extractTaskId(resp.json)
		if (!taskId) throw new Error('TokenRouter video: task_id was not returned')
		return { done: false, taskId }
	}

	private async ensureImageUrl(ref: string): Promise<string> {
		if (isHttpUrl(ref) || ref.startsWith('asset://')) return ref
		const decoded = dataUriToBytes(ref)
		if (!decoded) throw new Error('TokenRouter video: unsupported reference image format')
		return uploadRef(undefined, copyToArrayBuffer(decoded.bytes), `ref.${decoded.ext}`, `image/${decoded.ext === 'jpg' ? 'jpeg' : decoded.ext}`)
	}

	private applyHappyHorseMedia(body: JsonRecord, modelId: string, genMode: string, imageUrls: string[]): void {
		if (modelId === 'happyhorse-1.0-i2v' || genMode === 'first-frame') {
			if (!imageUrls[0]) throw new Error('TokenRouter HappyHorse I2V requires one reference image.')
			body.first_frame_image = imageUrls[0]
			return
		}
		if (genMode === 'image-ref' && imageUrls.length > 0) {
			body.image_urls = imageUrls.slice(0, 9)
		}
	}

	private applySeedanceMedia(body: JsonRecord, imageUrls: string[], audioUrls: string[], videoUrls: string[]): void {
		if (imageUrls.length > 9) throw new Error('TokenRouter Seedance supports up to 9 reference images.')
		if (audioUrls.length > 3) throw new Error('TokenRouter Seedance supports up to 3 reference audio files.')
		if (videoUrls.length > 3) throw new Error('TokenRouter Seedance supports up to 3 reference videos.')

		if (imageUrls.length > 0) body.images = imageUrls
		if (audioUrls.length > 0) body.audios = audioUrls
		if (videoUrls.length > 0) body.videos = videoUrls
	}

	async checkStatus(taskId: string): Promise<GenerateVideoResult> {
		const resp = await requestUrl({
			url: `${this.baseUrl}/video/generations/${encodeURIComponent(taskId)}`,
			method: 'GET',
			headers: { 'Authorization': `Bearer ${this.apiKey}` },
			throw: false,
		})

		if (resp.status >= 400) throw new Error(parseProviderError('TokenRouter video', resp))

		const status = extractStatus(resp.json)
		const normalized = status.toUpperCase()
		const videoUrl = extractVideoUrl(resp.json)
		if (DONE_STATUSES.has(normalized) || videoUrl) {
			if (!videoUrl) throw new Error('TokenRouter video: completed task has no video URL')
			return { done: true, filePath: await this.downloadVideo(videoUrl) }
		}
		if (FAILED_STATUSES.has(normalized)) {
			throw new Error(`TokenRouter video: ${extractFailure(resp.json, 'Task failed')}`)
		}
		return { done: false, taskId }
	}

	private applyVideoParams(body: JsonRecord, params: Record<string, unknown>, seedanceMetadata = false): void {
		const metadata = seedanceMetadata ? this.ensureMetadata(body) : body
		const duration = optionalString(params.duration || params.durationSeconds)
		if (duration) metadata.duration = duration === '-1' ? -1 : parseInt(duration, 10)

		const ratio = optionalString(params.ratio || params.aspect_ratio || params.aspectRatio)
		if (ratio) {
			if (seedanceMetadata) metadata.ratio = ratio
			else body.aspect_ratio = ratio
		}

		const resolution = optionalString(params.resolution)
		if (resolution) metadata.resolution = resolution

		const qualityMode = optionalString(params.mode)
		if (qualityMode) body.mode = qualityMode

		if (params.generate_audio !== undefined) metadata.generate_audio = params.generate_audio !== 'false'
	}

	private ensureMetadata(body: JsonRecord): JsonRecord {
		const metadata = asRecord(body.metadata) || {}
		body.metadata = metadata
		return metadata
	}

	private async downloadVideo(url: string): Promise<string> {
		const resp = await requestUrl({ url })
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) await adapter.mkdir(this.outputDir)
		const filePath = `${this.outputDir}/tokenrouter_video_${Date.now()}.${videoExtFromUrl(url)}`
		await adapter.writeBinary(filePath, resp.arrayBuffer)
		return filePath
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment -- Resume strict linting after the runtime-shaped data boundary. */

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- RunPod queue responses are runtime-shaped API payloads. */
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import type { GenerateImageResult, ImageProvider } from './types'
import { stringParam } from './params'
import {
	booleanParam,
	colorMatchImage,
	dimensionsFromParams,
	mimeForOutputFormat,
	positiveIntParam,
	prepareReferenceImage,
	randomSeed,
} from './bfl'

const RUNPOD_FLUX_KLEIN_BASE_URL = 'https://api.runpod.ai/v2/27z4r9lu1eoimt'
const DEFAULT_TARGET_LONG_EDGE = 2048
const DEFAULT_STEPS = 12
const DEFAULT_GUIDANCE_SCALE = 1.0
const DEFAULT_OUTPUT_FORMAT = 'png'
const POLL_ATTEMPTS = 240
const POLL_INTERVAL_MS = 1000

interface RunPodResponse {
	id?: string
	status?: string
	output?: unknown
	error?: unknown
	message?: string
	detail?: string
}

interface ExtractedImage {
	bytes?: ArrayBuffer
	url?: string
	mime: string
	extension: string
}

export class RunPodFluxImageProvider implements ImageProvider {
	name = 'RunPod'
	private apiKey: string
	private app: App
	private outputDir: string
	private baseUrl: string

	constructor(apiKey: string, app: App, outputDir: string, baseUrl = RUNPOD_FLUX_KLEIN_BASE_URL) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
		this.baseUrl = baseUrl.replace(/\/+$/, '')
	}

	async generateImage(prompt: string, params?: Record<string, unknown>): Promise<GenerateImageResult> {
		const modelId = stringParam(params?.modelId, 'flux-2-klein-9b')
		const refImages = Array.isArray(params?.refImages)
			? params.refImages.filter((ref): ref is string => typeof ref === 'string')
			: []
		const targetLongEdge = positiveIntParam(params?.targetLongEdge, DEFAULT_TARGET_LONG_EDGE)
		const outputFormat = DEFAULT_OUTPUT_FORMAT
		const seed = randomSeed()
		const steps = positiveIntParam(params?.steps || params?.step, DEFAULT_STEPS)
		const guidanceScale = numberParam(params?.guidanceScale || params?.guidance_scale, DEFAULT_GUIDANCE_SCALE)
		const enableColorMatch = booleanParam(params?.enableColorMatch, false)
		const colorMatchRefImage = stringParam(
			params?.colorMatchRefImage || params?.colorMatchReferenceImage || params?.colorMatchReference || params?.colorMatchImage,
			'',
		)

		const input: Record<string, unknown> = {
			prompt,
			images: [],
			seed,
			steps,
			guidance_scale: guidanceScale,
			num_outputs: 1,
			output_format: outputFormat,
		}

		let inputReferenceForColorMatch: string | null = null
		if (refImages.length > 0) {
			const prepared = await prepareReferenceImage(refImages[0], targetLongEdge)
			input.images = [prepared.dataUri]
			input.width = prepared.width
			input.height = prepared.height
			inputReferenceForColorMatch = prepared.dataUri
		} else {
			const dimensions = dimensionsFromParams(params, targetLongEdge)
			input.width = dimensions.width
			input.height = dimensions.height
		}

		const referenceForColorMatch = enableColorMatch && colorMatchRefImage
			? (await prepareReferenceImage(colorMatchRefImage, targetLongEdge)).dataUri
			: inputReferenceForColorMatch

		const result = await this.run(input)
		let extracted = extractImageOutput(result.output) || extractImageOutput(result)
		if (!extracted) {
			throw new Error(`RunPod: completed task has no image output - ${JSON.stringify(result).substring(0, 240)}`)
		}

		let outputBytes = extracted.bytes || (extracted.url ? await this.downloadImage(extracted.url) : null)
		if (!outputBytes) throw new Error('RunPod: image output could not be decoded')
		let extension = extracted.extension || outputFormat

		if (enableColorMatch && referenceForColorMatch) {
			outputBytes = await colorMatchImage(referenceForColorMatch, outputBytes, extracted.mime || mimeForOutputFormat(extension))
			extension = 'png'
		}

		const fileName = `runpod_${safeId(modelId)}_${Date.now()}.${extension}`
		const filePath = `${this.outputDir}/${fileName}`
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) {
			await adapter.mkdir(this.outputDir)
		}
		await adapter.writeBinary(filePath, outputBytes)
		return { filePath }
	}

	private async run(input: Record<string, unknown>): Promise<RunPodResponse> {
		const response = await requestUrl({
			url: `${this.baseUrl}/run`,
			method: 'POST',
			headers: {
				'accept': 'application/json',
				'content-type': 'application/json',
				'authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({ input }),
			throw: false,
		})
		const data = response.json as RunPodResponse
		if (response.status >= 400 || !data) {
			throw new Error(`RunPod: ${providerErrorMessage(response.status, data)}`)
		}
		if (isCompleted(data)) return assertNoWorkerError(data)
		if (!data.id) {
			throw new Error(`RunPod: run response has no job id - ${JSON.stringify(data).substring(0, 240)}`)
		}
		return this.poll(data.id)
	}

	private async poll(jobId: string): Promise<RunPodResponse> {
		for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
			await sleep(POLL_INTERVAL_MS)
			const response = await requestUrl({
				url: `${this.baseUrl}/status/${encodeURIComponent(jobId)}`,
				method: 'GET',
				headers: {
					'accept': 'application/json',
					'authorization': `Bearer ${this.apiKey}`,
				},
				throw: false,
			})
			const data = response.json as RunPodResponse
			if (response.status >= 400) {
				throw new Error(`RunPod status: ${providerErrorMessage(response.status, data)}`)
			}
			if (isCompleted(data)) return assertNoWorkerError(data)
			if (isFailed(data)) {
				throw new Error(`RunPod task failed: ${providerErrorMessage(response.status, data)}`)
			}
		}
		throw new Error('RunPod: timed out waiting for image')
	}

	private async downloadImage(url: string): Promise<ArrayBuffer> {
		const response = await requestUrl({ url, method: 'GET', throw: false })
		if (response.status >= 400) {
			throw new Error(`RunPod: failed to download image (${response.status})`)
		}
		return response.arrayBuffer
	}
}

export async function testRunPodConnection(apiKey: string): Promise<{ ok: boolean; message: string }> {
	if (!apiKey) return { ok: false, message: 'API key is empty.' }
	try {
		const resp = await requestUrl({
			url: `${RUNPOD_FLUX_KLEIN_BASE_URL}/status/bragi-auth-check`,
			method: 'GET',
			headers: { 'authorization': `Bearer ${apiKey}` },
			throw: false,
		})
		if (resp.status === 401 || resp.status === 403) return { ok: false, message: 'Invalid API key.' }
		if (resp.status < 500) return { ok: true, message: 'Connected.' }
		return { ok: false, message: `Unexpected status ${resp.status}.` }
	} catch (err: unknown) {
		return { ok: false, message: `Network error: ${err instanceof Error ? err.message : String(err)}` }
	}
}

function isCompleted(data: RunPodResponse): boolean {
	return String(data.status || '').toUpperCase() === 'COMPLETED'
}

function isFailed(data: RunPodResponse): boolean {
	return ['FAILED', 'CANCELLED', 'CANCELED', 'TIMED_OUT'].includes(String(data.status || '').toUpperCase())
}

function assertNoWorkerError(data: RunPodResponse): RunPodResponse {
	if (isRecord(data.output) && data.output.error) {
		throw new Error(`RunPod worker: ${unknownErrorMessage(data.output.error)}`)
	}
	return data
}

function providerErrorMessage(status: number, data: RunPodResponse | undefined): string {
	if (!data) return `HTTP ${status}`
	if (data.message) return `${status} ${data.message}`
	if (data.detail) return `${status} ${data.detail}`
	if (data.error) return `${status} ${typeof data.error === 'string' ? data.error : JSON.stringify(data.error).substring(0, 240)}`
	if (isRecord(data.output) && data.output.error) return `${status} ${unknownErrorMessage(data.output.error)}`
	return `HTTP ${status}`
}

function unknownErrorMessage(value: unknown): string {
	if (typeof value === 'string') return value
	try {
		const serialized = JSON.stringify(value)
		if (serialized) return serialized.substring(0, 240)
	} catch {
		// Fall through to the stable generic message.
	}
	return 'Unknown worker error'
}

function extractImageOutput(value: unknown): ExtractedImage | null {
	return walkImageOutput(value, 0)
}

function walkImageOutput(value: unknown, depth: number): ExtractedImage | null {
	if (depth > 5 || value === null || value === undefined) return null
	if (typeof value === 'string') return imageFromString(value)
	if (Array.isArray(value)) {
		for (const item of value) {
			const extracted = walkImageOutput(item, depth + 1)
			if (extracted) return extracted
		}
		return null
	}
	if (!isRecord(value)) return null

	for (const key of ['image', 'image_base64', 'base64', 'base64_png', 'png', 'url', 'image_url', 'output_url']) {
		const extracted = walkImageOutput(value[key], depth + 1)
		if (extracted) return extracted
	}
	for (const nested of Object.values(value)) {
		const extracted = walkImageOutput(nested, depth + 1)
		if (extracted) return extracted
	}
	return null
}

function imageFromString(value: string): ExtractedImage | null {
	const trimmed = value.trim()
	if (!trimmed) return null
	if (/^https?:\/\//i.test(trimmed)) {
		return { url: trimmed, mime: 'image/png', extension: 'png' }
	}
	const dataMatch = trimmed.match(/^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i)
	if (dataMatch) {
		const mime = dataMatch[1].toLowerCase()
		return {
			bytes: base64ToArrayBuffer(dataMatch[2]),
			mime,
			extension: extensionForMime(mime),
		}
	}
	if (looksLikeImageBase64(trimmed)) {
		return {
			bytes: base64ToArrayBuffer(trimmed),
			mime: 'image/png',
			extension: 'png',
		}
	}
	return null
}

function looksLikeImageBase64(value: string): boolean {
	const compact = value.replace(/\s+/g, '')
	if (compact.length < 80 || !/^[a-z0-9+/=]+$/i.test(compact)) return false
	return compact.startsWith('iVBORw0KGgo')
		|| compact.startsWith('/9j/')
		|| compact.startsWith('UklGR')
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
	const compact = value.replace(/\s+/g, '')
	const binary = atob(compact)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
	return bytes.buffer
}

function extensionForMime(mime: string): string {
	if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg'
	if (mime === 'image/webp') return 'webp'
	return 'png'
}

function numberParam(value: unknown, fallback: number): number {
	const parsed = typeof value === 'number'
		? value
		: typeof value === 'string'
			? Number.parseFloat(value)
			: NaN
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function safeId(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'flux_2_klein_9b'
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => window.setTimeout(resolve, ms))
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after provider payload parsing. */

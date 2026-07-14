/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- BFL responses are runtime-shaped API payloads. */
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import type { GenerateImageResult, ImageProvider } from './types'
import { stringParam } from './params'

const BFL_BASE_URL = 'https://api.bfl.ai/v1'
const DEFAULT_TARGET_LONG_EDGE = 2048
const DEFAULT_SAFETY_TOLERANCE = 5
const DEFAULT_OUTPUT_FORMAT = 'png'

export const BFL_DENOISE_PROMPT = '加强明暗对比，干净的质感，平滑的阴影，控制的细节，极简的纹理，高清晰度，精细的边缘，平滑的渐变--无噪点、颗粒感、瑕疵、高频细节、脏污的纹理、过度锐化、斑驳、混乱的细节。保持当前所有元素不变，色彩不变'

interface BflSubmitResponse {
	id?: string
	polling_url?: string
	detail?: string
	message?: string
	error?: unknown
}

interface BflResultResponse {
	status?: string
	result?: {
		sample?: string
		seed?: number
		prompt?: string
	}
	detail?: string
	message?: string
	error?: unknown
}

export interface PreparedReferenceImage {
	base64: string
	width: number
	height: number
	dataUri: string
}

interface ImagePixels {
	width: number
	height: number
	data: Uint8ClampedArray
}

const COLOR_MATCH_COVARIANCE_EPSILON = 1e-5

export class BflImageProvider implements ImageProvider {
	name = 'BFL'
	private apiKey: string
	private app: App
	private outputDir: string

	constructor(apiKey: string, app: App, outputDir: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
	}

	async generateImage(prompt: string, params?: Record<string, unknown>): Promise<GenerateImageResult> {
		const modelId = stringParam(params?.modelId, 'flux-2-klein-9b')
		const refImages = Array.isArray(params?.refImages)
			? params.refImages.filter((ref): ref is string => typeof ref === 'string')
			: []
		const targetLongEdge = positiveIntParam(params?.targetLongEdge, DEFAULT_TARGET_LONG_EDGE)
		const outputFormat = DEFAULT_OUTPUT_FORMAT
		const seed = randomSeed()
		const enableColorMatch = booleanParam(params?.enableColorMatch, false)
		const colorMatchRefImage = stringParam(
			params?.colorMatchRefImage || params?.colorMatchReferenceImage || params?.colorMatchReference || params?.colorMatchImage,
			'',
		)

		const payload: Record<string, unknown> = {
			prompt,
			seed,
			safety_tolerance: DEFAULT_SAFETY_TOLERANCE,
			output_format: outputFormat,
		}

		let inputReferenceForColorMatch: string | null = null
		if (refImages.length > 0) {
			const prepared = await prepareReferenceImage(refImages[0], targetLongEdge)
			payload.input_image = prepared.base64
			payload.width = prepared.width
			payload.height = prepared.height
			inputReferenceForColorMatch = prepared.dataUri
		} else {
			const { width, height } = dimensionsFromParams(params, targetLongEdge)
			payload.width = width
			payload.height = height
		}

		const referenceForColorMatch = enableColorMatch && colorMatchRefImage
			? (await prepareReferenceImage(colorMatchRefImage, targetLongEdge)).dataUri
			: inputReferenceForColorMatch
		const submitted = await this.submit(modelId, payload)
		const result = await this.poll(submitted)
		const sampleUrl = result.result?.sample
		if (!sampleUrl) {
			throw new Error(`BFL: completed task has no sample URL — ${JSON.stringify(result).substring(0, 240)}`)
		}

		const imageResponse = await requestUrl({ url: sampleUrl })
		let outputBytes = imageResponse.arrayBuffer
		let extension = DEFAULT_OUTPUT_FORMAT

		if (enableColorMatch && referenceForColorMatch) {
			outputBytes = await colorMatchImage(referenceForColorMatch, outputBytes, mimeForOutputFormat(extension))
			extension = 'png'
		}

		const timestamp = Date.now()
		const fileName = `bfl_flux2_klein9b_${timestamp}.${extension}`
		const filePath = `${this.outputDir}/${fileName}`
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) {
			await adapter.mkdir(this.outputDir)
		}
		await adapter.writeBinary(filePath, outputBytes)
		return { filePath }
	}

	private async submit(modelId: string, payload: Record<string, unknown>): Promise<BflSubmitResponse> {
		const response = await requestUrl({
			url: `${BFL_BASE_URL}/${modelId}`,
			method: 'POST',
			headers: {
				'accept': 'application/json',
				'content-type': 'application/json',
				'x-key': this.apiKey,
			},
			body: JSON.stringify(payload),
			throw: false,
		})
		const data = response.json as BflSubmitResponse
		if (response.status >= 400 || !data?.id || !data?.polling_url) {
			throw new Error(`BFL: ${providerErrorMessage(response.status, data)}`)
		}
		return data
	}

	private async poll(submitted: BflSubmitResponse): Promise<BflResultResponse> {
		const pollingUrl = submitted.polling_url
		if (!pollingUrl) throw new Error('BFL: missing polling URL')
		for (let attempt = 0; attempt < 180; attempt++) {
			await sleep(1000)
			const response = await requestUrl({
				url: pollingUrl,
				method: 'GET',
				headers: {
					'accept': 'application/json',
					'x-key': this.apiKey,
				},
				throw: false,
			})
			const data = response.json as BflResultResponse
			if (response.status >= 400) {
				throw new Error(`BFL status: ${providerErrorMessage(response.status, data)}`)
			}
			if (data.status === 'Ready') return data
			if (data.status && ['Error', 'Failed', 'Request Moderated', 'Content Moderated'].includes(data.status)) {
				throw new Error(`BFL task failed: ${providerErrorMessage(response.status, data)}`)
			}
		}
		throw new Error('BFL: timed out waiting for image')
	}
}

export async function testBflConnection(apiKey: string): Promise<{ ok: boolean; message: string }> {
	if (!apiKey) return { ok: false, message: 'API key is empty.' }
	try {
		const resp = await requestUrl({
			url: `${BFL_BASE_URL}/flux-2-klein-9b`,
			method: 'POST',
			headers: {
				'accept': 'application/json',
				'content-type': 'application/json',
				'x-key': apiKey,
			},
			body: '{}',
			throw: false,
		})
		if (resp.status === 401 || resp.status === 403) return { ok: false, message: 'Invalid API key.' }
		if (resp.status === 400 || resp.status === 422) return { ok: true, message: 'Connected.' }
		if (resp.status === 200) return { ok: true, message: 'Connected.' }
		return { ok: false, message: `Unexpected status ${resp.status}.` }
	} catch (err: unknown) {
		return { ok: false, message: `Network error: ${err instanceof Error ? err.message : String(err)}` }
	}
}

function providerErrorMessage(status: number, data: BflSubmitResponse | BflResultResponse | undefined): string {
	const detail = data?.detail || data?.message
	if (detail) return `${status} ${detail}`
	if (data?.error) return `${status} ${typeof data.error === 'string' ? data.error : JSON.stringify(data.error).substring(0, 240)}`
	return `HTTP ${status}`
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => window.setTimeout(resolve, ms))
}

export function positiveIntParam(value: unknown, fallback: number): number {
	const parsed = typeof value === 'number'
		? value
		: typeof value === 'string'
			? Number.parseInt(value, 10)
			: NaN
	if (!Number.isFinite(parsed) || parsed <= 0) return fallback
	return Math.round(parsed)
}

export function randomSeed(): number {
	const values = new Uint32Array(1)
	crypto.getRandomValues(values)
	return (values[0] % 2147483647) + 1
}

export function booleanParam(value: unknown, fallback: boolean): boolean {
	if (typeof value === 'boolean') return value
	if (typeof value === 'number') return value !== 0
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase()
		if (['true', 'yes', '1', 'on'].includes(normalized)) return true
		if (['false', 'no', '0', 'off'].includes(normalized)) return false
	}
	return fallback
}

export function dimensionsFromParams(params: Record<string, unknown> | undefined, targetLongEdge: number): { width: number; height: number } {
	const explicitWidth = positiveIntParam(params?.width, 0)
	const explicitHeight = positiveIntParam(params?.height, 0)
	if (explicitWidth > 0 && explicitHeight > 0) {
		return { width: explicitWidth, height: explicitHeight }
	}
	const aspectRatio = stringParam(params?.aspectRatio || params?.aspect_ratio || params?.ratio, '1:1')
	const match = aspectRatio.match(/^(\d+)\s*:\s*(\d+)$/)
	const wRatio = match ? Number.parseInt(match[1], 10) : 1
	const hRatio = match ? Number.parseInt(match[2], 10) : 1
	if (wRatio >= hRatio) {
		return { width: targetLongEdge, height: Math.max(64, Math.round(targetLongEdge * hRatio / wRatio)) }
	}
	return { width: Math.max(64, Math.round(targetLongEdge * wRatio / hRatio)), height: targetLongEdge }
}

export async function prepareReferenceImage(ref: string, targetLongEdge: number): Promise<PreparedReferenceImage> {
	const pixels = await loadImagePixels(ref)
	const scale = Math.min(1, targetLongEdge / Math.max(pixels.width, pixels.height))
	const width = Math.max(1, Math.round(pixels.width * scale))
	const height = Math.max(1, Math.round(pixels.height * scale))
	const canvas = createEl('canvas')
	canvas.width = width
	canvas.height = height
	const ctx = canvas.getContext('2d')
	if (!ctx) throw new Error('BFL: could not create image canvas')
	const image = await loadHtmlImage(ref)
	ctx.imageSmoothingEnabled = true
	ctx.imageSmoothingQuality = 'high'
	ctx.drawImage(image, 0, 0, width, height)
	const dataUri = canvas.toDataURL('image/png')
	return {
		base64: stripDataUriPrefix(dataUri),
		width,
		height,
		dataUri,
	}
}

export function stripDataUriPrefix(value: string): string {
	const comma = value.indexOf(',')
	return comma >= 0 ? value.slice(comma + 1) : value
}

export function mimeForOutputFormat(format: string): string {
	if (format === 'jpg' || format === 'jpeg') return 'image/jpeg'
	if (format === 'webp') return 'image/webp'
	return 'image/png'
}

async function loadImagePixels(source: string | ArrayBuffer, mimeType = 'image/png'): Promise<ImagePixels> {
	const image = await loadHtmlImage(source, mimeType)
	const canvas = createEl('canvas')
	canvas.width = image.naturalWidth || image.width
	canvas.height = image.naturalHeight || image.height
	const ctx = canvas.getContext('2d', { willReadFrequently: true })
	if (!ctx) throw new Error('BFL: could not read image pixels')
	ctx.drawImage(image, 0, 0)
	const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
	return { width: canvas.width, height: canvas.height, data: imageData.data }
}

function loadHtmlImage(source: string | ArrayBuffer, mimeType = 'image/png'): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const image = new Image()
		let urlToRevoke = ''
		let timeout: number
		const finish = (fn: () => void) => {
			window.clearTimeout(timeout)
			if (urlToRevoke) URL.revokeObjectURL(urlToRevoke)
			fn()
		}
		image.onload = () => finish(() => resolve(image))
		image.onerror = () => finish(() => reject(new Error('BFL: could not decode image')))
		timeout = window.setTimeout(() => finish(() => reject(new Error('BFL: image decode timed out'))), 15000)
		if (typeof source === 'string') {
			image.src = source
		} else {
			urlToRevoke = URL.createObjectURL(new Blob([source], { type: mimeType }))
			image.src = urlToRevoke
		}
	})
}

export async function colorMatchImage(referenceDataUri: string, targetBytes: ArrayBuffer, targetMime: string): Promise<ArrayBuffer> {
	const reference = await loadImagePixels(referenceDataUri)
	const target = await loadImagePixels(targetBytes, targetMime)
	const output = transferRgbCovariance(reference.data, target.data)

	const canvas = createEl('canvas')
	canvas.width = target.width
	canvas.height = target.height
	const ctx = canvas.getContext('2d')
	if (!ctx) throw new Error('BFL: could not encode color matched image')
	ctx.putImageData(new ImageData(output, target.width, target.height), 0, 0)
	return canvasToPng(canvas)
}

function transferRgbCovariance(referenceData: Uint8ClampedArray, targetData: Uint8ClampedArray): Uint8ClampedArray {
	const referenceStats = rgbStats(referenceData)
	const targetStats = rgbStats(targetData)
	const referenceSqrt = symmetricMatrixPower3(referenceStats.covariance, 0.5)
	const targetInvSqrt = symmetricMatrixPower3(targetStats.covariance, -0.5)
	const transform = multiplyMatrix3(referenceSqrt, targetInvSqrt)
	const output = new Uint8ClampedArray(targetData)

	for (let i = 0; i < output.length; i += 4) {
		const r = targetData[i] / 255 - targetStats.mean[0]
		const g = targetData[i + 1] / 255 - targetStats.mean[1]
		const b = targetData[i + 2] / 255 - targetStats.mean[2]
		output[i] = clamp255((transform[0] * r + transform[1] * g + transform[2] * b + referenceStats.mean[0]) * 255)
		output[i + 1] = clamp255((transform[3] * r + transform[4] * g + transform[5] * b + referenceStats.mean[1]) * 255)
		output[i + 2] = clamp255((transform[6] * r + transform[7] * g + transform[8] * b + referenceStats.mean[2]) * 255)
	}
	return output
}

function rgbStats(data: Uint8ClampedArray): { mean: [number, number, number]; covariance: number[] } {
	const mean: [number, number, number] = [0, 0, 0]
	const count = Math.max(1, data.length / 4)
	for (let i = 0; i < data.length; i += 4) {
		mean[0] += data[i] / 255
		mean[1] += data[i + 1] / 255
		mean[2] += data[i + 2] / 255
	}
	mean[0] /= count
	mean[1] /= count
	mean[2] /= count

	const covariance = new Array(9).fill(0)
	for (let i = 0; i < data.length; i += 4) {
		const r = data[i] / 255 - mean[0]
		const g = data[i + 1] / 255 - mean[1]
		const b = data[i + 2] / 255 - mean[2]
		covariance[0] += r * r
		covariance[1] += r * g
		covariance[2] += r * b
		covariance[4] += g * g
		covariance[5] += g * b
		covariance[8] += b * b
	}
	const denom = Math.max(1, count - 1)
	covariance[0] = covariance[0] / denom + COLOR_MATCH_COVARIANCE_EPSILON
	covariance[1] /= denom
	covariance[2] /= denom
	covariance[3] = covariance[1]
	covariance[4] = covariance[4] / denom + COLOR_MATCH_COVARIANCE_EPSILON
	covariance[5] /= denom
	covariance[6] = covariance[2]
	covariance[7] = covariance[5]
	covariance[8] = covariance[8] / denom + COLOR_MATCH_COVARIANCE_EPSILON
	return { mean, covariance }
}

function symmetricMatrixPower3(matrix: number[], power: number): number[] {
	const { values, vectors } = jacobiEigenSymmetric3(matrix)
	const output = new Array(9).fill(0)
	for (let eigen = 0; eigen < 3; eigen++) {
		const powered = Math.pow(Math.max(values[eigen], COLOR_MATCH_COVARIANCE_EPSILON), power)
		for (let row = 0; row < 3; row++) {
			for (let col = 0; col < 3; col++) {
				output[row * 3 + col] += vectors[row * 3 + eigen] * powered * vectors[col * 3 + eigen]
			}
		}
	}
	return output
}

function jacobiEigenSymmetric3(matrix: number[]): { values: [number, number, number]; vectors: number[] } {
	const a = matrix.slice()
	const vectors = [1, 0, 0, 0, 1, 0, 0, 0, 1]
	for (let iteration = 0; iteration < 24; iteration++) {
		let p = 0
		let q = 1
		let max = Math.abs(a[1])
		const a02 = Math.abs(a[2])
		const a12 = Math.abs(a[5])
		if (a02 > max) {
			p = 0
			q = 2
			max = a02
		}
		if (a12 > max) {
			p = 1
			q = 2
			max = a12
		}
		if (max < 1e-12) break
		rotateJacobi3(a, vectors, p, q)
	}
	return {
		values: [a[0], a[4], a[8]],
		vectors,
	}
}

function rotateJacobi3(matrix: number[], vectors: number[], p: number, q: number): void {
	const pp = p * 3 + p
	const qq = q * 3 + q
	const pq = p * 3 + q
	const app = matrix[pp]
	const aqq = matrix[qq]
	const apq = matrix[pq]
	if (Math.abs(apq) < 1e-12) return
	const tau = (aqq - app) / (2 * apq)
	const sign = tau < 0 ? -1 : 1
	const t = sign / (Math.abs(tau) + Math.sqrt(1 + tau * tau))
	const c = 1 / Math.sqrt(1 + t * t)
	const s = t * c

	for (let k = 0; k < 3; k++) {
		if (k === p || k === q) continue
		const kp = k * 3 + p
		const kq = k * 3 + q
		const akp = matrix[kp]
		const akq = matrix[kq]
		matrix[kp] = c * akp - s * akq
		matrix[p * 3 + k] = matrix[kp]
		matrix[kq] = s * akp + c * akq
		matrix[q * 3 + k] = matrix[kq]
	}

	matrix[pp] = c * c * app - 2 * s * c * apq + s * s * aqq
	matrix[qq] = s * s * app + 2 * s * c * apq + c * c * aqq
	matrix[pq] = 0
	matrix[q * 3 + p] = 0

	for (let k = 0; k < 3; k++) {
		const kp = k * 3 + p
		const kq = k * 3 + q
		const vkp = vectors[kp]
		const vkq = vectors[kq]
		vectors[kp] = c * vkp - s * vkq
		vectors[kq] = s * vkp + c * vkq
	}
}

function multiplyMatrix3(a: number[], b: number[]): number[] {
	const output = new Array(9).fill(0)
	for (let row = 0; row < 3; row++) {
		for (let col = 0; col < 3; col++) {
			output[row * 3 + col] =
				a[row * 3] * b[col]
				+ a[row * 3 + 1] * b[3 + col]
				+ a[row * 3 + 2] * b[6 + col]
		}
	}
	return output
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(blob => {
			if (!blob) {
				reject(new Error('BFL: could not encode PNG'))
				return
			}
			blob.arrayBuffer().then(resolve, reject)
		}, 'image/png')
	})
}

function clamp255(value: number): number {
	if (!Number.isFinite(value)) return 0
	return Math.max(0, Math.min(255, Math.round(value)))
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after provider payload parsing. */

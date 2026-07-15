/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import type { ImageProvider, GenerateImageResult, VideoProvider, GenerateVideoResult } from './types'
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import { uploadRef } from './upload'
import { stringParam } from './params'
import {
	booleanParam,
	colorMatchImage,
	dimensionsFromParams,
	mimeForOutputFormat,
	positiveIntParam,
	prepareReferenceImage,
} from './bfl'

const FAL_RUN = 'https://fal.run'
const FAL_QUEUE = 'https://queue.fal.run'
const FAL_FLUX_KLEIN_9B_BASE = 'fal-ai/flux-2/klein/9b/base'
const FAL_FLUX_KLEIN_9B_BASE_EDIT = `${FAL_FLUX_KLEIN_9B_BASE}/edit`
const FAL_FLUX_KLEIN_STEPS = 5
const FAL_FLUX_KLEIN_GUIDANCE_SCALE = 1
const FAL_FLUX_KLEIN_ENABLE_SAFETY_CHECKER = false
const DEFAULT_FLUX_TARGET_LONG_EDGE = 2048

function imageRefArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)
		: []
}

async function uploadFalImageRef(ref: string): Promise<string> {
	const match = ref.match(/^data:([^;]+);base64,(.+)$/)
	if (!match) return ref
	const binary = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0))
	const ext = match[1].includes('png') ? 'png' : 'jpg'
	return uploadRef(undefined, binary.buffer, `ref.${ext}`, match[1])
}

/**
 * Unified fal.ai provider for image and video generation.
 * All models on fal.ai use the same auth and request pattern.
 */
export class FalImageProvider implements ImageProvider {
	name = 'fal.ai'
	private apiKey: string
	private app: App
	private outputDir: string

	constructor(apiKey: string, app: App, outputDir: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
	}

	async generateImage(prompt: string, params?: Record<string, unknown>): Promise<GenerateImageResult> {
		let modelId = stringParam(params?.modelId, 'xai/grok-imagine-image')
		const refImages = imageRefArray(params?.refImages)
		const isFluxKlein = modelId === FAL_FLUX_KLEIN_9B_BASE || modelId === FAL_FLUX_KLEIN_9B_BASE_EDIT

		// Build input based on model
		const input: Record<string, unknown> = { prompt }
		let colorMatchReference: string | null = null

		if (isFluxKlein) {
			const targetLongEdge = positiveIntParam(params?.targetLongEdge, DEFAULT_FLUX_TARGET_LONG_EDGE)
			input.num_inference_steps = FAL_FLUX_KLEIN_STEPS
			input.guidance_scale = FAL_FLUX_KLEIN_GUIDANCE_SCALE
			input.enable_safety_checker = FAL_FLUX_KLEIN_ENABLE_SAFETY_CHECKER
			input.output_format = 'png'
			input.num_images = 1

			if (refImages.length > 0) {
				modelId = FAL_FLUX_KLEIN_9B_BASE_EDIT
				const preparedReference = await prepareReferenceImage(refImages[0], targetLongEdge)
				input.image_urls = await Promise.all(refImages.slice(0, 4).map(uploadFalImageRef))
				input.image_size = { width: preparedReference.width, height: preparedReference.height }
				colorMatchReference = preparedReference.dataUri
			} else {
				modelId = FAL_FLUX_KLEIN_9B_BASE
				input.image_size = dimensionsFromParams(params, targetLongEdge)
			}
		} else {
			if (params?.aspectRatio) input.aspect_ratio = params.aspectRatio
			if (params?.resolution) input.resolution = params.resolution
			if (params?.imageSize) input.image_size = params.imageSize
			if (params?.size) input.size = params.size
			if (refImages.length > 0) {
				input.image_urls = await Promise.all(refImages.map(uploadFalImageRef))
			}
		}

		const response = await requestUrl({
			url: `${FAL_RUN}/${modelId}`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Key ${this.apiKey}`,
			},
			body: JSON.stringify(input),
		})

		const data = response.json

		// fal.ai returns images as { images: [{ url, ... }] }
		const imageUrl = data.images?.[0]?.url
		if (!imageUrl) {
			throw new Error(`fal.ai: No image in response — ${JSON.stringify(data).substring(0, 200)}`)
		}

		// Download image to vault
		const imgResponse = await requestUrl({ url: imageUrl })
		let outputBytes = imgResponse.arrayBuffer
		const timestamp = Date.now()
		let ext = isFluxKlein || imageUrl.includes('.png') ? 'png' : 'jpg'
		const enableColorMatch = isFluxKlein && booleanParam(params?.enableColorMatch, false)
		const explicitColorMatchRef = stringParam(params?.colorMatchRefImage, '')
		if (enableColorMatch) {
			const reference = explicitColorMatchRef
				? (await prepareReferenceImage(explicitColorMatchRef, positiveIntParam(params?.targetLongEdge, DEFAULT_FLUX_TARGET_LONG_EDGE))).dataUri
				: colorMatchReference
			if (reference) {
				outputBytes = await colorMatchImage(reference, outputBytes, mimeForOutputFormat(ext))
				ext = 'png'
			}
		}
		const fileName = `img_${timestamp}.${ext}`
		const filePath = `${this.outputDir}/${fileName}`

		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) {
			await adapter.mkdir(this.outputDir)
		}

		await adapter.writeBinary(filePath, outputBytes)
		return { filePath }
	}
}

export class FalVideoProvider implements VideoProvider {
	name = 'fal.ai'
	private apiKey: string
	private app: App
	private outputDir: string

	constructor(apiKey: string, app: App, outputDir: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
	}

	async generateVideo(prompt: string, params?: Record<string, unknown>): Promise<GenerateVideoResult> {
		let modelId = stringParam(params?.modelId, 'xai/grok-imagine-video')
		const genMode = params?.genMode || 'text-to-video'
		const refImages: string[] = params?.refImages || []
		const refVideos: string[] = params?.refVideos || []

		// Route to correct sub-endpoint based on mode
		const modelBase = modelId.split('/text-to-video')[0].split('/image-to-video')[0]

		if (genMode === 'first-frame' && refImages.length >= 1) {
			modelId = `${modelBase}/image-to-video`
		} else if (genMode === 'image-ref' && refImages.length >= 1) {
			// Seedance uses base endpoint with image_urls; Grok uses /reference-to-video
			if (modelBase.includes('grok')) {
				modelId = `${modelBase}/reference-to-video`
			} else {
				modelId = modelBase  // Seedance: base endpoint, pass image_urls
			}
		} else if (genMode === 'video-extend') {
			modelId = `${modelBase}/extend-video`
		} else {
			modelId = `${modelBase}/text-to-video`
		}

		// Build input
		const input: unknown = { prompt }

		if (params?.duration) input.duration = parseInt(params.duration)
		if (params?.aspectRatio) input.aspect_ratio = params.aspectRatio
		if (params?.aspect_ratio) input.aspect_ratio = params.aspect_ratio
		if (params?.resolution) input.resolution = params.resolution
		if (params?.ratio) input.aspect_ratio = params.ratio
		if (params?.durationSeconds) input.duration = parseInt(params.durationSeconds)

		// Image inputs — data URIs need to be uploaded to R2 first
		if (refImages.length > 0) {
			const uploadedUrls: string[] = []
			for (const dataUri of refImages) {
				const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
				if (match) {
					const binary = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0))
					const ext = match[1].includes('png') ? 'png' : 'jpg'
					const url = await uploadRef(undefined, binary.buffer, `ref.${ext}`, match[1])
					uploadedUrls.push(url)
				} else {
					uploadedUrls.push(dataUri) // already a URL
				}
			}

			if (genMode === 'first-frame') {
				input.image_url = uploadedUrls[0]
			} else if (genMode === 'image-ref') {
				input.image_urls = uploadedUrls
			}
		}

		if (genMode === 'video-extend') {
			if (refVideos.length === 0) {
				throw new Error('video-extend requires an upstream video connected to this prompt node')
			}
			input.video_url = refVideos[0]
		}

		// Submit to queue (video is always async)
		const submitResponse = await requestUrl({
			url: `${FAL_QUEUE}/${modelId}`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Key ${this.apiKey}`,
			},
			body: JSON.stringify(input),
		})

		const submitData = submitResponse.json
		const requestId = submitData.request_id
		if (!requestId) {
			throw new Error(`fal.ai: No request_id — ${JSON.stringify(submitData).substring(0, 200)}`)
		}

		// Store BASE model ID for polling (not the sub-endpoint)
		// fal.ai polling URLs use the base model, not /text-to-video etc.
		const pollModelId = modelId.split('/text-to-video')[0]
			.split('/image-to-video')[0]
			.split('/reference-to-video')[0]
			.split('/extend-video')[0]
			.split('/edit-video')[0]
		return { done: false, taskId: `${pollModelId}::${requestId}` }
	}

	async checkStatus(taskId: string): Promise<GenerateVideoResult> {
		const [modelId, requestId] = taskId.split('::')

		const statusResponse = await requestUrl({
			url: `${FAL_QUEUE}/${modelId}/requests/${requestId}/status`,
			method: 'GET',
			headers: { 'Authorization': `Key ${this.apiKey}` },
		})

		const status = statusResponse.json

		if (status.status === 'COMPLETED') {
			// Get result
			const resultResponse = await requestUrl({
				url: `${FAL_QUEUE}/${modelId}/requests/${requestId}`,
				method: 'GET',
				headers: { 'Authorization': `Key ${this.apiKey}` },
			})

			const result = resultResponse.json
			const videoUrl = result.video?.url
			if (!videoUrl) {
				throw new Error(`fal.ai: No video URL in result — ${JSON.stringify(result).substring(0, 200)}`)
			}

			const filePath = await this.downloadVideo(videoUrl)
			return { done: true, filePath }
		}

		if (status.status === 'FAILED') {
			throw new Error(`fal.ai: Task failed — ${status.error || 'unknown error'}`)
		}

		// IN_QUEUE or IN_PROGRESS
		return { done: false, taskId }
	}

	private async downloadVideo(url: string): Promise<string> {
		const response = await requestUrl({ url })
		const timestamp = Date.now()
		const fileName = `vid_${timestamp}.mp4`
		const filePath = `${this.outputDir}/${fileName}`

		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) {
			await adapter.mkdir(this.outputDir)
		}

		await adapter.writeBinary(filePath, response.arrayBuffer)
		return filePath
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

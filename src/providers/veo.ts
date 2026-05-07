import type { VideoProvider, GenerateVideoResult } from './types'
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import { stringParam } from './params'

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

interface VeoImage {
	inlineData: {
		mimeType: string
		data: string
	}
}

interface VeoInstance {
	prompt: string
	image?: VeoImage
	lastFrame?: VeoImage
	referenceImages?: Array<{
		image: VeoImage
		referenceType: 'asset'
	}>
}

export class VeoProvider implements VideoProvider {
	name = 'Veo'
	private apiKey: string
	private app: App
	private outputDir: string

	constructor(apiKey: string, app: App, outputDir: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
	}

	async generateVideo(prompt: string, params?: Record<string, unknown>): Promise<GenerateVideoResult> {
		const modelId = stringParam(params?.modelId, 'veo-3.1-generate-preview')
		const genMode = stringParam(params?.genMode, 'text-to-video')
		const aspectRatio = stringParam(params?.aspectRatio, '16:9')
		const resolution = stringParam(params?.resolution, '720p')
		const refImages = Array.isArray(params?.refImages) ? params.refImages : []
		const parsedImages = refImages
			.filter((dataUri): dataUri is string => typeof dataUri === 'string')
			.map(parseDataUri)
			.filter((image): image is VeoImage => image !== null)

		// Build instance
		const instance: VeoInstance = { prompt }
		const effectiveMode = getEffectiveMode(genMode, parsedImages.length)

		if (effectiveMode === 'image-ref' && parsedImages.length >= 1) {
			instance.referenceImages = parsedImages.slice(0, 3).map((image) => ({
				image,
				referenceType: 'asset',
			}))
		} else if (effectiveMode === 'first-last-frame' && parsedImages.length >= 2) {
			// First + last frame (interpolation)
			instance.image = parsedImages[0]
			instance.lastFrame = parsedImages[1]
		} else if (effectiveMode === 'first-frame' && parsedImages.length >= 1) {
			// Image-to-video (first frame)
			instance.image = parsedImages[0]
		}

		const usesImageInput = Boolean(instance.image || instance.lastFrame || instance.referenceImages?.length)
		const usesReferenceImages = Boolean(instance.referenceImages?.length)
		const durationSeconds = normalizeDuration(
			stringParam(params?.durationSeconds, '6'),
			resolution,
			usesReferenceImages,
			effectiveMode === 'first-last-frame',
		)

		const response = await requestUrl({
			url: `${BASE_URL}/models/${modelId}:predictLongRunning`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-goog-api-key': this.apiKey,
			},
			body: JSON.stringify({
				instances: [instance],
				parameters: {
					aspectRatio,
					resolution,
					durationSeconds,
					personGeneration: usesImageInput ? 'allow_adult' : 'allow_all',
				},
			}),
		})

		const data = response.json

		if (data.error) {
			throw new Error(`Veo: ${data.error.message || JSON.stringify(data.error)}`)
		}

		// The response contains an operation name for polling
		const operationName = data.name
		if (!operationName) {
			throw new Error('Veo: No operation name returned')
		}

		return { done: false, taskId: operationName }
	}

	async checkStatus(taskId: string): Promise<GenerateVideoResult> {
		const response = await requestUrl({
			url: `${BASE_URL}/${taskId}`,
			method: 'GET',
			headers: {
				'x-goog-api-key': this.apiKey,
			},
		})

		const data = response.json

		if (data.error) {
			throw new Error(`Veo: ${data.error.message}`)
		}

		if (data.done) {
			// Extract video URI
			const samples = data.response?.generateVideoResponse?.generatedSamples
			const generatedVideos = data.response?.generatedVideos
			const videoUri = samples?.[0]?.video?.uri || generatedVideos?.[0]?.video?.uri
			if (!videoUri) {
				throw new Error('Veo: No video URI in completed operation')
			}

			const filePath = await this.downloadVideo(videoUri)
			return { done: true, filePath }
		}

		// Still processing
		return { done: false, taskId }
	}

	private async downloadVideo(url: string): Promise<string> {
		const response = await requestUrl({
			url,
			headers: {
				'x-goog-api-key': this.apiKey,
			},
		})
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

function parseDataUri(dataUri: string): VeoImage | null {
	const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
	if (!match) return null
	return {
		inlineData: {
			mimeType: match[1],
			data: match[2],
		},
	}
}

function getEffectiveMode(genMode: string, imageCount: number): string {
	if (genMode === 'image-ref' || genMode === 'first-last-frame' || genMode === 'first-frame') {
		return genMode
	}
	if (imageCount >= 2) return 'first-last-frame'
	if (imageCount === 1) return 'first-frame'
	return 'text-to-video'
}

function normalizeDuration(
	durationSeconds: string,
	resolution: string,
	usesReferenceImages: boolean,
	usesInterpolation: boolean,
): string {
	if (
		(resolution === '1080p' || resolution === '4k' || usesReferenceImages || usesInterpolation)
		&& durationSeconds !== '8'
	) {
		return '8'
	}
	return durationSeconds
}

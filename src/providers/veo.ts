import { writeTaskResult, pollRequest, TaskPollingError } from '../task-errors'
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import type { VideoProvider, GenerateVideoResult } from './types'
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import { stringParam } from './params'
import { throwForGoogleError } from './google-errors'

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

interface VeoImage {
	bytesBase64Encoded: string
	mimeType: string
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
			Number.parseInt(stringParam(params?.durationSeconds, '6'), 10),
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
			throw: false,
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
		throwForGoogleError('Veo', response)

		// The response contains an operation name for polling
		const operationName = data.name
		if (!operationName) {
			throw new Error('Veo: No operation name returned')
		}

		return { done: false, taskId: operationName }
	}

	async checkStatus(taskId: string): Promise<GenerateVideoResult> {
		const response = await pollRequest({
			url: `${BASE_URL}/${taskId}`,
			method: 'GET',
			headers: {
				'x-goog-api-key': this.apiKey,
			},
			throw: false,
		})

		const data = response.json
		if (response.status < 400 && data?.done === true && data.error) throw new TaskPollingError(`Veo: ${data.error.message || 'Task failed'}`, 'terminal')
		throwForGoogleError('Veo', response)
		if (!data || (data.done !== false && data.done !== true && typeof data.name !== 'string')) throw new Error('Veo: malformed operation response')

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
		const response = await pollRequest({
			url,
			headers: {
				'x-goog-api-key': this.apiKey,
			},
			throw: false,
		})
		throwForGoogleError('Veo', response)
		const timestamp = Date.now()
		const fileName = `vid_${timestamp}.mp4`
		const filePath = `${this.outputDir}/${fileName}`

		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) {
			await adapter.mkdir(this.outputDir)
		}

		await writeTaskResult(adapter, filePath, response.arrayBuffer)
		return filePath
	}
}

function parseDataUri(dataUri: string): VeoImage | null {
	const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
	if (!match) return null
	return {
		bytesBase64Encoded: match[2],
		mimeType: match[1],
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
	durationSeconds: number,
	resolution: string,
	usesReferenceImages: boolean,
	usesInterpolation: boolean,
): number {
	const safeDuration = [4, 6, 8].includes(durationSeconds) ? durationSeconds : 6
	if (
		(resolution === '1080p' || resolution === '4k' || usesReferenceImages || usesInterpolation)
		&& safeDuration !== 8
	) {
		return 8
	}
	return safeDuration
}

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

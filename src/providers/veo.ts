import type { VideoProvider, GenerateVideoResult } from './types'
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

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

	async generateVideo(prompt: string, params?: Record<string, any>): Promise<GenerateVideoResult> {
		const modelId = params?.modelId || 'veo-3.1-generate-preview'
		const durationSeconds = parseInt(params?.durationSeconds || '6')
		const aspectRatio = params?.aspectRatio || '16:9'
		const resolution = params?.resolution || '720p'
		const refImages: string[] = params?.refImages || []

		// Build instance
		const instance: any = { prompt }

		if (refImages.length >= 2) {
			// First + last frame (interpolation)
			const first = parseDataUri(refImages[0])
			const last = parseDataUri(refImages[1])
			if (first) instance.image = { inlineData: first }
			if (last) instance.lastFrame = { inlineData: last }
		} else if (refImages.length === 1) {
			// Image-to-video (first frame)
			const img = parseDataUri(refImages[0])
			if (img) instance.image = { inlineData: img }
		}

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
					personGeneration: 'allow_all',
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
			const videoUri = samples?.[0]?.video?.uri
			if (!videoUri) {
				throw new Error('Veo: No video URI in completed operation')
			}

			// Download video (append API key for auth)
			const downloadUrl = videoUri.includes('?')
				? `${videoUri}&key=${this.apiKey}`
				: `${videoUri}?key=${this.apiKey}`

			const filePath = await this.downloadVideo(downloadUrl)
			return { done: true, filePath }
		}

		// Still processing
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

function parseDataUri(dataUri: string): { mimeType: string; data: string } | null {
	const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
	if (!match) return null
	return { mimeType: match[1], data: match[2] }
}

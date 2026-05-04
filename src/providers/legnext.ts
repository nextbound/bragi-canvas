import type { ImageProvider, GenerateImageResult } from './types'
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'

const BASE_URL = 'https://api.legnext.ai/api'

/**
 * Legnext AI provider for Midjourney image generation.
 * Async: POST /v1/diffusion → poll GET /v1/job/{id} → download image.
 * Model version and params are embedded in the prompt text (--v 8, --ar 16:9, etc.)
 */
export class LegnextProvider implements ImageProvider {
	name = 'Legnext'
	private apiKey: string
	private app: App
	private outputDir: string

	constructor(apiKey: string, app: App, outputDir: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
	}

	async generateImage(prompt: string, params?: Record<string, any>): Promise<GenerateImageResult> {
		const modelId = params?.modelId || 'midjourney-v8'

		// Build MJ prompt with params appended
		let mjPrompt = prompt

		// Append version flag
		if (modelId === 'midjourney-niji-7') {
			if (!mjPrompt.includes('--niji')) mjPrompt += ' --niji 7'
		} else {
			if (!mjPrompt.includes('--v ')) mjPrompt += ' --v 8'
		}

		// Append aspect ratio
		if (params?.ar && !mjPrompt.includes('--ar')) {
			mjPrompt += ` --ar ${params.ar}`
		}

		// Append quality
		if (params?.quality && params.quality !== '1' && !mjPrompt.includes('--q ')) {
			mjPrompt += ` --q ${params.quality}`
		}

		// Append stylize
		if (params?.stylize !== undefined && params.stylize !== 100 && !mjPrompt.includes('--stylize')) {
			mjPrompt += ` --stylize ${params.stylize}`
		}

		// Submit task
		const submitResponse = await requestUrl({
			url: `${BASE_URL}/v1/diffusion`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': this.apiKey,
			},
			body: JSON.stringify({ text: mjPrompt }),
		})

		const submitData = submitResponse.json
		if (submitData.error?.message) {
			throw new Error(`Legnext: ${submitData.error.message}`)
		}

		const jobId = submitData.job_id
		if (!jobId) {
			throw new Error('Legnext: No job_id returned')
		}

		// Poll for completion (MJ can take 1-3 minutes)
		const imageUrl = await this.pollForResult(jobId)

		// Download image
		const imgResponse = await requestUrl({ url: imageUrl })
		const timestamp = Date.now()
		const ext = imageUrl.includes('.png') ? 'png' : imageUrl.includes('.webp') ? 'webp' : 'jpg'
		const fileName = `mj_${timestamp}.${ext}`
		const filePath = `${this.outputDir}/${fileName}`

		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) {
			await adapter.mkdir(this.outputDir)
		}

		await adapter.writeBinary(filePath, imgResponse.arrayBuffer)
		return { filePath }
	}

	private async pollForResult(jobId: string): Promise<string> {
		const maxAttempts = 60 // 5 minutes max (5s intervals)
		for (let i = 0; i < maxAttempts; i++) {
			await new Promise(resolve => setTimeout(resolve, 5000))

			const response = await requestUrl({
				url: `${BASE_URL}/v1/job/${jobId}`,
				method: 'GET',
				headers: { 'x-api-key': this.apiKey },
			})

			const data = response.json
			if (data.status === 'completed') {
				const url = data.output?.image_url || data.output?.image_urls?.[0]
				if (!url) throw new Error('Legnext: No image URL in completed job')
				return url
			}

			if (data.status === 'failed') {
				throw new Error(`Legnext: ${data.error?.message || 'Generation failed'}`)
			}

			// pending or processing — continue polling
		}

		throw new Error('Legnext: Generation timed out (5 minutes)')
	}
}

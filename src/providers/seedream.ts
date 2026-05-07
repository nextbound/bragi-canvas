import type { ImageProvider, GenerateImageResult } from './types'
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'

// Resolution + aspect ratio → pixel size mapping
const SIZE_MAP: Record<string, Record<string, string>> = {
	'1K': { '1:1': '1024x1024', '4:3': '1152x864', '3:4': '864x1152', '16:9': '1280x720', '9:16': '720x1280', '3:2': '1248x832', '2:3': '832x1248', '21:9': '1512x648' },
	'2K': { '1:1': '2048x2048', '4:3': '2304x1728', '3:4': '1728x2304', '16:9': '2848x1600', '9:16': '1600x2848', '3:2': '2496x1664', '2:3': '1664x2496', '21:9': '3136x1344' },
	'3K': { '1:1': '3072x3072', '4:3': '3456x2592', '3:4': '2592x3456', '16:9': '4096x2304', '9:16': '2304x4096', '3:2': '3744x2496', '2:3': '2496x3744', '21:9': '4704x2016' },
	'4K': { '1:1': '4096x4096', '4:3': '4704x3520', '3:4': '3520x4704', '16:9': '5504x3040', '9:16': '3040x5504', '3:2': '4992x3328', '2:3': '3328x4992', '21:9': '6240x2656' },
}

export class SeedreamProvider implements ImageProvider {
	name = 'Seedream'
	private apiKey: string
	private app: App
	private outputDir: string

	constructor(apiKey: string, app: App, outputDir: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
	}

	async generateImage(prompt: string, params?: Record<string, unknown>): Promise<GenerateImageResult> {
		const modelId = params?.modelId || 'doubao-seedream-5-0-260128'
		const aspectRatio = params?.aspectRatio || '1:1'
		const resolution = params?.resolution || '2K'
		const refImages: string[] = params?.refImages || []

		// Look up pixel size
		const size = SIZE_MAP[resolution]?.[aspectRatio] || '2048x2048'

		// Build request body
		const body: unknown = {
			model: modelId,
			prompt,
			size,
			response_format: 'b64_json',
			watermark: false,
			sequential_image_generation: 'disabled',
		}

		// Add reference images if provided (Seedream supports up to 14)
		if (refImages.length > 0) {
			body.image = refImages
		}

		const response = await requestUrl({
			url: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(body),
		})

		const data = response.json

		if (data.error) {
			throw new Error(`Seedream: ${data.error.code} — ${data.error.message}`)
		}

		const images = data.data || []
		if (images.length === 0) {
			throw new Error('Seedream: No image generated')
		}

		const imageBase64 = images[0].b64_json
		if (!imageBase64) {
			throw new Error('Seedream: No base64 data in response')
		}

		// Save image to vault
		const timestamp = Date.now()
		const fileName = `img_${timestamp}.png`
		const filePath = `${this.outputDir}/${fileName}`

		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) {
			await adapter.mkdir(this.outputDir)
		}

		const binary = Uint8Array.from(atob(imageBase64), c => c.charCodeAt(0))
		await adapter.writeBinary(filePath, binary)

		return { filePath }
	}
}

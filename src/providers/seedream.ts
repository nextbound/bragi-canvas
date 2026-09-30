import { stringArray } from '../runtime-values'
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import type { ImageProvider, GenerateImageResult } from './types'
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import { sniffImageMime } from './image-upload-prep'

// Resolution + aspect ratio → pixel size mapping. Seedream's Ark upstream enforces a
// per-tier minimum pixel count (e.g. 2K must be ≥ 3,686,400 px), so these are larger than
// the generic OpenAI size table — exported so the SV NewAPI gateway path stays consistent.
// 1K and 1.5K follow the Seedream 5.0 Pro / Flash table. The shared 2K row also stays inside
// Pro / Flash's 4,624,220 px ceiling, so one map serves every Seedream model and custom
// endpoint ids never need model detection.
export const SEEDREAM_SIZE_MAP: Record<string, Record<string, string>> = {
	'1K': { '1:1': '1024x1024', '4:3': '1152x864', '3:4': '864x1152', '16:9': '1424x800', '9:16': '800x1424', '3:2': '1248x832', '2:3': '832x1248', '21:9': '1568x672' },
	'1.5K': { '1:1': '1536x1536', '4:3': '1792x1344', '3:4': '1344x1792', '16:9': '2048x1152', '9:16': '1152x2048', '3:2': '1872x1248', '2:3': '1248x1872', '21:9': '2352x1008' },
	'2K': { '1:1': '2048x2048', '4:3': '2304x1728', '3:4': '1728x2304', '16:9': '2848x1600', '9:16': '1600x2848', '3:2': '2496x1664', '2:3': '1664x2496', '21:9': '3136x1344' },
	'3K': { '1:1': '3072x3072', '4:3': '3456x2592', '3:4': '2592x3456', '16:9': '4096x2304', '9:16': '2304x4096', '3:2': '3744x2496', '2:3': '2496x3744', '21:9': '4704x2016' },
	'4K': { '1:1': '4096x4096', '4:3': '4704x3520', '3:4': '3520x4704', '16:9': '5504x3040', '9:16': '3040x5504', '3:2': '4992x3328', '2:3': '3328x4992', '21:9': '6240x2656' },
}

export function resolveSeedreamImageSize(resolution: string, aspectRatio: string): string {
	return SEEDREAM_SIZE_MAP[resolution.toUpperCase()]?.[aspectRatio] || '2048x2048'
}

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3/images/generations'

export class SeedreamProvider implements ImageProvider {
	name = 'Seedream'
	private apiKey: string
	private app: App
	private outputDir: string
	private baseUrl: string

	constructor(apiKey: string, app: App, outputDir: string, baseUrl?: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
		this.baseUrl = baseUrl || DEFAULT_BASE_URL
	}

	async generateImage(prompt: string, params?: Record<string, unknown>): Promise<GenerateImageResult> {
		const modelId = params?.modelId || 'doubao-seedream-5-0-260128'
		const aspectRatio = params?.aspectRatio || '1:1'
		const resolution = params?.resolution || '2K'
		const refImages: string[] = stringArray(params?.refImages)

		// Look up pixel size
		const size = resolveSeedreamImageSize(resolution as string, aspectRatio as string)

		// Build request body. `sequential_image_generation` is left out: it already defaults to
		// `disabled`, and Seedream 5.0 Pro / Flash reject the field outright.
		const body: Record<string, unknown> = {
			model: modelId,
			prompt,
			size,
			response_format: 'b64_json',
			watermark: false,
		}

		// Only Seedream 5.0 Pro offers the `fast` prompt-optimization mode; `standard` is the
		// upstream default, so it is never sent.
		if (params?.optimizeMode === 'fast') {
			body.optimize_prompt_options = { mode: 'fast' }
		}

		// Add reference images if provided (Seedream 5.0 Pro / Flash accept up to 10, older models 14)
		if (refImages.length > 0) {
			body.image = refImages
		}

		const response = await requestUrl({
			url: this.baseUrl,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(body),
			throw: false,
		})

		const data = response.json || {}
		if (response.status >= 400) {
			const msg = data?.error?.message || response.text?.substring(0, 300) || `HTTP ${response.status}`
			const code = data?.error?.code || ''
			throw new Error(`Seedream: ${code ? code + ' — ' : ''}${msg}`)
		}
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

		// Save image to vault. Seedream returns JPEG by default, so name the file after the
		// bytes it actually received instead of assuming PNG.
		const binary = Uint8Array.from(atob(imageBase64), c => c.charCodeAt(0))
		const ext = sniffImageMime(binary.buffer) === 'image/jpeg' ? 'jpg' : 'png'
		const timestamp = Date.now()
		const fileName = `img_${timestamp}.${ext}`
		const filePath = `${this.outputDir}/${fileName}`

		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) {
			await adapter.mkdir(this.outputDir)
		}

		await adapter.writeBinary(filePath, binary.buffer)

		return { filePath }
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

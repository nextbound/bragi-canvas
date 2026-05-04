import type { ImageProvider, GenerateImageResult } from './types'
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'

// GPT Image 2 only accepts a fixed set of sizes: 1024x1024, 1024x1536, 1536x1024, auto.
// Sending anything else gets silently coerced by the API (we used to compute arbitrary
// sizes like 2736x1536 which came back as portrait 1024x1536 regardless of aspect ratio).
function resolveSize(aspectRatio: string): string {
	const parts = aspectRatio.split(':').map(Number)
	if (parts.length !== 2 || !parts[0] || !parts[1]) return '1024x1024'
	const ratio = parts[0] / parts[1]
	if (ratio > 1.15) return '1536x1024'   // landscape
	if (ratio < 0.87) return '1024x1536'   // portrait
	return '1024x1024'                     // square
}

export class OpenAIProvider implements ImageProvider {
	name = 'GPT Image'
	private apiKey: string
	private app: App
	private outputDir: string
	private baseUrl: string

	constructor(apiKey: string, app: App, outputDir: string, baseUrl: string = 'https://api.openai.com/v1') {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
		this.baseUrl = baseUrl.replace(/\/$/, '')
	}

	async generateImage(prompt: string, params?: Record<string, any>): Promise<GenerateImageResult> {
		const modelId = params?.modelId || 'gpt-image-2'
		const refImages: string[] = params?.refImages || []
		const quality = params?.quality || 'auto'

		let size: string
		if (params?.size) {
			size = params.size
		} else if (params?.imageSize === 'auto') {
			size = 'auto'
		} else {
			size = resolveSize(params?.aspectRatio || '1:1')
		}

		let b64: string
		if (refImages.length > 0) {
			b64 = await this.editWithRefs(modelId, prompt, size, quality, refImages)
		} else {
			b64 = await this.generate(modelId, prompt, size, quality)
		}

		const imageData = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
		const timestamp = Date.now()
		const fileName = `img_${timestamp}.png`
		const filePath = `${this.outputDir}/${fileName}`

		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) {
			await adapter.mkdir(this.outputDir)
		}
		await adapter.writeBinary(filePath, imageData.buffer)

		return { filePath }
	}

	private async generate(modelId: string, prompt: string, size: string, quality: string): Promise<string> {
		const response = await requestUrl({
			url: `${this.baseUrl}/images/generations`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: modelId,
				prompt,
				size,
				quality,
				n: 1,
			}),
		})
		const data = response.json
		const b64 = data?.data?.[0]?.b64_json
		if (!b64) {
			throw new Error(`OpenAI: No image in response — ${JSON.stringify(data).substring(0, 200)}`)
		}
		return b64
	}

	private async editWithRefs(modelId: string, prompt: string, size: string, quality: string, refImages: string[]): Promise<string> {
		const boundary = '----BragiFormBoundary' + Math.random().toString(36).slice(2)
		const parts: Uint8Array[] = []
		const enc = new TextEncoder()

		const appendField = (name: string, value: string) => {
			parts.push(enc.encode(`--${boundary}\r\n`))
			parts.push(enc.encode(`Content-Disposition: form-data; name="${name}"\r\n\r\n`))
			parts.push(enc.encode(value))
			parts.push(enc.encode('\r\n'))
		}

		const appendFile = (name: string, filename: string, mime: string, bytes: Uint8Array) => {
			parts.push(enc.encode(`--${boundary}\r\n`))
			parts.push(enc.encode(`Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`))
			parts.push(enc.encode(`Content-Type: ${mime}\r\n\r\n`))
			parts.push(bytes)
			parts.push(enc.encode('\r\n'))
		}

		appendField('model', modelId)
		appendField('prompt', prompt)
		appendField('size', size)
		appendField('quality', quality)
		appendField('n', '1')

		for (let i = 0; i < refImages.length; i++) {
			const dataUri = refImages[i]
			const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
			if (!match) continue
			const mime = match[1]
			const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0))
			const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg'
			appendFile('image[]', `ref${i}.${ext}`, mime, bytes)
		}

		parts.push(enc.encode(`--${boundary}--\r\n`))

		let total = 0
		for (const p of parts) total += p.length
		const body = new Uint8Array(total)
		let offset = 0
		for (const p of parts) { body.set(p, offset); offset += p.length }

		const response = await requestUrl({
			url: `${this.baseUrl}/images/edits`,
			method: 'POST',
			headers: {
				'Content-Type': `multipart/form-data; boundary=${boundary}`,
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: body.buffer,
		})
		const data = response.json
		const b64 = data?.data?.[0]?.b64_json
		if (!b64) {
			throw new Error(`OpenAI edit: No image in response — ${JSON.stringify(data).substring(0, 200)}`)
		}
		return b64
	}
}

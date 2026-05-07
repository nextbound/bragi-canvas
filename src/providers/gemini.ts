import type { ImageProvider, GenerateImageResult } from './types'
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import { stringParam } from './params'

export class GeminiProvider implements ImageProvider {
	name = 'Gemini'
	private apiKey: string
	private app: App
	private outputDir: string

	constructor(apiKey: string, app: App, outputDir: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
	}

	async generateImage(prompt: string, params?: Record<string, unknown>): Promise<GenerateImageResult> {
		const modelId = stringParam(params?.modelId, 'gemini-3-pro-image-preview')
		const aspectRatio = params?.aspectRatio || '1:1'
		const imageSize = params?.imageSize || '1K'
		const refImages: string[] = params?.refImages || []

		const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`

		// Build parts: reference images first, then prompt text
		const parts: unknown[] = []
		for (const dataUri of refImages) {
			const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
			if (match) {
				parts.push({
					inlineData: {
						mimeType: match[1],
						data: match[2],
					}
				})
			}
		}
		parts.push({ text: prompt })

		const response = await requestUrl({
			url,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-goog-api-key': this.apiKey,
			},
			body: JSON.stringify({
				contents: [{
					parts,
				}],
				generationConfig: {
					responseModalities: ['TEXT', 'IMAGE'],
					imageConfig: {
						aspectRatio,
						imageSize,
					},
				},
			}),
		})

		const data = response.json

		// Find the image part in the response
		const candidates = data.candidates || []
		let imageBase64: string | null = null
		let mimeType = 'image/png'

		for (const candidate of candidates) {
			const parts = candidate.content?.parts || []
			for (const part of parts) {
				if (part.inlineData?.data) {
					imageBase64 = part.inlineData.data
					mimeType = part.inlineData.mimeType || 'image/png'
					break
				}
			}
			if (imageBase64) break
		}

		if (!imageBase64) {
			throw new Error('No image generated in Gemini response')
		}

		// Save image to vault
		const timestamp = Date.now()
		const ext = mimeType.includes('png') ? 'png' : 'jpg'
		const fileName = `img_${timestamp}.${ext}`
		const filePath = `${this.outputDir}/${fileName}`

		// Ensure output directory exists
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) {
			await adapter.mkdir(this.outputDir)
		}

		// Decode base64 and write
		const binary = Uint8Array.from(atob(imageBase64), c => c.charCodeAt(0))
		await adapter.writeBinary(filePath, binary)

		return { filePath }
	}
}

import type { ImageProvider, GenerateImageResult } from './types'
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import { uploadRef } from './upload'

const VALID_RATIOS = new Set(['1:1', '16:9', '9:16', '3:2', '2:3'])

/**
 * Luma Proxy provider — talks to a self-hosted Luma Uni-1 gateway
 * (https://github.com/simon/luma-proxy, default deploy at https://luma.bragi.now).
 *
 * The proxy handles polling internally and returns the final image URL in one shot.
 * Text-to-image goes to /v1/images/generate; image-ref (single reference) goes to
 * /v1/images/img2img as multipart since upstream refs are in-memory data: URIs.
 */
export class LumaProvider implements ImageProvider {
	name = 'Luma'
	private endpoint: string
	private token: string
	private app: App
	private outputDir: string

	constructor(endpoint: string, token: string, app: App, outputDir: string) {
		this.endpoint = (endpoint || 'https://luma.bragi.now').replace(/\/$/, '')
		this.token = token
		this.app = app
		this.outputDir = outputDir
	}

	async generateImage(prompt: string, params?: Record<string, unknown>): Promise<GenerateImageResult> {
		const refImages: string[] = params?.refImages || []
		const aspectRatio = VALID_RATIOS.has(params?.aspectRatio) ? params.aspectRatio : '1:1'

		const imageUrl = refImages.length > 0
			? await this.img2img(prompt, aspectRatio, refImages[0])
			: await this.text2img(prompt, aspectRatio)

		const bytes = await requestUrl({ url: imageUrl })
		const timestamp = Date.now()
		const fileName = `luma_${timestamp}.png`
		const filePath = `${this.outputDir}/${fileName}`

		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) {
			await adapter.mkdir(this.outputDir)
		}
		await adapter.writeBinary(filePath, bytes.arrayBuffer)
		return { filePath }
	}

	private async text2img(prompt: string, aspectRatio: string): Promise<string> {
		const resp = await requestUrl({
			url: `${this.endpoint}/v1/images/generate`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.token}`,
			},
			body: JSON.stringify({ prompt, aspect_ratio: aspectRatio }),
			throw: false,
		})
		return this.extractUrl(resp)
	}

	private async img2img(prompt: string, aspectRatio: string, refImage: string): Promise<string> {
		// Resolve ref to a public URL. Multipart uploads go through the Luma Proxy on Vercel,
		// which has a ~4.5MB body limit; the Bragi Relay route is more reliable and keeps the
		// proxy request tiny (JSON + URL).
		let imageUrl: string
		if (/^https?:/.test(refImage)) {
			imageUrl = refImage
		} else {
			const match = refImage.match(/^data:([^;]+);base64,(.+)$/)
			if (!match) throw new Error('Luma: unsupported reference image format')
			const mime = match[1]
			const bytes = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0))
			const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg'
			imageUrl = await uploadRef(undefined, bytes.buffer, `ref.${ext}`, mime)
		}

		const resp = await requestUrl({
			url: `${this.endpoint}/v1/images/img2img`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.token}`,
			},
			body: JSON.stringify({ image_url: imageUrl, prompt, aspect_ratio: aspectRatio }),
			throw: false,
		})
		return this.extractUrl(resp)
	}

	private extractUrl(resp: { status: number; text?: string }): string {
		// Parse body defensively — upstream infra (Vercel, Cloudflare) occasionally returns
		// plain-text error pages like "Request Entity Too Large" which would crash resp.json.
		let body: unknown = null
		const rawText = resp.text || ''
		try { body = rawText ? JSON.parse(rawText) : null } catch { body = null }

		if (resp.status === 401) throw new Error('Luma: invalid API key')
		if (resp.status === 413) throw new Error('Luma: reference image too large (upload route exceeded)')
		if (resp.status === 503) throw new Error('Luma: no healthy upstream account (cookie likely expired)')
		if (resp.status === 504) throw new Error('Luma: generation timed out')
		if (resp.status >= 400) {
			const msg = body?.message || body?.error || rawText.substring(0, 200) || `HTTP ${resp.status}`
			throw new Error(`Luma: ${msg}`)
		}
		const url = body?.image_url
		if (!url) throw new Error(`Luma: no image_url in response — ${rawText.substring(0, 200)}`)
		return url
	}
}

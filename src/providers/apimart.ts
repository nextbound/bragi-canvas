import type { ImageProvider, GenerateImageResult } from './types'
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import { stringParam } from './params'

/**
 * APIMart GPT Image 2 provider.
 * Docs:
 *   Non-official (reverse-engineered, cheap): https://docs.apimart.ai/cn/api-reference/images/gpt-image-2/generation
 *   Official (OpenAI passthrough, supports quality + mask): https://docs.apimart.ai/cn/api-reference/images/gpt-image-2/official
 *
 * Both channels share the same async flow:
 *   1. POST /v1/images/generations → { data: [{ task_id, status }] }
 *   2. GET  /v1/tasks/{task_id}    → polls; on "completed" returns result.images[0].url[0]
 *   3. Download that URL and write to the vault.
 *
 * ─── Channel toggle (flip this constant to switch) ──────────────────────
 * Non-official: 'gpt-image-2'            — cheap, fast, no quality/mask
 * Official:     'gpt-image-2-official'   — passthrough to OpenAI, supports quality
 */
// const APIMART_MODEL = 'gpt-image-2-official'  // ← uncomment (and comment the line below) to use the official channel
const APIMART_MODEL = 'gpt-image-2'

const USE_OFFICIAL = APIMART_MODEL === 'gpt-image-2-official'

const API_BASE = 'https://api.apimart.ai/v1'
const POLL_INTERVAL_MS = 3000
const FIRST_POLL_DELAY_MS = 10000
const MAX_WAIT_MS = 300000

async function sleep(ms: number): Promise<void> {
	return new Promise(r => window.setTimeout(r, ms))
}

export class APIMartProvider implements ImageProvider {
	name = 'APIMart GPT Image 2'
	private apiKey: string
	private app: App
	private outputDir: string

	constructor(apiKey: string, app: App, outputDir: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
	}

	async generateImage(prompt: string, params?: Record<string, unknown>): Promise<GenerateImageResult> {
		const refImages: string[] = params?.refImages || []

		const size = stringParam(params?.aspectRatio, '1:1')
		const tier = stringParam(params?.imageSize, '2K')
		const resolution = tier === 'auto' ? '2k' : tier.toLowerCase()

		const body: unknown = {
			model: APIMART_MODEL,
			prompt,
			size,
			resolution,
			n: 1,
		}
		// Quality is only honored by the official channel
		if (USE_OFFICIAL && params?.quality) {
			body.quality = params.quality
		}
		if (refImages.length > 0) {
			body.image_urls = refImages.slice(0, 16)
		}

		// Submit
		const submitResp = await requestUrl({
			url: `${API_BASE}/images/generations`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(body),
		})
		const submitData = submitResp.json
		const first = submitData?.data?.[0]
		if (!first) {
			throw new Error(`APIMart: unexpected submit response — ${JSON.stringify(submitData).substring(0, 200)}`)
		}

		// Some accounts may return the image synchronously (unlikely but supported)
		if (first.b64_json) {
			return this.writeB64(first.b64_json)
		}
		if (first.url) {
			return this.downloadAndWrite(first.url)
		}
		if (!first.task_id) {
			throw new Error(`APIMart: no task_id/url/b64_json in submit response`)
		}

		// Poll
		const imageUrl = await this.poll(first.task_id)
		return this.downloadAndWrite(imageUrl)
	}

	private async poll(taskId: string): Promise<string> {
		await sleep(FIRST_POLL_DELAY_MS)
		const deadline = Date.now() + MAX_WAIT_MS - FIRST_POLL_DELAY_MS

		while (Date.now() < deadline) {
			const resp = await requestUrl({
				url: `${API_BASE}/tasks/${taskId}`,
				method: 'GET',
				headers: { 'Authorization': `Bearer ${this.apiKey}` },
			})
			const data = resp.json?.data
			if (!data) {
				throw new Error(`APIMart: malformed task response — ${JSON.stringify(resp.json).substring(0, 200)}`)
			}
			const status = data.status as string
			if (status === 'completed') {
				const urls: string[] = data.result?.images?.[0]?.url || []
				if (urls.length === 0) {
					throw new Error(`APIMart: completed task has no image URL`)
				}
				return urls[0]
			}
			if (status === 'failed') {
				throw new Error(`APIMart: task failed — ${data.error || data.message || 'no reason provided'}`)
			}
			// pending / in_progress / submitted — keep polling
			await sleep(POLL_INTERVAL_MS)
		}
		throw new Error(`APIMart: timed out after ${MAX_WAIT_MS / 1000}s`)
	}

	private async downloadAndWrite(url: string): Promise<GenerateImageResult> {
		const resp = await requestUrl({ url })
		const bytes = new Uint8Array(resp.arrayBuffer)
		return this.writeBytes(bytes)
	}

	private async writeB64(b64: string): Promise<GenerateImageResult> {
		const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
		return this.writeBytes(bytes)
	}

	private async writeBytes(bytes: Uint8Array): Promise<GenerateImageResult> {
		const timestamp = Date.now()
		const fileName = `img_${timestamp}.png`
		const filePath = `${this.outputDir}/${fileName}`
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) {
			await adapter.mkdir(this.outputDir)
		}
		await adapter.writeBinary(filePath, bytes.buffer)
		return { filePath }
	}
}

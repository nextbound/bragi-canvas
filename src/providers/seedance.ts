import type { VideoProvider, GenerateVideoResult } from './types'
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import { uploadRef } from './upload'

const DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks'

export class SeedanceProvider implements VideoProvider {
	name = 'Seedance'
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

	async generateVideo(prompt: string, params?: Record<string, any>): Promise<GenerateVideoResult> {
		const modelId = params?.modelId || 'doubao-seedance-2-0-260128'
		const duration = parseInt(params?.duration || '5')
		const ratio = params?.ratio || '16:9'
		const resolution = params?.resolution || '720p'
		const refImages: string[] = params?.refImages || []
		const refAudios: string[] = params?.refAudios || []
		const generateAudio = params?.generate_audio !== 'false'

		// Build content array
		const content: any[] = []

		// Add reference images
		for (const dataUri of refImages) {
			let imageUrl = dataUri

			if (dataUri.startsWith('asset://')) {
				// Asset ID — pass through directly (for Seedance face/character reference)
				imageUrl = dataUri
			} else {
				const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
				if (match) {
					// Upload to R2 to get a real URL (data URI too large for API)
					const binary = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0))
					const ext = match[1].includes('png') ? 'png' : 'jpg'
					imageUrl = await uploadRef(undefined, binary.buffer, `ref.${ext}`, match[1])
				}
			}

			content.push({
				type: 'image_url',
				image_url: { url: imageUrl },
				role: 'reference_image',
			})
		}

		// Add reference audios
		for (const audioUrl of refAudios) {
			content.push({
				type: 'audio_url',
				audio_url: { url: audioUrl },
				role: 'reference_audio',
			})
		}

		// Add prompt text
		content.push({ type: 'text', text: prompt })

		// Create task
		const requestBody = {
			model: modelId,
			content,
			duration,
			ratio,
			resolution,
			generate_audio: generateAudio,
			watermark: false,
		}
		const response = await requestUrl({
			url: this.baseUrl,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(requestBody),
			throw: false,
		})

		const data = response.json || {}
		if (response.status >= 400) {
			const msg = data?.error?.message || response.text?.substring(0, 300) || `HTTP ${response.status}`
			const code = data?.error?.code || ''
			throw new Error(`Seedance: ${code ? code + ' — ' : ''}${msg}`)
		}
		if (data.error) {
			throw new Error(`Seedance: ${data.error.code} — ${data.error.message}`)
		}

		const taskId = data.id
		if (!taskId) {
			throw new Error('Seedance: No task ID returned')
		}

		return { done: false, taskId }
	}

	async checkStatus(taskId: string): Promise<GenerateVideoResult> {
		const response = await requestUrl({
			url: `${this.baseUrl}/${taskId}`,
			method: 'GET',
			headers: {
				'Authorization': `Bearer ${this.apiKey}`,
			},
		})

		const data = response.json

		if (data.status === 'succeeded') {
			const videoUrl = data.content?.video_url
			if (!videoUrl) {
				throw new Error('Seedance: No video URL in completed task')
			}

			// Download video to vault
			const filePath = await this.downloadVideo(videoUrl)
			return { done: true, filePath }
		}

		if (data.status === 'failed') {
			throw new Error(`Seedance: Task failed — ${data.error?.message || 'unknown error'}`)
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

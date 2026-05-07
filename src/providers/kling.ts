import type { VideoProvider, GenerateVideoResult } from './types'
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'

const BASE_URL = 'https://api.klingai.com'

export class KlingProvider implements VideoProvider {
	name = 'Kling'
	private ak: string
	private sk: string
	private app: App
	private outputDir: string

	constructor(ak: string, sk: string, app: App, outputDir: string) {
		this.ak = ak
		this.sk = sk
		this.app = app
		this.outputDir = outputDir
	}

	async generateVideo(prompt: string, params?: Record<string, unknown>): Promise<GenerateVideoResult> {
		const modelId = params?.modelId || 'kling-v3'
		const duration = params?.duration || '5'
		const aspectRatio = params?.aspect_ratio || '16:9'
		const quality = params?.mode || 'std'
		const genMode = params?.genMode || null  // user-selected mode from panel
		const refImages: string[] = params?.refImages || []

		const token = await this.getToken()

		let taskId: string

		if (genMode === 'first-last-frame' && refImages.length >= 2) {
			taskId = await this.createImageToVideoTask(token, {
				model_name: modelId,
				prompt,
				image: stripDataUriPrefix(refImages[0]),
				image_tail: stripDataUriPrefix(refImages[1]),
				duration,
				aspect_ratio: aspectRatio,
				mode: 'pro',
			})
		} else if (genMode === 'first-frame' && refImages.length >= 1) {
			taskId = await this.createImageToVideoTask(token, {
				model_name: modelId,
				prompt,
				image: stripDataUriPrefix(refImages[0]),
				duration,
				aspect_ratio: aspectRatio,
				mode: quality,
			})
		} else {
			// Text-to-video
			taskId = await this.createTextToVideoTask(token, {
				model_name: modelId,
				prompt,
				duration,
				aspect_ratio: aspectRatio,
				mode: quality,
			})
		}

		return { done: false, taskId }
	}

	async checkStatus(taskId: string): Promise<GenerateVideoResult> {
		const token = await this.getToken()

		// Try text2video endpoint first, then image2video
		let data: unknown
		const t2vResult = await this.pollTask(token, `/v1/videos/text2video/${taskId}`)
		if (t2vResult?.code === 0) {
			data = t2vResult
		} else {
			const i2vResult = await this.pollTask(token, `/v1/videos/image2video/${taskId}`)
			if (i2vResult?.code === 0) {
				data = i2vResult
			} else {
				throw new Error(`Kling: Cannot find task ${taskId}`)
			}
		}

		const status = data?.data?.task_status
		if (status === 'succeed') {
			const videoUrl = data?.data?.task_result?.videos?.[0]?.url
			if (!videoUrl) throw new Error('Kling: No video URL in result')
			const filePath = await this.downloadVideo(videoUrl)
			return { done: true, filePath }
		}

		if (status === 'failed') {
			throw new Error(`Kling: Task failed — ${data?.data?.task_status_msg || 'unknown'}`)
		}

		return { done: false, taskId }
	}

	private async createTextToVideoTask(token: string, body: unknown): Promise<string> {
		const response = await requestUrl({
			url: `${BASE_URL}/v1/videos/text2video`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${token}`,
			},
			body: JSON.stringify(body),
		})

		const data = response.json
		if (data.code !== 0) {
			throw new Error(`Kling: ${data.message || 'Failed to create task'}`)
		}
		return data.data.task_id
	}

	private async createImageToVideoTask(token: string, body: unknown): Promise<string> {
		const response = await requestUrl({
			url: `${BASE_URL}/v1/videos/image2video`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${token}`,
			},
			body: JSON.stringify(body),
		})

		const data = response.json
		if (data.code !== 0) {
			throw new Error(`Kling: ${data.message || 'Failed to create task'}`)
		}
		return data.data.task_id
	}

	private async pollTask(token: string, path: string): Promise<unknown> {
		const response = await requestUrl({
			url: `${BASE_URL}${path}`,
			method: 'GET',
			headers: { 'Authorization': `Bearer ${token}` },
		})
		return response.json
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

	/**
	 * Generate JWT token from AK/SK (HMAC-SHA256).
	 */
	private async getToken(): Promise<string> {
		const header = { alg: 'HS256', typ: 'JWT' }
		const now = Math.floor(Date.now() / 1000)
		const payload = {
			iss: this.ak,
			exp: now + 1800, // 30 minutes
			nbf: now - 5,
			iat: now,
		}

		const encHeader = base64UrlEncode(JSON.stringify(header))
		const encPayload = base64UrlEncode(JSON.stringify(payload))
		const message = `${encHeader}.${encPayload}`

		// HMAC-SHA256 signing using Web Crypto API (available in Electron)
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(this.sk),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		)
		const signatureBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
		const encSignature = arrayBufferToBase64Url(signatureBuffer)

		const token = `${message}.${encSignature}`
		return token
	}
}

function base64UrlEncode(str: string): string {
	const bytes = new TextEncoder().encode(str)
	let binary = ''
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i])
	}
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')
}

/** Strip data URI prefix, return raw base64. Kling expects plain base64. */
function stripDataUriPrefix(dataUri: string): string {
	const match = dataUri.match(/^data:[^;]+;base64,(.+)$/)
	return match ? match[1] : dataUri
}

function arrayBufferToBase64Url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer)
	let binary = ''
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i])
	}
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '')
}

/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import type { VideoProvider, GenerateVideoResult } from './types'
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import { buildOfficialKlingOmniRequest, KLING_OMNI_MODEL_ID } from './kling-omni-payload'

const BASE_URL = 'https://api.klingai.com'
const OMNI_BASE_URLS = [BASE_URL, 'https://api-beijing.klingai.com'] as const

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
		const refVideos: string[] = params?.refVideos || []
		const characterOrientation = params?.character_orientation || 'video'
		const keepOriginalSound = params?.keep_original_sound || 'yes'

		const token = await this.getToken()

		let taskId: string

		if (modelId === KLING_OMNI_MODEL_ID) {
			taskId = await this.createOmniVideoTask(token, buildOfficialKlingOmniRequest(prompt, params || {}))
		} else if (genMode === 'motion-control' && refImages.length >= 1 && refVideos.length >= 1) {
			// Motion Control: transfer the reference video's motion onto the character image.
			// image_url/video_url accept a public URL or base64; refs are relay https URLs
			// here, and stripDataUriPrefix passes a URL through unchanged.
			taskId = await this.createMotionControlTask(token, {
				model_name: modelId,
				prompt,
				image_url: stripDataUriPrefix(refImages[0]),
				video_url: refVideos[0],
				character_orientation: characterOrientation,
				keep_original_sound: keepOriginalSound,
				mode: quality,
			})
		} else if (genMode === 'first-last-frame' && refImages.length >= 2) {
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

		// The task type isn't tracked, so probe each video endpoint until one resolves.
		const urls = [
			...OMNI_BASE_URLS.map(baseUrl => `${baseUrl}/v1/videos/omni-video/${taskId}`),
			`${BASE_URL}/v1/videos/text2video/${taskId}`,
			`${BASE_URL}/v1/videos/image2video/${taskId}`,
			`${BASE_URL}/v1/videos/motion-control/${taskId}`,
		]
		let data: unknown
		for (const url of urls) {
			const result = await this.pollTask(token, url)
			if (result?.code === 0) {
				data = result
				break
			}
		}
		if (!data) {
			throw new Error(`Kling: Cannot find task ${taskId}`)
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

	private async createMotionControlTask(token: string, body: unknown): Promise<string> {
		// throw:false so a 4xx still returns the body — Kling puts the real reason
		// (e.g. "image orientation requires reference video <= 10s") in `message`.
		const response = await requestUrl({
			url: `${BASE_URL}/v1/videos/motion-control`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${token}`,
			},
			body: JSON.stringify(body),
			throw: false,
		})

		const data = response.json
		if (response.status >= 400 || data?.code !== 0) {
			throw new Error(`Kling: ${data?.message || `Motion Control failed (HTTP ${response.status})`}`)
		}
		return data.data.task_id
	}

	private async createOmniVideoTask(token: string, body: unknown): Promise<string> {
		let lastError = 'Task creation failed'
		for (const baseUrl of OMNI_BASE_URLS) {
			const response = await requestUrl({
				url: `${baseUrl}/v1/videos/omni-video`,
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${token}`,
				},
				body: JSON.stringify(body),
				throw: false,
			})

			const data = response.json
			if (response.status < 400 && data?.code === 0) {
				const taskId = data?.data?.task_id
				if (!taskId) throw new Error('Kling Omni: no task_id in create response')
				return taskId
			}
			lastError = data?.message || `Task creation failed (HTTP ${response.status})`
			const shouldTryNextRegion = response.status === 401
				|| response.status === 404
				|| /access key not found/i.test(lastError)
			if (!shouldTryNextRegion) break
		}
		throw new Error(`Kling Omni: ${lastError}`)
	}

	private async pollTask(token: string, url: string): Promise<unknown> {
		const response = await requestUrl({
			url,
			method: 'GET',
			headers: { 'Authorization': `Bearer ${token}` },
			throw: false,
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

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Resume strict linting after the runtime-shaped data boundary. */

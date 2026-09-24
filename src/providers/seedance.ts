import { writeTaskResult, pollRequest, TaskPollingError, assertPendingStatus } from '../task-errors'
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import type { VideoProvider, GenerateVideoResult } from './types'
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import { uploadRef } from './upload'
import { getSeedanceReferenceLimits, isSeedance25ModelId } from '../seedance-capabilities'
import { normalizeSeedanceEndpoint, VOLCENGINE_SEEDANCE_ENDPOINT } from './seedance-endpoints'

type SeedanceContent =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string }; role: 'first_frame' | 'last_frame' | 'reference_image' }
	| { type: 'audio_url'; audio_url: { url: string }; role: 'reference_audio' }
	| { type: 'video_url'; video_url: { url: string }; role: 'reference_video' }

export interface SeedanceRequestBody {
	model: string
	content: SeedanceContent[]
	duration: number
	ratio: string
	resolution: string
	generate_audio: boolean
	watermark: false
	output_format?: 'mp4' | 'mov'
}

function stringParam(params: Record<string, unknown>, key: string, fallback: string): string {
	const value = params[key]
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean') return `${value}`
	return fallback
}

function stringArrayParam(params: Record<string, unknown>, key: string): string[] {
	const value = params[key]
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function assertSeedanceInputs(
	modelId: string,
	genMode: string,
	duration: number,
	ratio: string,
	resolution: string,
	outputFormat: string,
	refImages: string[],
	refAudios: string[],
	refVideos: string[],
): void {
	const is25 = isSeedance25ModelId(modelId)
	const limits = getSeedanceReferenceLimits(modelId)
	const modelName = is25 ? 'Seedance 2.5' : 'Seedance'
	if (refImages.length > limits.images) throw new Error(`${modelName} supports up to ${limits.images} reference images.`)
	if (refVideos.length > limits.videos) throw new Error(`${modelName} supports up to ${limits.videos} reference videos.`)
	if (refAudios.length > limits.audios) throw new Error(`${modelName} supports up to ${limits.audios} reference audio files.`)

	const supportedModes = is25
		? ['text-to-video', 'first-frame', 'first-last-frame', 'image-ref', 'video-ref', 'video-extend', 'video-edit']
		: ['text-to-video', 'first-frame', 'image-ref', 'video-ref']
	if (!supportedModes.includes(genMode)) throw new Error(`${modelName} does not support ${genMode} mode.`)

	const totalRefs = refImages.length + refAudios.length + refVideos.length
	if (genMode === 'text-to-video' && totalRefs > 0) {
		throw new Error(`${modelName} text-to-video mode does not accept reference media.`)
	}
	if (genMode === 'first-frame' && (refImages.length !== 1 || refAudios.length > 0 || refVideos.length > 0)) {
		throw new Error(`${modelName} first-frame mode requires exactly one image and no other reference media.`)
	}
	if (genMode === 'first-last-frame' && (refImages.length !== 2 || refAudios.length > 0 || refVideos.length > 0)) {
		throw new Error(`${modelName} first-last-frame mode requires exactly two images and no other reference media.`)
	}
	if (genMode === 'image-ref' && refImages.length === 0) {
		throw new Error(`${modelName} image-ref mode requires at least one reference image.`)
	}
	if (genMode === 'video-ref' && (is25 ? totalRefs === 0 : refImages.length + refVideos.length === 0)) {
		throw new Error(`${modelName} video-ref mode requires reference media.`)
	}
	if ((genMode === 'video-edit' || genMode === 'video-extend') && refVideos.length === 0) {
		throw new Error(`${modelName} ${genMode} mode requires at least one reference video.`)
	}

	if (!Number.isInteger(duration) || (duration !== -1 && (duration < 4 || duration > (is25 ? 30 : 15)))) {
		throw new Error(`${modelName} duration must be Auto (-1) or an integer from 4 to ${is25 ? 30 : 15} seconds.`)
	}
	if (is25) {
		const supportedRatios = ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16', '21:9']
		if (!supportedRatios.includes(ratio)) throw new Error(`Seedance 2.5 does not support ratio ${ratio}.`)
		if (['first-frame', 'first-last-frame', 'video-extend', 'video-edit'].includes(genMode) && ratio !== 'adaptive') {
			throw new Error(`Seedance 2.5 ${genMode} mode requires adaptive ratio.`)
		}
		if (genMode === 'video-edit' && duration !== -1) {
			throw new Error('Seedance 2.5 video-edit mode requires Auto (-1) duration.')
		}
		if (!['480p', '720p', '1080p'].includes(resolution)) throw new Error(`Seedance 2.5 does not support ${resolution} output.`)
		if (!['mp4', 'mov'].includes(outputFormat)) throw new Error(`Seedance 2.5 does not support ${outputFormat} output.`)
	}
}

export function buildSeedanceRequestBody(prompt: string, params: Record<string, unknown> = {}): SeedanceRequestBody {
	const modelId = stringParam(params, 'modelId', 'doubao-seedance-2-0-260128')
	const is25 = isSeedance25ModelId(modelId)
	const genMode = stringParam(params, 'genMode', 'text-to-video')
	const duration = Number.parseInt(stringParam(params, 'duration', is25 ? '-1' : '5'), 10)
	const ratio = stringParam(params, 'ratio', is25 ? 'adaptive' : '16:9')
	const resolution = stringParam(params, 'resolution', '720p')
	const outputFormat = stringParam(params, 'output_format', 'mp4')
	const refImages = stringArrayParam(params, 'refImages')
	const refAudios = stringArrayParam(params, 'refAudios')
	const refVideos = stringArrayParam(params, 'refVideos')
	const generateAudio = params.generate_audio !== 'false' && params.generate_audio !== false

	assertSeedanceInputs(modelId, genMode, duration, ratio, resolution, outputFormat, refImages, refAudios, refVideos)
	if (genMode === 'text-to-video' && !prompt.trim()) throw new Error(`${is25 ? 'Seedance 2.5' : 'Seedance'} text-to-video mode requires a prompt.`)

	const content: SeedanceContent[] = []
	if (prompt.trim()) content.push({ type: 'text', text: prompt })

	for (const [index, imageUrl] of refImages.entries()) {
		const role = genMode === 'first-frame'
			? 'first_frame'
			: genMode === 'first-last-frame'
				? index === 0 ? 'first_frame' : 'last_frame'
				: 'reference_image'
		content.push({ type: 'image_url', image_url: { url: imageUrl }, role })
	}
	for (const audioUrl of refAudios) {
		content.push({ type: 'audio_url', audio_url: { url: audioUrl }, role: 'reference_audio' })
	}
	for (const videoUrl of refVideos) {
		content.push({ type: 'video_url', video_url: { url: videoUrl }, role: 'reference_video' })
	}

	const body: SeedanceRequestBody = {
		model: modelId,
		content,
		duration,
		ratio,
		resolution,
		generate_audio: generateAudio,
		watermark: false,
	}
	if (is25) body.output_format = outputFormat as 'mp4' | 'mov'
	return body
}

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
		this.baseUrl = normalizeSeedanceEndpoint(baseUrl, VOLCENGINE_SEEDANCE_ENDPOINT)
	}

	async generateVideo(prompt: string, params?: Record<string, unknown>): Promise<GenerateVideoResult> {
		const requestParams = params || {}
		// Validate before any reference upload so an invalid task cannot create orphaned assets.
		buildSeedanceRequestBody(prompt, requestParams)
		const refImages = stringArrayParam(requestParams, 'refImages')
		const preparedImages: string[] = []

		// Add reference images
		for (const dataUri of refImages) {
			let imageUrl = dataUri

			if (dataUri.startsWith('asset://')) {
				// Asset ID — pass through directly (for Seedance face/character reference)
				imageUrl = dataUri
			} else {
				const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
				if (match) {
					// Upload through the temporary relay to get a public URL.
					const binary = Uint8Array.from(atob(match[2]), c => c.charCodeAt(0))
					const ext = match[1].includes('png') ? 'png' : 'jpg'
					imageUrl = await uploadRef(undefined, binary.buffer, `ref.${ext}`, match[1])
				}
			}

			preparedImages.push(imageUrl)
		}

		const requestBody = buildSeedanceRequestBody(prompt, { ...requestParams, refImages: preparedImages })
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
		const response = await pollRequest({
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
			throw new TaskPollingError(`Seedance: Task failed — ${data.error?.message || 'unknown error'}`, 'terminal')
		}

		// Still processing
		assertPendingStatus(data.status)
		return { done: false, taskId }
	}

	private async downloadVideo(url: string): Promise<string> {
		const response = await pollRequest({ url })
		const timestamp = Date.now()
		let extension = 'mp4'
		try {
			if (new URL(url).pathname.toLowerCase().endsWith('.mov')) extension = 'mov'
		} catch {
			// Provider result URLs are normally absolute; default to MP4 if parsing fails.
		}
		const fileName = `vid_${timestamp}.${extension}`
		const filePath = `${this.outputDir}/${fileName}`

		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) {
			await adapter.mkdir(this.outputDir)
		}

		await writeTaskResult(adapter, filePath, response.arrayBuffer)
		return filePath
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

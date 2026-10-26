import { stringArray } from '../runtime-values'

export const VIDU_Q4_API_MODEL = 'viduq4-preview'

export interface ApimartViduRequest {
	model: typeof VIDU_Q4_API_MODEL
	prompt?: string
	duration: number
	resolution: string
	audio: boolean
	seed?: number
	aspect_ratio?: string
	first_frame_image?: string
	image_with_roles?: { url: string; role: 'reference_image' }[]
	audio_urls?: string[]
}

/** Build explicit frame/reference roles so a single reference is never mistaken for a first frame. */
export function buildApimartViduRequest(prompt: string, params: Record<string, unknown> = {}): ApimartViduRequest {
	const mode = params.genMode ?? 'first-frame'
	if (mode !== 'first-frame' && mode !== 'image-ref') throw new Error('Vidu Q4 Preview supports only first-frame and image-ref modes.')
	const images = stringArray(params.refImages)
	const audios = stringArray(params.refAudios)
	if (stringArray(params.refVideos).length || stringArray(params.refPdfs).length) throw new Error('Vidu Q4 Preview does not accept reference videos or files.')
	if (mode === 'first-frame' && (images.length !== 1 || audios.length)) throw new Error('Vidu Q4 Preview first-frame mode needs exactly one image and no reference audio.')
	if (mode === 'image-ref' && (images.length < 1 || images.length > 15)) throw new Error('Vidu Q4 Preview image-ref mode needs 1 to 15 reference images.')
	if (audios.length > 3) throw new Error('Vidu Q4 Preview accepts at most 3 reference audio clips.')
	if (mode === 'image-ref' && !prompt.trim()) throw new Error('Vidu Q4 Preview image-ref mode requires a prompt.')
	if (prompt.length > 20000) throw new Error('Vidu Q4 Preview prompt must be at most 20000 characters.')
	const duration = Number(params.duration ?? 5)
	if (!Number.isInteger(duration) || duration < 3 || duration > 16) throw new Error('Vidu Q4 Preview duration must be a whole number from 3 to 16 seconds.')
	const resolution = typeof params.resolution === 'string' ? params.resolution.toLowerCase() : params.resolution === undefined ? '720p' : ''
	if (!['540p', '720p', '1080p', '2k', '4k'].includes(resolution)) throw new Error('Vidu Q4 Preview resolution must be 540p, 720p, 1080p, 2K, or 4K.')
	const audio = params.audio ?? true
	if (![true, false, 'true', 'false'].includes(audio as boolean | string)) throw new Error('Vidu Q4 Preview audio must be true or false.')
	const body: ApimartViduRequest = {
		model: VIDU_Q4_API_MODEL, duration, resolution: resolution.endsWith('k') ? resolution.toUpperCase() : resolution,
		audio: audio === true || audio === 'true',
	}
	if (prompt.trim()) body.prompt = prompt.trim()
	if (params.seed !== undefined) {
		const seed = Number(params.seed)
		if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('Vidu Q4 Preview seed must be a non-negative integer; use 0 for random.')
		body.seed = seed
	}
	if (mode === 'first-frame') body.first_frame_image = images[0]
	else {
		const ratio = params.aspect_ratio ?? '16:9'
		if (typeof ratio !== 'string' || !['16:9', '9:16', '1:1', '3:4', '4:3'].includes(ratio)) throw new Error('Vidu Q4 Preview reference ratio must be 16:9, 9:16, 1:1, 3:4, or 4:3.')
		body.aspect_ratio = ratio
		body.image_with_roles = images.map(url => ({ url, role: 'reference_image' }))
		if (audios.length) body.audio_urls = audios
	}
	return body
}

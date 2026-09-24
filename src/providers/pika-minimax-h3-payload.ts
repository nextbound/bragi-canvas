const RATIOS = new Set(['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16'])
const RESOLUTIONS = new Set(['768P', '2K'])
const MODES = new Set(['text-to-video', 'first-frame', 'first-last-frame', 'image-ref', 'video-ref'])

export interface PikaH3Request {
	path: string
	body: Record<string, unknown>
}

function stringParam(value: unknown, fallback: string): string {
	if (typeof value === 'string' && value.trim()) return value.trim()
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	return fallback
}

function references(value: unknown, name: string, max: number): string[] {
	if (value === undefined) return []
	if (!Array.isArray(value) || value.length > max || value.some(item => typeof item !== 'string' || !/^https?:\/\//i.test(item))) {
		throw new Error(`Pika MiniMax-H3 ${name} must contain at most ${max} HTTP(S) reference URLs.`)
	}
	return value
}

function bool(value: unknown): boolean {
	if (value === true || value === 'true') return true
	if (value === false || value === 'false') return false
	throw new Error('Pika MiniMax-H3 watermark must be true or false.')
}

export function buildPikaH3Request(prompt: string, params: Record<string, unknown> = {}): PikaH3Request {
	if (!prompt.trim()) throw new Error('Pika MiniMax-H3 prompt is required.')
	const mode = stringParam(params.genMode, 'text-to-video')
	if (!MODES.has(mode)) throw new Error(`Pika MiniMax-H3 does not support ${mode} mode.`)
	const duration = Number(params.duration ?? 5)
	if (!Number.isInteger(duration) || duration < 4 || duration > 15) {
		throw new Error('Pika MiniMax-H3 duration must be a whole number from 4 to 15 seconds.')
	}
	const resolution = stringParam(params.resolution, '2K').toUpperCase()
	if (!RESOLUTIONS.has(resolution)) throw new Error('Pika MiniMax-H3 resolution must be 768P or 2K.')
	const ratio = stringParam(params.aspect_ratio ?? params.aspectRatio ?? params.ratio, 'adaptive').toLowerCase()
	if (!RATIOS.has(ratio)) throw new Error(`Pika MiniMax-H3 does not support ratio ${ratio}.`)
	const images = references(params.refImages, 'images', 9)
	const videos = references(params.refVideos, 'videos', 3)
	const audios = references(params.refAudios, 'audios', 3)
	if (images.length + videos.length + audios.length > 12) {
		throw new Error('Pika MiniMax-H3 accepts at most 12 reference files in total.')
	}
	const body: Record<string, unknown> = { prompt, duration, resolution }
	if (params.seed !== undefined) {
		const seed = Number(params.seed)
		if (!Number.isInteger(seed) || seed < -1 || seed > 4294967295) {
			throw new Error('Pika MiniMax-H3 seed must be an integer from -1 to 4294967295.')
		}
		body.seed = seed
	}
	const watermark = params.watermark ?? params.aigc_watermark
	if (watermark !== undefined) body.aigc_watermark = bool(watermark)
	if (mode === 'text-to-video') {
		if (images.length + videos.length + audios.length) throw new Error('Pika MiniMax-H3 text-to-video does not accept reference media.')
		body.ratio = ratio === 'adaptive' ? '16:9' : ratio
		return { path: '/v1/media/minimax/h3/text-to-video', body }
	}
	if (mode === 'first-frame' || mode === 'first-last-frame') {
		const expected = mode === 'first-frame' ? 1 : 2
		if (images.length !== expected || videos.length || audios.length) {
			throw new Error(`Pika MiniMax-H3 ${mode} requires exactly ${expected} image${expected === 1 ? '' : 's'} and no video or audio references.`)
		}
		body.first_frame_image = images[0]
		if (expected === 2) body.last_frame_image = images[1]
		return { path: '/v1/media/minimax/h3/image-to-video', body }
	}
	if (mode === 'image-ref' && (!images.length || videos.length)) {
		throw new Error('Pika MiniMax-H3 image-ref requires images and no videos; use video-ref for video references.')
	}
	if (mode === 'video-ref' && (!videos.length && !audios.length)) {
		throw new Error('Pika MiniMax-H3 video-ref requires a video or audio reference.')
	}
	body.ratio = ratio
	if (images.length) body.image_urls = images
	if (videos.length) body.video_urls = videos
	if (audios.length) body.audio_urls = audios
	return { path: '/v1/media/minimax/h3/reference-to-video', body }
}

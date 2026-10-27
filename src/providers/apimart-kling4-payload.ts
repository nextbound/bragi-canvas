import { stringParam } from './params'
import { parseKlingKeyframes } from '../kling-keyframes'

export const KLING4_MODEL_ID = 'kling-v4'
const modes = new Set(['text-to-video', 'first-frame', 'first-last-frame', 'keyframes', 'image-ref', 'video-ref', 'video-edit', 'video-extend'])
const ratios = new Set(['auto', '16:9', '9:16', '1:1', '21:9'])

function refs(value: unknown): string[] {
	if (value === undefined) return []
	if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error('Kling 4.0 references must be non-empty media URLs.')
	return value as string[]
}

export function buildApimartKling4Request(prompt: string, params: Record<string, unknown> = {}): Record<string, unknown> {
	const mode = stringParam(params.genMode, 'text-to-video')
	if (!modes.has(mode)) throw new Error(`Kling 4.0 does not support mode "${mode}".`)
	const images = refs(params.refImages), videos = refs(params.refVideos), audios = refs(params.refAudios)
	if (refs(params.refPdfs).length) throw new Error('Kling 4.0 does not accept PDF references.')
	for (const key of ['multi_shot', 'multi_prompt', 'element_list', 'negative_prompt', 'mode', 'audio', 'sound']) {
		if (params[key] !== undefined) throw new Error(`Kling 4.0 does not support ${key}; every output includes stereo audio.`)
	}
	const frameMode = ['first-frame', 'first-last-frame', 'keyframes'].includes(mode)
	if (!frameMode && !prompt.trim()) throw new Error('Kling 4.0 requires a prompt in this mode.')
	if (mode !== 'keyframes' && /\[\/?keyframes\]/i.test(prompt)) throw new Error('Select Keyframes mode to use a [Keyframes] block.')
	const resolution = stringParam(params.resolution, '720p').toLowerCase()
	if (!['720p', '1080p'].includes(resolution)) throw new Error('Kling 4.0 resolution must be 720p or 1080p.')
	const body: Record<string, unknown> = { model: KLING4_MODEL_ID, resolution }
	if (prompt.trim()) body.prompt = prompt.trim()
	const duration = mode === 'video-edit' ? params.edit_duration ?? params.duration ?? 'source' : params.duration ?? 5
	if (mode !== 'video-edit' || duration !== 'source') {
		const seconds = Number(duration)
		if (!Number.isInteger(seconds) || seconds < 3 || seconds > 30) throw new Error('Kling 4.0 duration must be a whole number from 3 to 30 seconds.')
		body.duration = seconds
	}
	const ratio = stringParam(params.aspect_ratio ?? params.ratio, 'auto')
	if (mode !== 'video-extend') {
		if (!ratios.has(ratio)) throw new Error('Kling 4.0 ratio must be auto, 16:9, 9:16, 1:1, or 21:9.')
		if (mode === 'text-to-video') body.aspect_ratio = ratio === 'auto' ? '16:9' : ratio
		else if (ratio !== 'auto' || mode === 'image-ref' || mode === 'video-ref') body.aspect_ratio = ratio
	}
	if (images.length > 10 || videos.length > 5 || audios.length > 3 || images.length + videos.length + audios.length > 15) throw new Error('Kling 4.0 allows up to ten images, five videos, three audio clips, and fifteen references in total.')
	if (mode === 'text-to-video') {
		if (images.length || videos.length || audios.length) throw new Error('Kling 4.0 text-to-video does not accept reference media; select a reference or frame mode.')
	} else if (frameMode) {
		if (videos.length || audios.length) throw new Error('Kling 4.0 frame modes cannot include reference video or audio.')
		if (mode === 'keyframes') {
			const parsed = parseKlingKeyframes(prompt, images.length)
			body.image_with_roles = parsed.frames.map(frame => ({ url: images[frame.image - 1], role: frame.role }))
			if (parsed.prompt) body.prompt = parsed.prompt
			else delete body.prompt
		} else {
			const count = mode === 'first-frame' ? 1 : 2
			if (images.length !== count) throw new Error(`Kling 4.0 ${mode} requires exactly ${count} connected image${count === 1 ? '' : 's'}.`)
			body.first_frame_image = images[0]
			if (count === 2) body.last_frame_image = images[1]
		}
	} else if (mode === 'video-edit' || mode === 'video-extend') {
		if (videos.length !== 1) throw new Error(`Kling 4.0 ${mode} requires exactly one source video.`)
		if (audios.length) throw new Error('Kling 4.0 edit and extend do not accept reference audio.')
		body.omni_reference_task_type = mode === 'video-edit' ? 'edit' : 'extend'
		body.video_url = videos[0]
		if (mode === 'video-extend') {
			if (images.length > 1) throw new Error('Kling 4.0 extension accepts at most one target last-frame image.')
			if (images.length) body.last_frame_image = images[0]
		} else if (images.length) body.image_urls = images
	} else {
		if (mode === 'image-ref' && (!images.length || videos.length)) throw new Error('Kling 4.0 image-ref requires images and no videos; use video-ref for video or audio-only references.')
		if (mode === 'video-ref' && !videos.length && !audios.length) throw new Error('Kling 4.0 video-ref requires a video or audio reference.')
		body.omni_reference_task_type = 'reference'
		if (images.length) body.image_urls = images
		if (videos.length) body.video_urls = videos
		if (audios.length) body.audio_urls = audios
	}
	if (mode === 'video-edit' || (mode === 'video-ref' && videos.length)) {
		const setting = stringParam(params.audio_setting, 'default')
		if (!['default', 'origin', 'auto'].includes(setting)) throw new Error('Kling 4.0 source audio must be default, origin, or auto.')
		body.audio_setting = setting === 'default' ? mode === 'video-edit' ? 'origin' : 'auto' : setting
	}
	return body
}

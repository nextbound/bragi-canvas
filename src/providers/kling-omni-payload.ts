export const KLING_OMNI_MODEL_ID = 'kling-v3-omni'

type JsonObject = Record<string, unknown>

const VALID_MODES = new Set(['std', 'pro', '4k'])
const VALID_RATIOS = new Set(['16:9', '9:16', '1:1'])

function stringValue(value: unknown, fallback = ''): string {
	return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

function stringList(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
		: []
}

function booleanValue(value: unknown, fallback = false): boolean {
	if (typeof value === 'boolean') return value
	if (value === 'true' || value === 'on' || value === 'yes') return true
	if (value === 'false' || value === 'off' || value === 'no') return false
	return fallback
}

function generationMode(params: JsonObject): string {
	return stringValue(params.genMode, 'text-to-video')
}

function qualityMode(params: JsonObject): string {
	const value = stringValue(params.mode, 'std').toLowerCase()
	if (!VALID_MODES.has(value)) throw new Error('Kling Omni quality must be Standard, Pro, or 4K.')
	return value
}

function durationSeconds(params: JsonObject): number {
	const value = Number(params.duration ?? 5)
	if (!Number.isInteger(value) || value < 3 || value > 15) {
		throw new Error('Kling Omni duration must be a whole number from 3 to 15 seconds.')
	}
	return value
}

function aspectRatio(params: JsonObject): string {
	const value = stringValue(params.aspect_ratio ?? params.aspectRatio ?? params.ratio, '16:9')
	if (!VALID_RATIOS.has(value)) throw new Error('Kling Omni ratio must be 16:9, 9:16, or 1:1.')
	return value
}

function withMissingReferences(prompt: string, kind: 'image' | 'video', count: number): string {
	const missing: string[] = []
	for (let index = 1; index <= count; index++) {
		const token = `<<<${kind}_${index}>>>`
		if (!prompt.includes(token)) missing.push(token)
	}
	return missing.length > 0 ? `${missing.join(' ')} ${prompt}`.trim() : prompt
}

function validateInputs(genMode: string, refImages: string[], refVideos: string[], provider: 'Kling' | 'APIMart'): void {
	if (refVideos.length > 1) throw new Error(`${provider} Kling Omni supports at most one reference video.`)

	if (genMode === 'text-to-video' && (refImages.length > 0 || refVideos.length > 0)) {
		throw new Error(`${provider} Kling Omni text-to-video does not accept upstream media; choose a reference mode.`)
	}
	if (genMode === 'first-frame' && (refImages.length !== 1 || refVideos.length > 0)) {
		throw new Error(`${provider} Kling Omni first-frame mode requires exactly one image and no video.`)
	}
	if (genMode === 'first-last-frame' && (refImages.length !== 2 || refVideos.length > 0)) {
		throw new Error(`${provider} Kling Omni first-last-frame mode requires exactly two images and no video.`)
	}
	if ((genMode === 'image-ref' || genMode === 'multi-image-ref') && (refImages.length < 1 || refVideos.length > 0)) {
		throw new Error(`${provider} Kling Omni image reference mode requires images and no video.`)
	}
	if ((genMode === 'video-ref' || genMode === 'video-edit') && refVideos.length !== 1) {
		throw new Error(`${provider} Kling Omni ${genMode} mode requires exactly one reference video.`)
	}
	if (!['text-to-video', 'first-frame', 'first-last-frame', 'image-ref', 'multi-image-ref', 'video-ref', 'video-edit'].includes(genMode)) {
		throw new Error(`${provider} Kling Omni does not support ${genMode} mode.`)
	}
}

function applyAdvancedOptions(body: JsonObject, params: JsonObject, allowMultiShot: boolean): void {
	const multiShot = allowMultiShot && booleanValue(params.multi_shot)
	body.multi_shot = multiShot
	if (multiShot) {
		const shotType = stringValue(params.shot_type, 'intelligence')
		if (shotType !== 'intelligence' && shotType !== 'customize') {
			throw new Error('Kling Omni shot type must be intelligence or customize.')
		}
		body.shot_type = shotType
		if (shotType === 'customize') {
			if (!Array.isArray(params.multi_prompt) || params.multi_prompt.length < 1 || params.multi_prompt.length > 6) {
				throw new Error('Kling Omni custom multi-shot requires 1 to 6 shot prompts.')
			}
			body.multi_prompt = params.multi_prompt
		}
	}
	if (Array.isArray(params.element_list) && params.element_list.length > 0) {
		body.element_list = params.element_list
	}
}

export function buildOfficialKlingOmniRequest(prompt: string, params: JsonObject = {}): JsonObject {
	const genMode = generationMode(params)
	const refImages = stringList(params.refImages)
	const refVideos = stringList(params.refVideos)
	validateInputs(genMode, refImages, refVideos, 'Kling')

	if (refImages.length > (refVideos.length > 0 ? 4 : 7)) {
		throw new Error(`Kling Omni supports at most ${refVideos.length > 0 ? 4 : 7} reference images for this input.`)
	}

	let finalPrompt = prompt
	const body: JsonObject = {
		model_name: KLING_OMNI_MODEL_ID,
		mode: qualityMode(params),
		watermark_info: { enabled: booleanValue(params.watermark) },
	}

	if (genMode === 'first-frame') {
		body.image_list = [{ image_url: refImages[0], type: 'first_frame' }]
	} else if (genMode === 'first-last-frame') {
		body.image_list = [
			{ image_url: refImages[0], type: 'first_frame' },
			{ image_url: refImages[1], type: 'end_frame' },
		]
	} else if (genMode === 'image-ref' || genMode === 'multi-image-ref') {
		body.image_list = refImages.map(imageUrl => ({ image_url: imageUrl }))
		finalPrompt = withMissingReferences(finalPrompt, 'image', refImages.length)
	} else if (genMode === 'video-ref') {
		body.video_list = [{
			video_url: refVideos[0],
			refer_type: 'feature',
			keep_original_sound: stringValue(params.keep_original_sound, 'no'),
		}]
		if (refImages.length > 0) {
			body.image_list = refImages.map(imageUrl => ({ image_url: imageUrl }))
			finalPrompt = withMissingReferences(finalPrompt, 'image', refImages.length)
		}
		finalPrompt = withMissingReferences(finalPrompt, 'video', 1)
	} else if (genMode === 'video-edit') {
		body.video_list = [{
			video_url: refVideos[0],
			refer_type: 'base',
			keep_original_sound: stringValue(params.keep_original_sound, 'no'),
		}]
		if (refImages.length > 0) {
			body.image_list = refImages.map(imageUrl => ({ image_url: imageUrl }))
			finalPrompt = withMissingReferences(finalPrompt, 'image', refImages.length)
		}
	}

	body.prompt = finalPrompt
	const hasFirstFrame = genMode === 'first-frame' || genMode === 'first-last-frame'
	if (genMode !== 'video-edit') body.duration = String(durationSeconds(params))
	if (!hasFirstFrame && genMode !== 'video-edit') body.aspect_ratio = aspectRatio(params)
	body.sound = refVideos.length > 0 ? 'off' : stringValue(params.sound, 'off')
	applyAdvancedOptions(body, params, genMode !== 'video-edit')
	return body
}

export function buildApimartKlingOmniRequest(prompt: string, params: JsonObject = {}): JsonObject {
	const genMode = generationMode(params)
	const refImages = stringList(params.refImages)
	const refVideos = stringList(params.refVideos)
	validateInputs(genMode, refImages, refVideos, 'APIMart')

	if (refImages.length > 7) throw new Error('APIMart Kling Omni supports at most 7 reference images.')
	if (genMode === 'video-ref' && refImages.length > 1) {
		throw new Error('APIMart Kling Omni feature-video mode supports at most one first-frame image.')
	}

	let finalPrompt = prompt
	const body: JsonObject = {
		model: KLING_OMNI_MODEL_ID,
		mode: qualityMode(params),
		watermark: booleanValue(params.watermark),
	}

	const negativePrompt = stringValue(params.negative_prompt)
	if (negativePrompt) body.negative_prompt = negativePrompt

	if (genMode === 'first-frame') {
		body.image_with_roles = [{ url: refImages[0], role: 'first_frame' }]
	} else if (genMode === 'first-last-frame') {
		body.image_with_roles = [
			{ url: refImages[0], role: 'first_frame' },
			{ url: refImages[1], role: 'last_frame' },
		]
	} else if (genMode === 'image-ref' || genMode === 'multi-image-ref') {
		body.image_urls = refImages
		finalPrompt = withMissingReferences(finalPrompt, 'image', refImages.length)
	} else if (genMode === 'video-ref') {
		body.video_list = [{
			video_url: refVideos[0],
			refer_type: 'feature',
			keep_original_sound: stringValue(params.keep_original_sound, 'no'),
		}]
		if (refImages.length === 1) body.image_with_roles = [{ url: refImages[0], role: 'first_frame' }]
		finalPrompt = withMissingReferences(finalPrompt, 'video', 1)
	} else if (genMode === 'video-edit') {
		body.video_list = [{
			video_url: refVideos[0],
			refer_type: 'base',
			keep_original_sound: stringValue(params.keep_original_sound, 'no'),
		}]
		if (refImages.length > 0) {
			body.image_urls = refImages
			finalPrompt = withMissingReferences(finalPrompt, 'image', refImages.length)
		}
	}

	body.prompt = finalPrompt
	const hasFirstFrame = genMode === 'first-frame' || genMode === 'first-last-frame' || (genMode === 'video-ref' && refImages.length === 1)
	if (genMode !== 'video-edit') body.duration = durationSeconds(params)
	if (!hasFirstFrame && genMode !== 'video-edit') body.aspect_ratio = aspectRatio(params)
	if (refVideos.length === 0) body.audio = stringValue(params.sound, 'off') === 'on'
	applyAdvancedOptions(body, params, genMode !== 'video-edit')
	return body
}

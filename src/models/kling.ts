import type { ModelConfig, ModelParam } from './types'

// Modes where duration / aspect ratio are user-selectable. Motion Control is
// excluded: its output length is dictated by character_orientation (image = 5s,
// video = matches the reference clip) and its framing comes from the inputs.
const KLING_FRAMED_MODES = ['text-to-video', 'first-frame', 'first-last-frame'] as const

const KLING_PARAMS: ModelParam[] = [
	{
		id: 'duration',
		label: 'Duration',
		type: 'select',
		modes: [...KLING_FRAMED_MODES],
		options: [
			{ label: '5s', value: '5' },
			{ label: '10s', value: '10' },
		],
		default: '5',
	},
	{
		id: 'aspect_ratio',
		label: 'Ratio',
		type: 'select',
		modes: [...KLING_FRAMED_MODES],
		options: [
			{ label: '16:9', value: '16:9' },
			{ label: '9:16', value: '9:16' },
			{ label: '1:1', value: '1:1' },
		],
		default: '16:9',
	},
	{
		id: 'character_orientation',
		label: 'Orientation',
		type: 'select',
		modes: ['motion-control'],
		options: [
			{ label: 'Follow Video', value: 'video' },
			{ label: 'Follow Image', value: 'image' },
		],
		default: 'video',
	},
	{
		id: 'keep_original_sound',
		label: 'Audio',
		type: 'select',
		modes: ['motion-control'],
		options: [
			{ label: 'Keep Sound', value: 'yes' },
			{ label: 'Mute', value: 'no' },
		],
		default: 'yes',
	},
	{
		id: 'mode',
		label: 'Quality',
		type: 'select',
		options: [
			{ label: 'Standard', value: 'std' },
			{ label: 'Pro', value: 'pro' },
		],
		default: 'std',
	},
]

export const kling3: ModelConfig = {
	id: 'kling-3.0',
	name: 'Kling 3.0',
	type: 'video',
	supportedProviders: {
		// Motion Control is implemented only against the native Kling API.
		kling: { apiModelId: 'kling-v3' },
		fal: { apiModelId: 'fal-ai/kling-video/v3/pro', modes: ['text-to-video', 'first-frame', 'first-last-frame'] },
		tokenrouter: { apiModelId: 'kling-v3', modes: ['text-to-video', 'first-frame', 'first-last-frame'] },
		// Gateway routes to fal kling reference-to-video — requires a reference image.
		svnewapi: { apiModelId: 'sv-video-kling-fal', modes: ['first-frame'] },
	},
	// T2V + first-frame (image→video) + first-last-frame (start+end keyframe)
	// + motion-control (character image + reference motion video, V3.0 only)
	modes: ['text-to-video', 'first-frame', 'first-last-frame', 'motion-control'],
	params: KLING_PARAMS,
}

export const kling26: ModelConfig = {
	id: 'kling-2.6',
	name: 'Kling 2.6',
	type: 'video',
	supportedProviders: {
		kling: { apiModelId: 'kling-v2-6' },
		tokenrouter: { apiModelId: 'kling-v2-6' },
	},
	modes: ['text-to-video', 'first-frame', 'first-last-frame'],
	params: KLING_PARAMS,
}

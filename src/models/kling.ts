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

const KLING_OMNI_TIMED_MODES = ['text-to-video', 'first-frame', 'first-last-frame', 'image-ref', 'video-ref'] as const
const KLING_OMNI_RATIO_MODES = ['text-to-video', 'image-ref', 'video-ref'] as const

const KLING_OMNI_PARAMS: ModelParam[] = [
	{
		id: 'duration',
		label: 'Duration',
		type: 'range',
		modes: [...KLING_OMNI_TIMED_MODES],
		default: 5,
		min: 3,
		max: 15,
		step: 1,
		unit: 's',
	},
	{
		id: 'aspect_ratio',
		label: 'Ratio',
		type: 'select',
		modes: [...KLING_OMNI_RATIO_MODES],
		options: [
			{ label: '16:9', value: '16:9' },
			{ label: '9:16', value: '9:16' },
			{ label: '1:1', value: '1:1' },
		],
		default: '16:9',
	},
	{
		id: 'mode',
		label: 'Quality',
		type: 'select',
		options: [
			{ label: 'Standard', value: 'std' },
			{ label: 'Pro', value: 'pro' },
			{ label: '4K', value: '4k' },
		],
		default: 'std',
	},
	{
		id: 'sound',
		label: 'Audio',
		type: 'select',
		modes: ['text-to-video', 'first-frame', 'first-last-frame', 'image-ref'],
		options: [
			{ label: 'Audio Off', value: 'off' },
			{ label: 'Audio On', value: 'on' },
		],
		default: 'off',
	},
	{
		id: 'multi_shot',
		label: 'Shots',
		type: 'select',
		modes: [...KLING_OMNI_TIMED_MODES],
		options: [
			{ label: 'Multi shots', value: 'true' },
			{ label: 'Single shot', value: 'false' },
		],
		default: 'true',
	},
	{
		id: 'keep_original_sound',
		label: 'Source Audio',
		type: 'select',
		modes: ['video-ref', 'video-edit'],
		options: [
			{ label: 'Mute', value: 'no' },
			{ label: 'Keep', value: 'yes' },
		],
		default: 'no',
	},
]

export const kling3: ModelConfig = {
	id: 'kling-3.0',
	name: 'Kling 3.0',
	type: 'video',
	supportedProviders: {
		kling: { apiModelId: 'kling-v3' },
		// APIMart exposes Kling only via its Motion Control endpoint.
		apimart: { apiModelId: 'kling-v3-motion-control', modes: ['motion-control'] },
		fal: { apiModelId: 'fal-ai/kling-video/v3/pro', modes: ['text-to-video', 'first-frame', 'first-last-frame'] },
		tokenrouter: { apiModelId: 'kling-v3', modes: ['text-to-video', 'first-frame', 'first-last-frame'] },
		// Gateway routes to fal Kling v3 Pro for regular Kling 3.0 modes.
		svnewapi: { apiModelId: 'sv-kling-3.0', modes: ['text-to-video', 'first-frame', 'first-last-frame'] },
	},
	// T2V + first-frame (image→video) + first-last-frame (start+end keyframe)
	// + motion-control (character image + reference motion video, V3.0 only)
	modes: ['text-to-video', 'first-frame', 'first-last-frame', 'motion-control'],
	params: KLING_PARAMS,
}

export const klingOmni3: ModelConfig = {
	id: 'kling-3.0-omni',
	name: 'Kling 3.0 Omni',
	type: 'video',
	supportedProviders: {
		kling: { apiModelId: 'kling-v3-omni' },
		apimart: { apiModelId: 'kling-v3-omni' },
	},
	modes: ['text-to-video', 'first-frame', 'first-last-frame', 'image-ref', 'video-ref', 'video-edit'],
	params: KLING_OMNI_PARAMS,
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

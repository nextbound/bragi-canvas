import type { ModelConfig } from './types'

const KLING_PARAMS = [
	{
		id: 'duration',
		label: 'Duration',
		type: 'select' as const,
		options: [
			{ label: '5s', value: '5' },
			{ label: '10s', value: '10' },
		],
		default: '5',
	},
	{
		id: 'aspect_ratio',
		label: 'Ratio',
		type: 'select' as const,
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
		type: 'select' as const,
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
		kling: { apiModelId: 'kling-v3' },
		fal: { apiModelId: 'fal-ai/kling-video/v3/pro' },
		tokenrouter: { apiModelId: 'kling-v3' },
		// Gateway routes to fal kling reference-to-video — requires a reference image.
		svnewapi: { apiModelId: 'sv-video-kling-fal', modes: ['first-frame'] },
	},
	// T2V + first-frame (image→video) + first-last-frame (start+end keyframe)
	modes: ['text-to-video', 'first-frame', 'first-last-frame'],
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

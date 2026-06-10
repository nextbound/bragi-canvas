import type { ModelConfig } from './types'

const VEO_PARAMS = [
	{
		id: 'durationSeconds',
		label: 'Duration',
		type: 'select' as const,
		options: [
			{ label: '4s', value: '4' },
			{ label: '6s', value: '6' },
			{ label: '8s', value: '8' },
		],
		default: '6',
	},
	{
		id: 'aspectRatio',
		label: 'Ratio',
		type: 'select' as const,
		options: [
			{ label: '16:9', value: '16:9' },
			{ label: '9:16', value: '9:16' },
		],
		default: '16:9',
	},
	{
		id: 'resolution',
		label: 'Resolution',
		type: 'select' as const,
		options: [
			{ label: '720p', value: '720p' },
			{ label: '1080p', value: '1080p' },
		],
		default: '720p',
	},
]

export const veo31: ModelConfig = {
	id: 'veo-3.1',
	name: 'Veo 3.1',
	type: 'video',
	supportedProviders: {
		gemini: { apiModelId: 'veo-3.1-generate-preview' },
		fal: { apiModelId: 'fal-ai/veo3.1' },
		svnewapi: { apiModelId: 'sv-video-veo-fal', modes: ['text-to-video', 'first-frame'] },
	},
	modes: ['text-to-video', 'first-frame', 'first-last-frame', 'image-ref'],
	params: VEO_PARAMS,
}

export const veo31Lite: ModelConfig = {
	id: 'veo-3.1-lite',
	name: 'Veo 3.1 Lite',
	type: 'video',
	supportedProviders: {
		gemini: { apiModelId: 'veo-3.1-lite-generate-preview' },
	},
	modes: ['text-to-video', 'first-frame'],
	params: VEO_PARAMS,
}

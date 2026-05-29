import type { ModelConfig } from './types'

export const omniFlashExt: ModelConfig = {
	id: 'omni-flash-ext',
	name: 'Omni-Flash-Ext',
	type: 'video',
	supportedProviders: {
		apimart: { apiModelId: 'Omni-Flash-Ext' },
	},
	modes: ['text-to-video', 'first-frame', 'multi-image-ref', 'video-ref'],
	params: [
		{
			id: 'duration',
			label: 'Duration',
			type: 'select',
			options: [
				{ label: '4s', value: '4' },
				{ label: '6s', value: '6' },
				{ label: '8s', value: '8' },
				{ label: '10s', value: '10' },
			],
			default: '6',
		},
		{
			id: 'resolution',
			label: 'Resolution',
			type: 'select',
			options: [
				{ label: '720p', value: '720p' },
				{ label: '1080p', value: '1080p' },
				{ label: '4K', value: '4k' },
			],
			default: '720p',
		},
		{
			id: 'aspect_ratio',
			label: 'Ratio',
			type: 'select',
			options: [
				{ label: '16:9', value: '16:9' },
				{ label: '9:16', value: '9:16' },
			],
			default: '16:9',
		},
	],
}

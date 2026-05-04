import type { ModelConfig } from './types'

export const grokImagine: ModelConfig = {
	id: 'grok-imagine',
	name: 'Grok Imagine',
	type: 'image',
	supportedProviders: {
		fal: { apiModelId: 'xai/grok-imagine-image' },
	},
	modes: ['text-to-image'],
	params: [
		{
			id: 'aspectRatio',
			label: 'Aspect Ratio',
			type: 'select',
			options: [
				{ label: '1:1', value: '1:1' },
				{ label: '16:9', value: '16:9' },
				{ label: '9:16', value: '9:16' },
				{ label: '4:3', value: '4:3' },
				{ label: '3:4', value: '3:4' },
				{ label: '3:2', value: '3:2' },
				{ label: '2:3', value: '2:3' },
				{ label: '2:1', value: '2:1' },
				{ label: '1:2', value: '1:2' },
				{ label: '20:9', value: '20:9' },
				{ label: '9:20', value: '9:20' },
			],
			default: '1:1',
		},
		{
			id: 'resolution',
			label: 'Resolution',
			type: 'select',
			options: [
				{ label: '1K', value: '1k' },
				{ label: '2K', value: '2k' },
			],
			default: '1k',
		},
	],
}

export const grokVideo: ModelConfig = {
	id: 'grok-video',
	name: 'Grok Video',
	type: 'video',
	supportedProviders: {
		fal: { apiModelId: 'xai/grok-imagine-video' },
	},
	modes: ['text-to-video', 'first-frame', 'image-ref', 'video-extend'],
	params: [
		{
			id: 'duration',
			label: 'Duration',
			type: 'select',
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
			options: [
				{ label: '16:9', value: '16:9' },
				{ label: '9:16', value: '9:16' },
				{ label: '1:1', value: '1:1' },
				{ label: '4:3', value: '4:3' },
				{ label: '3:4', value: '3:4' },
				{ label: '3:2', value: '3:2' },
				{ label: '2:3', value: '2:3' },
			],
			default: '16:9',
		},
		{
			id: 'resolution',
			label: 'Resolution',
			type: 'select',
			options: [
				{ label: '480p', value: '480p' },
				{ label: '720p', value: '720p' },
			],
			default: '720p',
		},
	],
}

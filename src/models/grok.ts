import type { ModelConfig } from './types'

const GROK_IMAGE_RATIOS = [
	{ label: '1:1', value: '1:1' },
	{ label: '16:9', value: '16:9' },
	{ label: '9:16', value: '9:16' },
	{ label: '4:3', value: '4:3' },
	{ label: '3:4', value: '3:4' },
	{ label: '3:2', value: '3:2' },
	{ label: '2:3', value: '2:3' },
	{ label: '2:1', value: '2:1' },
	{ label: '1:2', value: '1:2' },
]

export const grokImagine: ModelConfig = {
	id: 'grok-imagine',
	name: 'Grok Imagine',
	type: 'image',
	supportedProviders: {
		// Default apiModelId is the quality tier; XAIImageProvider overrides based on the `quality` param.
		xai: { apiModelId: 'grok-imagine-image-quality' },
		fal: { apiModelId: 'xai/grok-imagine-image' },
	},
	modes: ['text-to-image', 'image-ref-to-image'],
	params: [
		{
			id: 'aspectRatio',
			label: 'Aspect Ratio',
			type: 'select',
			options: GROK_IMAGE_RATIOS,
			default: '1:1',
		},
		{
			id: 'quality',
			label: 'Quality',
			type: 'select',
			options: [
				{ label: 'Quality', value: 'quality' },
				{ label: 'Normal', value: 'normal' },
			],
			default: 'quality',
		},
	],
}

export const grokVideo: ModelConfig = {
	id: 'grok-video',
	name: 'Grok Video',
	type: 'video',
	supportedProviders: {
		xai: { apiModelId: 'grok-imagine-video' },
		fal: { apiModelId: 'xai/grok-imagine-video' },
		// Gateway routes to fal grok image-to-video — requires a source image.
		svnewapi: { apiModelId: 'sv-video-grok-fal', modes: ['first-frame'] },
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
				{ label: '15s', value: '15' },
			],
			// xAI caps image-ref at 10s; other modes allow 15s.
			optionsByMode: {
				'image-ref': [
					{ label: '5s', value: '5' },
					{ label: '10s', value: '10' },
				],
			},
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
				{ label: '1080p', value: '1080p' },
			],
			default: '720p',
		},
	],
}

import type { ModelConfig } from './types'

const FULL_ASPECT_RATIOS = [
	{ label: '1:1', value: '1:1' },
	{ label: '16:9', value: '16:9' },
	{ label: '9:16', value: '9:16' },
	{ label: '3:2', value: '3:2' },
	{ label: '2:3', value: '2:3' },
	{ label: '4:3', value: '4:3' },
	{ label: '3:4', value: '3:4' },
	{ label: '4:5', value: '4:5' },
	{ label: '5:4', value: '5:4' },
	{ label: '21:9', value: '21:9' },
	{ label: '1:4', value: '1:4' },
	{ label: '4:1', value: '4:1' },
	{ label: '1:8', value: '1:8' },
	{ label: '8:1', value: '8:1' },
]

const PRO_ASPECT_RATIOS = FULL_ASPECT_RATIOS.filter(
	(ratio) => !['1:4', '4:1', '1:8', '8:1'].includes(ratio.value),
)

export const nanoBananaPro: ModelConfig = {
	id: 'nano-banana-pro',
	name: 'Nano Banana Pro',
	type: 'image',
	supportedProviders: {
		gemini: { apiModelId: 'gemini-3-pro-image-preview' },
		fal: { apiModelId: 'fal-ai/nano-banana-pro' },
		tokenrouter: { apiModelId: 'google/gemini-3-pro-image-preview' },
		apimart: { apiModelId: 'gemini-3-pro-image-preview' },
		svnewapi: { apiModelId: 'sv-image-banana-pro' },
	},
	modes: ['text-to-image'],
	params: [
		{
			id: 'aspectRatio',
			label: 'Aspect Ratio',
			type: 'select',
			options: PRO_ASPECT_RATIOS,
			default: '1:1',
		},
		{
			id: 'imageSize',
			label: 'Size',
			type: 'select',
			options: [
				{ label: '1K', value: '1K' },
				{ label: '2K', value: '2K' },
				{ label: '4K', value: '4K' },
			],
			default: '1K',
		},
	],
}

export const nanoBanana2: ModelConfig = {
	id: 'nano-banana-2',
	name: 'Nano Banana 2',
	type: 'image',
	supportedProviders: {
		gemini: { apiModelId: 'gemini-3.1-flash-image-preview' },
		fal: { apiModelId: 'fal-ai/nano-banana-2' },
		tokenrouter: { apiModelId: 'google/gemini-3.1-flash-image-preview' },
		apimart: { apiModelId: 'gemini-3.1-flash-image-preview' },
	},
	modes: ['text-to-image'],
	params: [
		{
			id: 'aspectRatio',
			label: 'Aspect Ratio',
			type: 'select',
			options: FULL_ASPECT_RATIOS,
			default: '1:1',
		},
		{
			id: 'imageSize',
			label: 'Size',
			type: 'select',
			options: [
				{ label: '512', value: '512' },
				{ label: '1K', value: '1K' },
				{ label: '2K', value: '2K' },
				{ label: '4K', value: '4K' },
			],
			default: '1K',
		},
	],
}

import type { ModelConfig } from './types'

const SEEDREAM_RATIOS = [
	{ label: '1:1', value: '1:1' },
	{ label: '16:9', value: '16:9' },
	{ label: '9:16', value: '9:16' },
	{ label: '3:2', value: '3:2' },
	{ label: '2:3', value: '2:3' },
	{ label: '4:3', value: '4:3' },
	{ label: '3:4', value: '3:4' },
	{ label: '21:9', value: '21:9' },
]

export const seedream5: ModelConfig = {
	id: 'seedream-5.0',
	name: 'Seedream 5.0',
	type: 'image',
	supportedProviders: {
		bytedance: { apiModelId: 'doubao-seedream-5-0-260128' },
	},
	modes: ['text-to-image'],
	params: [
		{
			id: 'aspectRatio',
			label: 'Aspect Ratio',
			type: 'select',
			options: SEEDREAM_RATIOS,
			default: '1:1',
		},
		{
			id: 'resolution',
			label: 'Resolution',
			type: 'select',
			options: [
				{ label: '2K', value: '2K' },
				{ label: '3K', value: '3K' },
			],
			default: '2K',
		},
	],
}

export const seedream5Lite: ModelConfig = {
	id: 'seedream-5.0-lite',
	name: 'Seedream 5.0 Lite',
	type: 'image',
	supportedProviders: {
		bytedance: { apiModelId: 'doubao-seedream-5-0-lite-260128' },
		byteplus: { apiModelId: 'seedream-5-0-lite-260128' },
		svnewapi: { apiModelId: 'sv-image-seedream-lite' },
	},
	modes: ['text-to-image'],
	params: [
		{
			id: 'aspectRatio',
			label: 'Aspect Ratio',
			type: 'select',
			options: SEEDREAM_RATIOS,
			default: '1:1',
		},
		{
			id: 'resolution',
			label: 'Resolution',
			type: 'select',
			options: [
				{ label: '2K', value: '2K' },
				{ label: '3K', value: '3K' },
				{ label: '4K', value: '4K' },
			],
			default: '2K',
		},
	],
}

export const seedream45: ModelConfig = {
	id: 'seedream-4.5',
	name: 'Seedream 4.5',
	type: 'image',
	supportedProviders: {
		bytedance: { apiModelId: 'doubao-seedream-4-5-251128' },
		tokenrouter: { apiModelId: 'bytedance-seed/seedream-4.5' },
	},
	modes: ['text-to-image'],
	params: [
		{
			id: 'aspectRatio',
			label: 'Aspect Ratio',
			type: 'select',
			options: SEEDREAM_RATIOS,
			default: '1:1',
		},
		{
			id: 'resolution',
			label: 'Resolution',
			type: 'select',
			options: [
				{ label: '2K', value: '2K' },
				{ label: '4K', value: '4K' },
			],
			default: '2K',
		},
	],
}

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

// Seedream 5.0 Pro / Flash accept 1K–2K output only (total pixels 921,600–4,624,220).
// 1.5K costs the same as 1K upstream and renders better, so it sits between the two.
const SEEDREAM_5_PRO_FLASH_RESOLUTIONS = [
	{ label: '1K', value: '1K' },
	{ label: '1.5K', value: '1.5K' },
	{ label: '2K', value: '2K' },
]

/**
 * Seedream 5.0 Pro — single-image generation from text plus up to 10 reference
 * images. Pro and Flash reject `sequential_image_generation` and streaming, and
 * only Pro accepts the `fast` prompt-optimization mode, so each is its own
 * catalog entry rather than a variant switch. Both Volcengine and BytePlus accept
 * a custom inference endpoint (`ep-...`) in place of the model ID, so the ID is
 * editable on both providers.
 */
export const seedream5Pro: ModelConfig = {
	id: 'seedream-5.0-pro',
	name: 'Seedream 5.0 Pro',
	type: 'image',
	supportedProviders: {
		bytedance: { apiModelId: 'doubao-seedream-5-0-pro-260628', editableApiModelId: true },
		byteplus: { apiModelId: 'dola-seedream-5-0-pro-260628', editableApiModelId: true },
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
			options: SEEDREAM_5_PRO_FLASH_RESOLUTIONS,
			default: '2K',
		},
		{
			id: 'optimizeMode',
			label: 'Speed',
			type: 'select',
			options: [
				{ label: 'Standard', value: 'standard' },
				{ label: 'Fast', value: 'fast' },
			],
			default: 'standard',
		},
	],
}

/** Seedream 5.0 Flash — the low-latency sibling of Pro; standard prompt optimization only. */
export const seedream5Flash: ModelConfig = {
	id: 'seedream-5.0-flash',
	name: 'Seedream 5.0 Flash',
	type: 'image',
	supportedProviders: {
		bytedance: { apiModelId: 'doubao-seedream-5-0-flash-260915', editableApiModelId: true },
		byteplus: { apiModelId: 'dola-seedream-5-0-flash-260915', editableApiModelId: true },
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
			options: SEEDREAM_5_PRO_FLASH_RESOLUTIONS,
			default: '2K',
		},
	],
}

export const seedream5: ModelConfig = {
	id: 'seedream-5.0',
	name: 'Seedream 5.0',
	type: 'image',
	supportedProviders: {
		bytedance: { apiModelId: 'doubao-seedream-5-0-260128', editableApiModelId: true },
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
		bytedance: { apiModelId: 'doubao-seedream-5-0-lite-260128', editableApiModelId: true },
		byteplus: { apiModelId: 'seedream-5-0-lite-260128', editableApiModelId: true },
		svnewapi: { apiModelId: 'sv-seedream-5.0-lite' },
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
		bytedance: { apiModelId: 'doubao-seedream-4-5-251128', editableApiModelId: true },
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

import type { ModelConfig } from './types'

export const zImageSpicy: ModelConfig = {
	id: 'z-image-spicy',
	name: 'Z-Image Spicy',
	type: 'image',
	supportedProviders: {
		mulerouter: { apiModelId: 'z-image-spicy' },
	},
	modes: ['text-to-image'],
	params: [
		{
			id: 'aspectRatio',
			label: 'Aspect Ratio',
			type: 'select',
			options: [
				{ label: '1:1', value: '1:1' },
				{ label: '2:3', value: '2:3' },
				{ label: '3:2', value: '3:2' },
				{ label: '3:4', value: '3:4' },
				{ label: '4:3', value: '4:3' },
				{ label: '4:5', value: '4:5' },
				{ label: '5:4', value: '5:4' },
				{ label: '9:16', value: '9:16' },
				{ label: '16:9', value: '16:9' },
			],
			default: '2:3',
		},
		{
			id: 'prompt_extend',
			label: 'Prompt extend',
			type: 'select',
			options: [
				{ label: 'On', value: 'true' },
				{ label: 'Off', value: 'false' },
			],
			default: 'true',
		},
	],
}

export const qwenImageEditSpicy: ModelConfig = {
	id: 'qwen-image-edit-spicy',
	name: 'Qwen Image Edit Spicy',
	type: 'image',
	supportedProviders: {
		mulerouter: { apiModelId: 'qwen-image-edit-spicy' },
	},
	modes: ['image-ref-to-image'],
	params: [],
}

export const wan27I2vSpicy: ModelConfig = {
	id: 'wan-2.7-i2v-spicy',
	name: 'Wan 2.7 Spicy I2V',
	type: 'video',
	supportedProviders: {
		mulerouter: { apiModelId: 'wan2.7-i2v-spicy' },
	},
	modes: ['first-frame'],
	params: [
		{
			id: 'resolution',
			label: 'Resolution',
			type: 'select',
			options: [
				{ label: '720p', value: '720p' },
				{ label: '1080p', value: '1080p' },
			],
			default: '1080p',
		},
		{
			id: 'duration',
			label: 'Duration',
			type: 'range',
			default: 5,
			min: 2,
			max: 15,
			step: 1,
			unit: 's',
		},
		{
			id: 'prompt_extend',
			label: 'Prompt extend',
			type: 'select',
			options: [
				{ label: 'On', value: 'true' },
				{ label: 'Off', value: 'false' },
			],
			default: 'true',
		},
	],
}

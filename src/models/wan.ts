import type { ModelConfig } from './types'

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

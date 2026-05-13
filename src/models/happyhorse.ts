import type { ModelConfig } from './types'

export const happyHorseT2V: ModelConfig = {
	id: 'happyhorse-1.0-t2v',
	name: 'HappyHorse 1.0 T2V',
	type: 'video',
	supportedProviders: {
		tokenrouter: { apiModelId: 'happyhorse-1.0-t2v' },
	},
	modes: ['text-to-video'],
	params: [],
}

export const happyHorseI2V: ModelConfig = {
	id: 'happyhorse-1.0-i2v',
	name: 'HappyHorse 1.0 I2V',
	type: 'video',
	supportedProviders: {
		tokenrouter: { apiModelId: 'happyhorse-1.0-i2v' },
	},
	modes: ['first-frame'],
	params: [],
}

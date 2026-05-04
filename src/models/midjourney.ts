import type { ModelConfig } from './types'

export const midjourneyV8: ModelConfig = {
	id: 'midjourney-v8',
	name: 'Midjourney v8',
	type: 'image',
	supportedProviders: {
		legnext: { apiModelId: 'midjourney' },
	},
	modes: ['text-to-image'],
	params: [
		{
			id: 'ar',
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
				{ label: '4:5', value: '4:5' },
				{ label: '5:4', value: '5:4' },
				{ label: '21:9', value: '21:9' },
			],
			default: '1:1',
		},
		{
			id: 'quality',
			label: 'Quality',
			type: 'select',
			options: [
				{ label: 'Standard', value: '1' },
				{ label: 'High (4x cost)', value: '4' },
			],
			default: '1',
		},
		{
			id: 'stylize',
			label: 'Stylize',
			type: 'range',
			min: 0,
			max: 1000,
			step: 50,
			default: 100,
		},
	],
}

export const midjourneyNiji7: ModelConfig = {
	id: 'midjourney-niji-7',
	name: 'Midjourney niji 7',
	type: 'image',
	supportedProviders: {
		legnext: { apiModelId: 'midjourney' },
	},
	modes: ['text-to-image'],
	params: [
		{
			id: 'ar',
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
			],
			default: '1:1',
		},
		{
			id: 'stylize',
			label: 'Stylize',
			type: 'range',
			min: 0,
			max: 1000,
			step: 50,
			default: 100,
		},
	],
}

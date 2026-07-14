import type { ModelConfig } from './types'

const FLUX_IMAGE_RATIOS = [
	{ label: '1:1', value: '1:1' },
	{ label: '16:9', value: '16:9' },
	{ label: '9:16', value: '9:16' },
	{ label: '3:2', value: '3:2' },
	{ label: '2:3', value: '2:3' },
	{ label: '4:3', value: '4:3' },
	{ label: '3:4', value: '3:4' },
	{ label: '4:5', value: '4:5' },
	{ label: '5:4', value: '5:4' },
]

export const flux2Klein9b: ModelConfig = {
	id: 'flux-2-klein-9b',
	name: 'FLUX.2 Klein 9B',
	type: 'image',
	supportedProviders: {
		bfl: { apiModelId: 'flux-2-klein-9b', refDelivery: { image: 'inline' } },
		runpod: { apiModelId: 'flux-2-klein-9b', refDelivery: { image: 'inline' } },
	},
	modes: ['text-to-image', 'image-ref-to-image'],
	inferModeFromInputs: true,
	params: [
		{
			id: 'aspectRatio',
			label: 'Aspect Ratio',
			type: 'select',
			modes: ['text-to-image'],
			options: FLUX_IMAGE_RATIOS,
			default: '1:1',
		},
		{
			id: 'targetLongEdge',
			label: 'Long Edge',
			type: 'select',
			options: [
				{ label: '1K', value: '1024' },
				{ label: '2K', value: '2048' },
				{ label: '3K', value: '3072' },
			],
			providerOverrides: {
				runpod: {
					options: [
						{ label: '1K', value: '1024' },
						{ label: '2K', value: '2048' },
					],
				},
			},
			default: '2048',
		},
	],
}

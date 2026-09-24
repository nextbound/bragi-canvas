import type { ModelConfig } from './types'

export const minimaxH3: ModelConfig = {
	id: 'minimax-h3',
	name: 'MiniMax-H3',
	type: 'video',
	supportedProviders: {
		apimart: { apiModelId: 'MiniMax-H3' },
		pika: { apiModelId: 'minimax/h3', aggregated: true },
	},
	modes: ['text-to-video', 'first-frame', 'first-last-frame', 'image-ref', 'video-ref'],
	params: [
		{
			id: 'duration',
			label: 'Duration',
			type: 'range',
			default: 5,
			min: 4,
			max: 15,
			step: 1,
			unit: 's',
		},
		{
			id: 'resolution',
			label: 'Resolution',
			type: 'select',
			options: [
				{ label: '2K', value: '2K' },
				{ label: '768P', value: '768P' },
			],
			default: '2K',
		},
		{
			id: 'aspect_ratio',
			label: 'Ratio',
			type: 'select',
			modes: ['text-to-video', 'image-ref', 'video-ref'],
			options: [
				{ label: 'Adaptive', value: 'adaptive' },
				{ label: '21:9', value: '21:9' },
				{ label: '16:9', value: '16:9' },
				{ label: '4:3', value: '4:3' },
				{ label: '1:1', value: '1:1' },
				{ label: '3:4', value: '3:4' },
				{ label: '9:16', value: '9:16' },
			],
			default: 'adaptive',
		},
		{
			id: 'watermark',
			label: 'Watermark',
			type: 'select',
			options: [
				{ label: 'Off', value: 'false' },
				{ label: 'On', value: 'true' },
			],
			default: 'false',
		},
	],
}

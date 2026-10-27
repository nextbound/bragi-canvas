import type { ModelConfig } from './types'

export const viduQ4: ModelConfig = {
	id: 'vidu-q4-preview',
	name: 'Vidu Q4 Preview',
	type: 'video',
	supportedProviders: { apimart: { apiModelId: 'viduq4-preview' } },
	modes: ['first-frame', 'image-ref'],
	params: [
		{ id: 'duration', label: 'Duration', type: 'range', default: 5, min: 3, max: 16, step: 1, unit: 's' },
		{
			id: 'resolution', label: 'Resolution', type: 'select', default: '720p',
			options: ['540p', '720p', '1080p', '2K', '4K'].map(value => ({ label: value, value })),
		},
		{
			id: 'aspect_ratio', label: 'Ratio', type: 'select', default: '16:9', modes: ['image-ref'],
			options: ['16:9', '9:16', '1:1', '3:4', '4:3'].map(value => ({ label: value, value })),
		},
		{
			id: 'audio', label: 'Audio', type: 'select', default: 'true',
			options: [{ label: 'On', value: 'true' }, { label: 'Off', value: 'false' }],
		},
		{ id: 'seed', label: 'Seed', type: 'number', default: 0, min: 0, max: 2147483647, step: 1 },
	],
}

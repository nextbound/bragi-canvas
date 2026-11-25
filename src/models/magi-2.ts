import type { ModelConfig } from './types'

export const MAGI_2_API_MODEL_ID = 'sand/magi-2/text-to-video'
export const MAGI_2_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']
export const MAGI_2_DURATION = { default: 5, min: 4, max: 30 }
export const MAGI_2_MAX_SEED = 4294967295
export const MAGI_2_RESOLUTION = '1080p'

export const magi2: ModelConfig = {
	id: 'magi-2',
	name: 'MAGI-2',
	type: 'video',
	supportedProviders: { higgsfield: { apiModelId: MAGI_2_API_MODEL_ID, taskCheckWindowMs: 45 * 60 * 1000 } },
	modes: ['text-to-video'],
	params: [
		{ id: 'duration', label: 'Duration', type: 'range', ...MAGI_2_DURATION, step: 1, unit: 's' },
		{
			id: 'aspect_ratio', label: 'Ratio', type: 'select', default: '16:9',
			options: MAGI_2_RATIOS.map(value => ({ label: value, value })),
		},
		{
			id: 'resolution', label: 'Resolution', type: 'select', default: MAGI_2_RESOLUTION,
			options: [{ label: MAGI_2_RESOLUTION, value: MAGI_2_RESOLUTION }],
		},
		{
			id: 'generate_audio', label: 'Audio', type: 'select', default: 'true',
			options: [{ label: 'On', value: 'true' }, { label: 'Off', value: 'false' }],
		},
		{ id: 'seed', label: 'Seed (-1 for random)', type: 'number', default: -1, min: -1, max: MAGI_2_MAX_SEED, step: 1 },
	],
}

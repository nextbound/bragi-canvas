import type { ModelConfig } from './types'

export const fastH3Omni: ModelConfig = {
	id: 'fast-h3-omni',
	name: 'Fast H3 Omni',
	type: 'video',
	supportedProviders: {
		svnewapi: { apiModelId: 'sv-fast-h3-omni', refDelivery: { image: 'relay', audio: 'relay' } },
	},
	modes: ['text-to-video', 'first-frame', 'first-last-frame', 'image-ref'],
	params: [
		{
			id: 'seconds', label: 'Output duration', type: 'select', default: '14.375',
			options: ['5.875', '8', '10.125', '12.25', '14.375'].map(value => ({ label: `${value}s`, value })),
		},
		{
			id: 'canvas', label: 'Canvas', type: 'select', default: '16:9',
			options: ['16:9', '1:1', '9:16', '4:3'].map(value => ({ label: value, value })),
		},
	],
}

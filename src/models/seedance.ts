import type { ModelConfig } from './types'

export const seedance2: ModelConfig = {
	id: 'seedance-2.0',
	name: 'Seedance 2.0',
	type: 'video',
	supportedProviders: {
		bytedance: { apiModelId: 'doubao-seedance-2-0-260128' },
		byteplus: { apiModelId: 'ep-20260423151427-fj6dh' },
		fal: { apiModelId: 'bytedance/seedance-2.0' },
	},
	modes: ['text-to-video', 'first-frame', 'image-ref'],
	params: [
		{
			id: 'duration',
			label: 'Duration',
			type: 'select',
			options: [
				{ label: 'Auto', value: '-1' },
				{ label: '4s', value: '4' },
				{ label: '5s', value: '5' },
				{ label: '6s', value: '6' },
				{ label: '7s', value: '7' },
				{ label: '8s', value: '8' },
				{ label: '9s', value: '9' },
				{ label: '10s', value: '10' },
				{ label: '11s', value: '11' },
				{ label: '12s', value: '12' },
				{ label: '13s', value: '13' },
				{ label: '14s', value: '14' },
				{ label: '15s', value: '15' },
			],
			default: '5',
		},
		{
			id: 'ratio',
			label: 'Ratio',
			type: 'select',
			options: [
				{ label: '16:9', value: '16:9' },
				{ label: '9:16', value: '9:16' },
				{ label: '1:1', value: '1:1' },
				{ label: '4:3', value: '4:3' },
				{ label: '3:4', value: '3:4' },
			],
			default: '16:9',
		},
		{
			id: 'resolution',
			label: 'Resolution',
			type: 'select',
			options: [
				{ label: '480p', value: '480p' },
				{ label: '720p', value: '720p' },
				{ label: '1080p', value: '1080p' },
			],
			default: '720p',
		},
		{
			id: 'generate_audio',
			label: 'Audio',
			type: 'select',
			options: [
				{ label: 'On', value: 'true' },
				{ label: 'Off', value: 'false' },
			],
			default: 'true',
		},
	],
}

export const seedance2Fast: ModelConfig = {
	id: 'seedance-2.0-fast',
	name: 'Seedance 2.0 Fast',
	type: 'video',
	supportedProviders: {
		bytedance: { apiModelId: 'doubao-seedance-2-0-fast-260128' },
		byteplus: { apiModelId: 'ep-20260423151341-p2zm9' },
	},
	modes: ['text-to-video', 'first-frame', 'image-ref'],
	params: [
		{
			id: 'duration',
			label: 'Duration',
			type: 'select',
			options: [
				{ label: 'Auto', value: '-1' },
				{ label: '4s', value: '4' },
				{ label: '5s', value: '5' },
				{ label: '6s', value: '6' },
				{ label: '7s', value: '7' },
				{ label: '8s', value: '8' },
				{ label: '9s', value: '9' },
				{ label: '10s', value: '10' },
				{ label: '11s', value: '11' },
				{ label: '12s', value: '12' },
				{ label: '13s', value: '13' },
				{ label: '14s', value: '14' },
				{ label: '15s', value: '15' },
			],
			default: '5',
		},
		{
			id: 'ratio',
			label: 'Ratio',
			type: 'select',
			options: [
				{ label: '16:9', value: '16:9' },
				{ label: '9:16', value: '9:16' },
				{ label: '1:1', value: '1:1' },
			],
			default: '16:9',
		},
		{
			id: 'resolution',
			label: 'Resolution',
			type: 'select',
			options: [
				{ label: '480p', value: '480p' },
				{ label: '720p', value: '720p' },
			],
			default: '720p',
		},
		{
			id: 'generate_audio',
			label: 'Audio',
			type: 'select',
			options: [
				{ label: 'On', value: 'true' },
				{ label: 'Off', value: 'false' },
			],
			default: 'true',
		},
	],
}

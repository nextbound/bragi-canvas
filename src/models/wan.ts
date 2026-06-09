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

export const wan27: ModelConfig = {
	id: 'wan-2.7',
	name: 'Wan 2.7',
	type: 'video',
	supportedProviders: {
		// DashScope aggregates Wan 2.7: one umbrella id, routed by mode to multiple
		// upstream ids (t2v / i2v / r2v / videoedit) inside DashScopeVideoProvider.
		dashscope: { apiModelId: 'wan-2.7', aggregated: true },
		// MuleRouter only offers the spicy i2v (first-frame) variant — a subset of
		// DashScope's modes, with a narrower param set (lowercase resolution, no ratio).
		mulerouter: { apiModelId: 'wan2.7-i2v-spicy', modes: ['first-frame'] },
	},
	modes: [
		'text-to-video',
		'first-frame',
		'first-last-frame',
		'image-ref',
		'video-ref',
		'video-extend',
		'video-edit',
	],
	params: [
		{
			id: 'resolution',
			label: 'Resolution',
			type: 'select',
			options: [
				{ label: '720P', value: '720P' },
				{ label: '1080P', value: '1080P' },
			],
			default: '720P',
			providerOverrides: {
				// MuleRouter's spicy i2v expects lowercase resolutions and defaults to 1080p.
				mulerouter: {
					options: [
						{ label: '720p', value: '720p' },
						{ label: '1080p', value: '1080p' },
					],
					default: '1080p',
				},
			},
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
			providerOverrides: {
				// MuleRouter spicy i2v derives ratio from the input image; no ratio control.
				mulerouter: { hidden: true },
			},
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
			label: 'Prompt Extend',
			type: 'select',
			options: [
				{ label: 'On', value: 'true' },
				{ label: 'Off', value: 'false' },
			],
			default: 'true',
		},
		{
			id: 'audio_setting',
			label: 'Edit Audio',
			type: 'select',
			modes: ['video-edit'],
			options: [
				{ label: 'Auto', value: 'auto' },
				{ label: 'Original', value: 'origin' },
			],
			default: 'auto',
		},
	],
}

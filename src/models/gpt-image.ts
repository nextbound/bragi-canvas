import type { ModelConfig } from './types'

const GPT_IMAGE_RATIOS = [
	{ label: 'Auto', value: 'auto' },
	{ label: '1:1', value: '1:1' },
	{ label: '3:2', value: '3:2' },
	{ label: '2:3', value: '2:3' },
	{ label: '4:3', value: '4:3' },
	{ label: '3:4', value: '3:4' },
	{ label: '5:4', value: '5:4' },
	{ label: '4:5', value: '4:5' },
	{ label: '16:9', value: '16:9' },
	{ label: '9:16', value: '9:16' },
	{ label: '2:1', value: '2:1' },
	{ label: '1:2', value: '1:2' },
	{ label: '3:1', value: '3:1' },
	{ label: '1:3', value: '1:3' },
	{ label: '21:9', value: '21:9' },
	{ label: '9:21', value: '9:21' },
]

export const gptImage: ModelConfig = {
	id: 'gpt-image-2',
	name: 'GPT Image 2',
	type: 'image',
	supportedProviders: {
		openai: { apiModelId: 'gpt-image-2' },
		fal: { apiModelId: 'fal-ai/gpt-image-2' },
		tokenrouter: { apiModelId: 'openai/gpt-5.4-image-2', refDelivery: { image: 'inline' } },
		apimart: { apiModelId: 'gpt-image-2-official' },
		svnewapi: { apiModelId: 'sv-gpt-image-2' },
	},
	modes: ['text-to-image'],
	params: [
		{
			id: 'aspectRatio',
			label: 'Aspect Ratio',
			type: 'select',
			options: GPT_IMAGE_RATIOS,
			default: '1:1',
		},
		{
			id: 'imageSize',
			label: 'Size',
			type: 'select',
			options: [
				{ label: 'Auto', value: 'auto' },
				{ label: '1K', value: '1K' },
				{ label: '2K', value: '2K' },
				{ label: '4K', value: '4K' },
			],
			default: '2K',
		},
		{
			id: 'quality',
			label: 'Quality',
			type: 'select',
			options: [
				{ label: 'Auto', value: 'auto' },
				{ label: 'Low', value: 'low' },
				{ label: 'Medium', value: 'medium' },
				{ label: 'High', value: 'high' },
			],
			default: 'auto',
		},
	],
}

/**
 * GPT Image 2 (Official) — OpenAI's official gpt-image-2 channel via APIMart.
 * Distinct from `gpt-image-2` because the official channel honors `quality` and
 * is billed per a quality × resolution matrix on the SV gateway. Only the APIMart
 * and SV gateway routes expose it; the same `aspectRatio`/`imageSize`/`quality`
 * controls as GPT Image 2 apply.
 */
export const gptImageOfficial: ModelConfig = {
	id: 'gpt-image-2-official',
	name: 'GPT Image 2 (Official)',
	type: 'image',
	supportedProviders: {
		apimart: { apiModelId: 'gpt-image-2-official' },
		svnewapi: { apiModelId: 'sv-gpt-image-2-official' },
	},
	modes: gptImage.modes,
	params: gptImage.params,
}

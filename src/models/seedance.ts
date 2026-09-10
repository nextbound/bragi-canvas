import type { ModelConfig } from './types'

const seedance25DurationOptions = [
	{ label: 'Auto', value: '-1' },
	...Array.from({ length: 27 }, (_, index) => {
		const seconds = index + 4
		return { label: `${seconds}s`, value: String(seconds) }
	}),
]

const seedance25AdaptiveOnly = [{ label: 'Adaptive', value: 'adaptive' }]

export const seedance25: ModelConfig = {
	id: 'seedance-2.5',
	name: 'Seedance 2.5',
	type: 'video',
	supportedProviders: {
		bytedance: { apiModelId: 'doubao-seedance-2-5-260628' },
		byteplus: {
			apiModelId: 'dreamina-seedance-2-5-260628',
			editableApiModelId: true,
			refDelivery: { image: 'native_asset', video: 'native_asset', audio: 'native_asset', nativeAssetProvider: 'byteplus' },
		},
		svnewapi: { apiModelId: 'sv-seedance-2.5' },
	},
	modes: ['text-to-video', 'first-frame', 'first-last-frame', 'image-ref', 'video-ref', 'video-extend', 'video-edit'],
	params: [
		{
			id: 'duration',
			label: 'Duration',
			type: 'select',
			options: seedance25DurationOptions,
			optionsByMode: {
				'video-edit': [{ label: 'Auto', value: '-1' }],
			},
			default: '-1',
		},
		{
			id: 'ratio',
			label: 'Ratio',
			type: 'select',
			options: [
				...seedance25AdaptiveOnly,
				{ label: '16:9', value: '16:9' },
				{ label: '4:3', value: '4:3' },
				{ label: '1:1', value: '1:1' },
				{ label: '3:4', value: '3:4' },
				{ label: '9:16', value: '9:16' },
				{ label: '21:9', value: '21:9' },
			],
			optionsByMode: {
				'first-frame': seedance25AdaptiveOnly,
				'first-last-frame': seedance25AdaptiveOnly,
				'video-extend': seedance25AdaptiveOnly,
				'video-edit': seedance25AdaptiveOnly,
			},
			default: 'adaptive',
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
		{
			id: 'output_format',
			label: 'Format',
			type: 'select',
			options: [
				{ label: 'MP4', value: 'mp4' },
				{ label: 'MOV', value: 'mov' },
			],
			default: 'mp4',
		},
	],
}

export const seedance2: ModelConfig = {
	id: 'seedance-2.0',
	name: 'Seedance 2.0',
	type: 'video',
	supportedProviders: {
		bytedance: { apiModelId: 'doubao-seedance-2-0-260128' },
		byteplus: { apiModelId: 'dreamina-seedance-2-0-260128', editableApiModelId: true, refDelivery: { image: 'native_asset', video: 'native_asset', audio: 'native_asset', nativeAssetProvider: 'byteplus' } },
		fal: { apiModelId: 'bytedance/seedance-2.0' },
		tokenrouter: { apiModelId: 'dreamina-seedance-2-0-260128', refDelivery: { image: 'native_asset', video: 'native_asset', audio: 'native_asset', nativeAssetProvider: 'tokenrouter' } },
		token360: { apiModelId: 'seedance-2.0', refDelivery: { image: 'native_asset', nativeAssetProvider: 'token360' } },
		// Gateway (byteplus-seedance-2 / Ark) builds content[] with reference roles from
		// top-level images/audios/videos — full ref support including audio-driven + video-ref.
		svnewapi: { apiModelId: 'sv-seedance-2.0', modes: ['text-to-video', 'first-frame', 'image-ref', 'video-ref'] },
	},
	modes: ['text-to-video', 'first-frame', 'image-ref', 'video-ref'],
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
				{ label: '4K', value: '4k' },
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
		byteplus: { apiModelId: 'dreamina-seedance-2-0-fast-260128', editableApiModelId: true, refDelivery: { image: 'native_asset', video: 'native_asset', audio: 'native_asset', nativeAssetProvider: 'byteplus' } },
		tokenrouter: { apiModelId: 'dreamina-seedance-2-0-fast-260128', refDelivery: { image: 'native_asset', video: 'native_asset', audio: 'native_asset', nativeAssetProvider: 'tokenrouter' } },
		token360: { apiModelId: 'seedance-2.0-fast', refDelivery: { image: 'native_asset', nativeAssetProvider: 'token360' } },
	},
	modes: ['text-to-video', 'first-frame', 'image-ref', 'video-ref'],
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

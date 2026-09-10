import type { ModelConfig } from './types'

/**
 * HappyHorse 1.1 — Alibaba Model Studio (DashScope) video family.
 *
 * DashScope aggregates the family behind one umbrella catalog id; the mode is
 * routed to four upstream ids inside `DashScopeVideoProvider`:
 *   text-to-video → happyhorse-1.1-t2v
 *   first-frame   → happyhorse-1.1-i2v
 *   image-ref     → happyhorse-1.1-r2v        (1-9 reference images)
 *   video-edit    → happyhorse-1.0-video-edit (Alibaba ships no 1.1 build of
 *                                              the editing model; 1.0 is its
 *                                              latest version)
 *
 * The model, endpoint, and API key must all belong to the same region, so the
 * DashScope base URL in provider settings decides which region is called.
 */
export const happyHorse11: ModelConfig = {
	id: 'happyhorse-1.1',
	name: 'HappyHorse 1.1',
	type: 'video',
	supportedProviders: {
		dashscope: { apiModelId: 'happyhorse-1.1', aggregated: true },
	},
	modes: ['text-to-video', 'first-frame', 'image-ref', 'video-edit'],
	params: [
		{
			id: 'resolution',
			label: 'Resolution',
			type: 'select',
			options: [
				{ label: '480P', value: '480P' },
				{ label: '720P', value: '720P' },
				{ label: '1080P', value: '1080P' },
			],
			// Video editing only accepts 720P / 1080P.
			optionsByMode: {
				'video-edit': [
					{ label: '720P', value: '720P' },
					{ label: '1080P', value: '1080P' },
				],
			},
			default: '1080P',
		},
		{
			id: 'ratio',
			label: 'Ratio',
			type: 'select',
			// Image-to-video derives the frame size from the input image and video
			// editing follows the source clip, so neither accepts a ratio.
			modes: ['text-to-video', 'image-ref'],
			options: [
				{ label: '16:9', value: '16:9' },
				{ label: '9:16', value: '9:16' },
				{ label: '1:1', value: '1:1' },
				{ label: '4:3', value: '4:3' },
				{ label: '3:4', value: '3:4' },
				{ label: '4:5', value: '4:5' },
				{ label: '5:4', value: '5:4' },
				{ label: '21:9', value: '21:9' },
				{ label: '9:21', value: '9:21' },
			],
			default: '16:9',
		},
		{
			id: 'duration',
			label: 'Duration',
			type: 'range',
			// Video editing follows the source clip length.
			modes: ['text-to-video', 'first-frame', 'image-ref'],
			default: 5,
			min: 3,
			max: 15,
			step: 1,
			unit: 's',
		},
		{
			id: 'audio_setting',
			label: 'Edit audio',
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

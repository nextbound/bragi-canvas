import type { ModelConfig } from './types'

// ── TTS Models ──

export const elevenLabsTTS: ModelConfig = {
	id: 'elevenlabs-tts-v3',
	name: 'ElevenLabs TTS v3',
	type: 'audio',
	supportedProviders: {
		elevenlabs: { apiModelId: 'eleven_v3' },
		fal: { apiModelId: 'fal-ai/elevenlabs/tts/eleven-v3' },
	},
	modes: ['tts'],
	params: [
		{
			id: 'voice',
			label: 'Voice',
			type: 'select',
			options: [
				{ label: 'Rachel', value: '21m00Tcm4TlvDq8ikWAM' },
				{ label: 'Adam', value: 'pNInz6obpgDQGcFmaJgB' },
				{ label: 'Domi', value: 'AZnzlk1XvdvUeBnXmlld' },
				{ label: 'Bella', value: 'EXAVITQu4vr4xnSDxMaL' },
				{ label: 'Antoni', value: 'ErXwobaYiN019PkySvjV' },
				{ label: 'Elli', value: 'MF3mGyEYCl7XYWbV9V6O' },
				{ label: 'Josh', value: 'TxGEqnHWrfWFTfGW9XjX' },
				{ label: 'Sam', value: 'yoZ06aMxZJJ28mfd3POQ' },
			],
			default: '21m00Tcm4TlvDq8ikWAM',
		},
	],
}

export const minimaxTTS: ModelConfig = {
	id: 'minimax-tts',
	name: 'MiniMax TTS',
	type: 'audio',
	supportedProviders: {
		fal: { apiModelId: 'fal-ai/minimax/speech-2.8-hd' },
		minimax: { apiModelId: 'speech-2.8-hd' },
	},
	modes: ['tts'],
	params: [
		{
			id: 'voice',
			label: 'Voice',
			type: 'select',
			options: [
				{ label: 'Graceful Lady', value: 'English_Graceful_Lady' },
				{ label: 'Insightful Speaker', value: 'English_Insightful_Speaker' },
				{ label: 'Radiant Girl', value: 'English_radiant_girl' },
				{ label: 'Persuasive Man', value: 'English_Persuasive_Man' },
				{ label: 'Lucky Robot', value: 'English_Lucky_Robot' },
				{ label: '绅士', value: 'Chinese (Mandarin)_Gentleman' },
				{ label: '不羁青年', value: 'Chinese (Mandarin)_Unrestrained_Young_Man' },
				{ label: '爽朗少年', value: 'Chinese (Mandarin)_Straightforward_Boy' },
				{ label: '温暖女生', value: 'Chinese (Mandarin)_Warm_HeartedGirl' },
				{ label: '知性女声', value: 'Chinese (Mandarin)_IntellectualGirl' },
				{ label: '可爱精灵', value: 'Chinese (Mandarin)_Cute_Spirit' },
				{ label: '倔强老友', value: 'Chinese (Mandarin)_Stubborn_Friend' },
			],
			default: 'English_Graceful_Lady',
		},
		{
			id: 'speed',
			label: 'Speed',
			type: 'select',
			options: [
				{ label: '0.5x', value: '0.5' },
				{ label: '0.75x', value: '0.75' },
				{ label: '1.0x', value: '1.0' },
				{ label: '1.25x', value: '1.25' },
				{ label: '1.5x', value: '1.5' },
				{ label: '2.0x', value: '2.0' },
			],
			default: '1.0',
		},
	],
}

// ── Music Models ──

export const elevenLabsMusic: ModelConfig = {
	id: 'elevenlabs-music',
	name: 'ElevenLabs Music',
	type: 'audio',
	supportedProviders: {
		elevenlabs: { apiModelId: 'music_v1' },
		fal: { apiModelId: 'fal-ai/elevenlabs/music' },
	},
	modes: ['music'],
	params: [
		{
			id: 'music_length_ms',
			label: 'Duration',
			type: 'range',
			min: 3,
			max: 300,
			step: 5,
			unit: 's',
			default: 30,
		},
		{
			id: 'instrumental',
			label: 'Style',
			type: 'select',
			options: [
				{ label: 'Auto', value: 'false' },
				{ label: 'Instrumental', value: 'true' },
			],
			default: 'false',
		},
	],
}

export const minimaxMusic: ModelConfig = {
	id: 'minimax-music',
	name: 'MiniMax Music',
	type: 'audio',
	supportedProviders: {
		fal: { apiModelId: 'fal-ai/minimax-music/v2.6' },
		minimax: { apiModelId: 'music-2.6' },
	},
	modes: ['music'],
	params: [
		{
			id: 'instrumental',
			label: 'Style',
			type: 'select',
			options: [
				{ label: 'Instrumental', value: 'true' },
				{ label: 'With Lyrics', value: 'false' },
			],
			default: 'true',
		},
	],
}

// ── Sound Effect Models ──

export const elevenLabsSFX: ModelConfig = {
	id: 'elevenlabs-sfx',
	name: 'ElevenLabs Sound Effects',
	type: 'audio',
	supportedProviders: {
		elevenlabs: { apiModelId: 'eleven_text_to_sound_v2' },
		fal: { apiModelId: 'fal-ai/elevenlabs/sound-effects/v2' },
	},
	modes: ['sound-effect'],
	params: [
		{
			id: 'duration',
			label: 'Duration',
			type: 'select',
			options: [
				{ label: '1s', value: '1' },
				{ label: '3s', value: '3' },
				{ label: '5s', value: '5' },
				{ label: '10s', value: '10' },
				{ label: '20s', value: '20' },
				{ label: '30s', value: '30' },
			],
			default: '5',
		},
	],
}

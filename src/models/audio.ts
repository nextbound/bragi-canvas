import type { ModelConfig, ModelParam } from './types'

// ── TTS Models ──

const QWEN_VOICE_BUILTIN_MODEL = 'qwen3-tts-instruct-flash'
const QWEN_VOICE_REFERENCE_MODEL = 'qwen3-tts-vc-2026-01-22'
const QWEN_VOICE_DESIGN_MODEL = 'qwen3-tts-vd-2026-01-26'

function dashScopeVoiceParams(defaultVoice = ''): ModelParam[] {
	return [
		{
			id: 'voice',
			label: 'Voice',
			type: 'select',
			options: [],
			default: defaultVoice,
		},
	]
}

const qwen3BuiltinVoices = [
	{ label: 'Cherry', value: 'Cherry' },
	{ label: 'Serena', value: 'Serena' },
	{ label: 'Ethan', value: 'Ethan' },
	{ label: 'Chelsie', value: 'Chelsie' },
	{ label: 'Momo', value: 'Momo' },
	{ label: 'Vivian', value: 'Vivian' },
	{ label: 'Moon', value: 'Moon' },
	{ label: 'Maia', value: 'Maia' },
	{ label: 'Kai', value: 'Kai' },
	{ label: 'Nofish', value: 'Nofish' },
	{ label: 'Bella', value: 'Bella' },
	{ label: 'Jennifer', value: 'Jennifer' },
	{ label: 'Ryan', value: 'Ryan' },
	{ label: 'Katerina', value: 'Katerina' },
	{ label: 'Aiden', value: 'Aiden' },
	{ label: 'Eldric Sage', value: 'Eldric Sage' },
	{ label: 'Mia', value: 'Mia' },
	{ label: 'Mochi', value: 'Mochi' },
	{ label: 'Bellona', value: 'Bellona' },
	{ label: 'Vincent', value: 'Vincent' },
	{ label: 'Bunny', value: 'Bunny' },
	{ label: 'Neil', value: 'Neil' },
	{ label: 'Elias', value: 'Elias' },
	{ label: 'Arthur', value: 'Arthur' },
	{ label: 'Nini', value: 'Nini' },
	{ label: 'Seren', value: 'Seren' },
	{ label: 'Pip', value: 'Pip' },
	{ label: 'Stella', value: 'Stella' },
	{ label: 'Bodega', value: 'Bodega' },
	{ label: 'Sonrisa', value: 'Sonrisa' },
	{ label: 'Alek', value: 'Alek' },
	{ label: 'Dolce', value: 'Dolce' },
	{ label: 'Sohee', value: 'Sohee' },
	{ label: 'Ono Anna', value: 'Ono Anna' },
	{ label: 'Lenn', value: 'Lenn' },
	{ label: 'Emilien', value: 'Emilien' },
	{ label: 'Andre', value: 'Andre' },
	{ label: 'Radio Gol', value: 'Radio Gol' },
	{ label: 'Jada', value: 'Jada' },
	{ label: 'Dylan', value: 'Dylan' },
	{ label: 'Li', value: 'Li' },
	{ label: 'Marcus', value: 'Marcus' },
	{ label: 'Roy', value: 'Roy' },
	{ label: 'Peter', value: 'Peter' },
	{ label: 'Sunny', value: 'Sunny' },
	{ label: 'Eric', value: 'Eric' },
	{ label: 'Rocky', value: 'Rocky' },
	{ label: 'Kiki', value: 'Kiki' },
]

const qwen3InstructUnsupportedVoices = new Set([
	'Jennifer',
	'Ryan',
	'Katerina',
	'Aiden',
	'Bodega',
	'Sonrisa',
	'Alek',
	'Dolce',
	'Sohee',
	'Ono Anna',
	'Lenn',
	'Emilien',
	'Andre',
	'Radio Gol',
	'Jada',
	'Dylan',
	'Li',
	'Marcus',
	'Roy',
	'Peter',
	'Sunny',
	'Eric',
	'Rocky',
	'Kiki',
])

function qwen3VoiceParams(defaultVoice = 'Cherry', instruct = false): ModelParam[] {
	return [
		{
			id: 'voice',
			label: 'Voice',
			type: 'select',
			options: instruct ? qwen3BuiltinVoices.filter(voice => !qwen3InstructUnsupportedVoices.has(voice.value)) : qwen3BuiltinVoices,
			default: defaultVoice,
		},
	]
}

export const elevenLabsTTS: ModelConfig = {
	id: 'elevenlabs-tts-v3',
	name: 'ElevenLabs v3',
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
		{
			id: 'stability',
			label: 'Stability',
			type: 'range',
			min: 0,
			max: 1,
			step: 0.05,
			default: 0.5,
		},
		{
			id: 'similarity_boost',
			label: 'Similarity',
			type: 'range',
			min: 0,
			max: 1,
			step: 0.05,
			default: 0.75,
		},
		{
			id: 'style',
			label: 'Style',
			type: 'range',
			min: 0,
			max: 1,
			step: 0.05,
			default: 0,
		},
		{
			id: 'speed',
			label: 'Speed',
			type: 'range',
			min: 0.7,
			max: 1.2,
			step: 0.05,
			default: 1,
		},
	],
	voiceConfig: { builtin: true, clone: true, design: false },
}

export const minimaxTTS: ModelConfig = {
	id: 'minimax-tts',
	name: 'MiniMax',
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
				{ label: 'Gentleman', value: 'Chinese (Mandarin)_Gentleman' },
				{ label: 'Unrestrained young man', value: 'Chinese (Mandarin)_Unrestrained_Young_Man' },
				{ label: 'Straightforward boy', value: 'Chinese (Mandarin)_Straightforward_Boy' },
				{ label: 'Warm-hearted girl', value: 'Chinese (Mandarin)_Warm_HeartedGirl' },
				{ label: 'Intellectual girl', value: 'Chinese (Mandarin)_IntellectualGirl' },
				{ label: 'Cute spirit', value: 'Chinese (Mandarin)_Cute_Spirit' },
				{ label: 'Stubborn friend', value: 'Chinese (Mandarin)_Stubborn_Friend' },
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
	voiceConfig: { builtin: true, clone: true, design: false },
}

export const dashScopeCosyVoice35Plus: ModelConfig = {
	id: 'dashscope-cosyvoice-v3-5-plus',
	name: 'CosyVoice v3.5 Plus',
	type: 'audio',
	supportedProviders: {
		dashscope: { apiModelId: 'cosyvoice-v3.5-plus', aggregated: true },
	},
	modes: ['tts'],
	params: dashScopeVoiceParams(),
	voiceConfig: { builtin: false, clone: true, design: true },
}

export const dashScopeCosyVoice35Flash: ModelConfig = {
	id: 'dashscope-cosyvoice-v3-5-flash',
	name: 'CosyVoice v3.5 Flash',
	type: 'audio',
	supportedProviders: {
		dashscope: { apiModelId: 'cosyvoice-v3.5-flash', aggregated: true },
	},
	modes: ['tts'],
	params: dashScopeVoiceParams(),
	voiceConfig: { builtin: false, clone: true, design: true },
}

export const dashScopeQwenVoice: ModelConfig = {
	id: 'dashscope-qwen-voice',
	name: 'Qwen Voice',
	type: 'audio',
	supportedProviders: {
		dashscope: { apiModelId: QWEN_VOICE_BUILTIN_MODEL, aggregated: true },
	},
	modes: ['tts'],
	params: qwen3VoiceParams('Cherry', true),
	voiceConfig: {
		builtin: true,
		clone: true,
		design: true,
		modelIds: {
			builtin: QWEN_VOICE_BUILTIN_MODEL,
			reference: QWEN_VOICE_REFERENCE_MODEL,
			design: QWEN_VOICE_DESIGN_MODEL,
		},
		sampleModelId: 'dashscope-qwen3-tts-instruct-flash',
	},
}

export const grokTTS: ModelConfig = {
	id: 'grok-tts',
	name: 'Grok',
	type: 'audio',
	supportedProviders: {
		xai: { apiModelId: 'grok-tts' },
	},
	modes: ['tts'],
	params: [
		{
			id: 'voice',
			label: 'Voice',
			type: 'select',
			options: [
				{ label: 'Eve (F)', value: 'eve' },
				{ label: 'Ara (F)', value: 'ara' },
				{ label: 'Leo (M)', value: 'leo' },
				{ label: 'Rex (M)', value: 'rex' },
				{ label: 'Sal (M)', value: 'sal' },
			],
			default: 'eve',
		},
		{
			id: 'language',
			label: 'Language',
			type: 'select',
			options: [
				{ label: 'Auto', value: 'auto' },
				{ label: 'English', value: 'en' },
				{ label: 'Chinese', value: 'zh' },
				{ label: 'Spanish', value: 'es' },
				{ label: 'German', value: 'de' },
				{ label: 'French', value: 'fr' },
				{ label: 'Japanese', value: 'ja' },
				{ label: 'Korean', value: 'ko' },
				{ label: 'Portuguese (BR)', value: 'pt-BR' },
			],
			default: 'auto',
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
			type: 'range',
			default: 5,
			min: 0.5,
			max: 30,
			step: 0.5,
			unit: 's',
			providerOverrides: {
				fal: { max: 22 },
			},
		},
	],
}

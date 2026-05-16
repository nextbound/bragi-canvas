import type { App } from 'obsidian'
import { normalizePath, requestUrl } from 'obsidian'
import type {
	AudioProvider,
	GenerateAudioResult,
	ListVoicesOptions,
	VoiceCloneOptions,
	VoiceCloneResult,
	VoiceOption,
} from './types'
import { optionalStringParam, stringParam } from './params'

const BASE_URL = 'https://dashscope.aliyuncs.com/api/v1'
const QWEN_TTS_URL = `${BASE_URL}/services/aigc/multimodal-generation/generation`
const COSY_TTS_URL = `${BASE_URL}/services/audio/tts/SpeechSynthesizer`
const CUSTOMIZATION_URL = `${BASE_URL}/services/audio/tts/customization`

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonText(text: string | undefined): unknown {
	if (!text) return null
	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

function getAt(obj: unknown, path: string[]): unknown {
	let cursor: unknown = obj
	for (const part of path) {
		if (Array.isArray(cursor)) {
			const index = Number(part)
			if (!Number.isInteger(index)) return undefined
			cursor = cursor[index]
		} else if (isRecord(cursor)) {
			cursor = cursor[part]
		} else {
			return undefined
		}
	}
	return cursor
}

function parseErr(resp: { status: number; text?: string; json?: unknown }): string {
	const body = typeof resp.json === 'undefined' ? parseJsonText(resp.text) : resp.json
	const msg =
		getStringAt(body, ['error', 'message'])
		|| getStringAt(body, ['message'])
		|| getStringAt(body, ['output', 'message'])
		|| getStringAt(body, ['code'])
		|| resp.text
		|| ''
	return msg
}

function isInvalidApiKeyResponse(resp: { status: number; text?: string; json?: unknown }): boolean {
	if (resp.status === 401) return true
	if (resp.status !== 403) return false
	const msg = parseErr(resp).toLowerCase()
	return /invalid|incorrect|unauthorized|api-?key/.test(msg) && /key|token|credential|api/.test(msg)
}

function getStringAt(obj: unknown, path: string[]): string | null {
	const value = getAt(obj, path)
	return typeof value === 'string' && value.length > 0 ? value : null
}

function extractAudioUrl(json: unknown): string | null {
	const paths = [
		['output', 'audio', 'url'],
		['output', 'url'],
		['output', 'data', 'audio', 'url'],
		['output', 'data', 'url'],
		['audio', 'url'],
		['url'],
	]
	for (const path of paths) {
		const value = getStringAt(json, path)
		if (value && /^https?:\/\//i.test(value)) return value
	}
	const choiceAudio = getStringAt(json, ['output', 'choices', '0', 'message', 'audio', 'url'])
	if (choiceAudio && /^https?:\/\//i.test(choiceAudio)) return choiceAudio
	return null
}

function extractAudioData(json: unknown): string | null {
	for (const path of [['output', 'audio', 'data'], ['audio', 'data'], ['data']]) {
		const value = getStringAt(json, path)
		if (value) return value
	}
	return null
}

function extractVoiceId(json: unknown, qwen: boolean): string | null {
	if (qwen) {
		return getStringAt(json, ['output', 'voice']) || getStringAt(json, ['voice'])
	}
	return getStringAt(json, ['output', 'voice_id']) || getStringAt(json, ['voice_id'])
}

function isQwenModel(modelId: string): boolean {
	return /^qwen/i.test(modelId)
}

function sanitizeQwenName(hash: string): string {
	return `bragi_${hash.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 10)}`.slice(0, 16)
}

function sanitizeCosyPrefix(hash: string): string {
	return `bragi${hash.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5)}`.slice(0, 10)
}

function safePayloadSnippet(value: unknown): string {
	try {
		return JSON.stringify(value).substring(0, 240)
	} catch {
		return ''
	}
}

function outputDirectoryPath(outputDir: string): string {
	return normalizePath(outputDir || 'assets')
}

function outputFilePath(outputDir: string, fileName: string): string {
	return normalizePath(`${outputDirectoryPath(outputDir)}/${fileName}`)
}

function toVoiceOption(record: UnknownRecord, qwen: boolean, modelId: string): VoiceOption | null {
	const id = qwen
		? stringParam(record.voice, '')
		: stringParam(record.voice_id, '')
	if (!id) return null
	const targetModel = stringParam(record.target_model, '')
	if (qwen && modelId && targetModel && targetModel !== modelId) return null
	if (!qwen && modelId && !id.startsWith(`${modelId}-`)) return null
	const status = stringParam(record.status, '')
	return {
		id,
		name: id,
		language: stringParam(record.language, ''),
		category: status || 'Custom',
		description: status ? `Status: ${status}` : undefined,
		source: 'custom',
	}
}

const QWEN3_LANGUAGES = 'zh/en/fr/de/ru/it/es/pt/ja/ko'

const qwen3Voices: VoiceOption[] = [
	{ id: 'Cherry', name: 'Cherry', gender: 'Female', age: 'Young adult', language: QWEN3_LANGUAGES, category: 'Friendly', description: 'Sunny, positive, friendly, and natural young woman', source: 'builtin' },
	{ id: 'Serena', name: 'Serena', gender: 'Female', age: 'Young adult', language: QWEN3_LANGUAGES, category: 'Gentle', description: 'Gentle young woman', source: 'builtin' },
	{ id: 'Ethan', name: 'Ethan', gender: 'Male', age: 'Young adult', language: QWEN3_LANGUAGES, category: 'Energetic', description: 'Standard Mandarin with a slight northern accent', source: 'builtin' },
	{ id: 'Chelsie', name: 'Chelsie', gender: 'Female', age: 'Young adult', language: QWEN3_LANGUAGES, category: 'Character', description: 'Two-dimensional virtual girlfriend', source: 'builtin' },
	{ id: 'Momo', name: 'Momo', gender: 'Female', age: 'Young adult', language: QWEN3_LANGUAGES, category: 'Playful', description: 'Playful and mischievous', source: 'builtin' },
	{ id: 'Vivian', name: 'Vivian', gender: 'Female', age: 'Young adult', language: QWEN3_LANGUAGES, category: 'Character', description: 'Confident, cute, and slightly feisty', source: 'builtin' },
	{ id: 'Moon', name: 'Moon', gender: 'Male', age: 'Young adult', language: QWEN3_LANGUAGES, category: 'Character', description: 'Bold and handsome male voice', source: 'builtin' },
	{ id: 'Maia', name: 'Maia', gender: 'Female', age: 'Young adult', language: QWEN3_LANGUAGES, category: 'Narration', description: 'A blend of intellect and gentleness', source: 'builtin' },
	{ id: 'Kai', name: 'Kai', gender: 'Male', age: 'Young adult', language: QWEN3_LANGUAGES, category: 'Soothing', description: 'Soothing audio spa voice', source: 'builtin' },
	{ id: 'Nofish', name: 'Nofish', gender: 'Male', age: 'Adult', language: QWEN3_LANGUAGES, category: 'Character', description: 'Designer who cannot pronounce retroflex sounds', source: 'builtin' },
	{ id: 'Bella', name: 'Bella', gender: 'Female', age: 'Child', language: QWEN3_LANGUAGES, category: 'Child', description: 'Playful little girl voice', source: 'builtin' },
	{ id: 'Jennifer', name: 'Jennifer', gender: 'Female', age: 'Adult', language: QWEN3_LANGUAGES, category: 'English', description: 'Premium cinematic American English female voice', source: 'builtin' },
	{ id: 'Ryan', name: 'Ryan', gender: 'Male', age: 'Adult', language: QWEN3_LANGUAGES, category: 'Dramatic', description: 'Rhythmic, dramatic, vivid, and powerful', source: 'builtin' },
	{ id: 'Katerina', name: 'Katerina', gender: 'Female', age: 'Adult', language: QWEN3_LANGUAGES, category: 'Character', description: 'Mature woman voice with memorable rhythm', source: 'builtin' },
	{ id: 'Aiden', name: 'Aiden', gender: 'Male', age: 'Young adult', language: QWEN3_LANGUAGES, category: 'English', description: 'American English young man', source: 'builtin' },
	{ id: 'Eldric Sage', name: 'Eldric Sage', gender: 'Male', age: 'Elder', language: QWEN3_LANGUAGES, category: 'Narration', description: 'Calm and wise elder voice', source: 'builtin' },
	{ id: 'Mia', name: 'Mia', gender: 'Female', age: 'Young adult', language: QWEN3_LANGUAGES, category: 'Gentle', description: 'Gentle as spring water', source: 'builtin' },
	{ id: 'Mochi', name: 'Mochi', gender: 'Male', age: 'Young adult', language: QWEN3_LANGUAGES, category: 'Character', description: 'Clever and quick-witted young adult', source: 'builtin' },
	{ id: 'Bellona', name: 'Bellona', gender: 'Female', age: 'Adult', language: QWEN3_LANGUAGES, category: 'Dramatic', description: 'Powerful clear voice for character performance', source: 'builtin' },
	{ id: 'Vincent', name: 'Vincent', gender: 'Male', age: 'Adult', language: QWEN3_LANGUAGES, category: 'Character', description: 'Raspy, smoky heroic voice', source: 'builtin' },
	{ id: 'Bunny', name: 'Bunny', gender: 'Female', age: 'Child', language: QWEN3_LANGUAGES, category: 'Child', description: 'Cute little girl voice', source: 'builtin' },
	{ id: 'Neil', name: 'Neil', gender: 'Male', age: 'Adult', language: QWEN3_LANGUAGES, category: 'News', description: 'Professional news anchor voice', source: 'builtin' },
	{ id: 'Elias', name: 'Elias', gender: 'Female', age: 'Adult', language: QWEN3_LANGUAGES, category: 'Education', description: 'Academic and storytelling voice', source: 'builtin' },
	{ id: 'Arthur', name: 'Arthur', gender: 'Male', age: 'Elder', language: QWEN3_LANGUAGES, category: 'Narration', description: 'Earthy village storytelling voice', source: 'builtin' },
	{ id: 'Nini', name: 'Nini', gender: 'Female', age: 'Young adult', language: QWEN3_LANGUAGES, category: 'Sweet', description: 'Soft and clingy sweet voice', source: 'builtin' },
	{ id: 'Seren', name: 'Seren', gender: 'Female', age: 'Adult', language: QWEN3_LANGUAGES, category: 'Soothing', description: 'Gentle and soothing bedtime voice', source: 'builtin' },
	{ id: 'Pip', name: 'Pip', gender: 'Male', age: 'Child', language: QWEN3_LANGUAGES, category: 'Child', description: 'Playful mischievous child voice', source: 'builtin' },
	{ id: 'Stella', name: 'Stella', gender: 'Female', age: 'Teen', language: QWEN3_LANGUAGES, category: 'Character', description: 'Sweet teenage-girl character voice', source: 'builtin' },
	{ id: 'Bodega', name: 'Bodega', gender: 'Male', age: 'Adult', language: QWEN3_LANGUAGES, category: 'Spanish', description: 'Passionate Spanish male voice', source: 'builtin' },
	{ id: 'Sonrisa', name: 'Sonrisa', gender: 'Female', age: 'Adult', language: QWEN3_LANGUAGES, category: 'Spanish', description: 'Cheerful Latin American woman', source: 'builtin' },
	{ id: 'Alek', name: 'Alek', gender: 'Male', age: 'Adult', language: QWEN3_LANGUAGES, category: 'Russian', description: 'Cold yet warm Russian-flavored voice', source: 'builtin' },
	{ id: 'Dolce', name: 'Dolce', gender: 'Male', age: 'Adult', language: QWEN3_LANGUAGES, category: 'Italian', description: 'Laid-back Italian male voice', source: 'builtin' },
	{ id: 'Sohee', name: 'Sohee', gender: 'Female', age: 'Adult', language: QWEN3_LANGUAGES, category: 'Korean', description: 'Warm cheerful Korean voice', source: 'builtin' },
	{ id: 'Ono Anna', name: 'Ono Anna', gender: 'Female', age: 'Young adult', language: QWEN3_LANGUAGES, category: 'Japanese', description: 'Clever childhood friend voice', source: 'builtin' },
	{ id: 'Lenn', name: 'Lenn', gender: 'Male', age: 'Young adult', language: QWEN3_LANGUAGES, category: 'German', description: 'Rational and rebellious German youth', source: 'builtin' },
	{ id: 'Emilien', name: 'Emilien', gender: 'Male', age: 'Adult', language: QWEN3_LANGUAGES, category: 'French', description: 'Romantic French big brother voice', source: 'builtin' },
	{ id: 'Andre', name: 'Andre', gender: 'Male', age: 'Adult', language: QWEN3_LANGUAGES, category: 'Narration', description: 'Magnetic, natural, and steady male voice', source: 'builtin' },
	{ id: 'Radio Gol', name: 'Radio Gol', gender: 'Male', age: 'Adult', language: QWEN3_LANGUAGES, category: 'Sports', description: 'Football commentary voice', source: 'builtin' },
	{ id: 'Jada', name: 'Jada', gender: 'Female', age: 'Adult', language: 'sh/en/fr/de/ru/it/es/pt/ja/ko', category: 'Dialect', description: 'Fast-paced Shanghainese auntie', source: 'builtin' },
	{ id: 'Dylan', name: 'Dylan', gender: 'Male', age: 'Young adult', language: 'Beijing/en/fr/de/ru/it/es/pt/ja/ko', category: 'Dialect', description: 'Young man raised in Beijing hutongs', source: 'builtin' },
	{ id: 'Li', name: 'Li', gender: 'Male', age: 'Adult', language: 'Nanjing/en/fr/de/ru/it/es/pt/ja/ko', category: 'Dialect', description: 'Patient yoga teacher', source: 'builtin' },
	{ id: 'Marcus', name: 'Marcus', gender: 'Male', age: 'Adult', language: 'Shaanxi/en/fr/de/ru/it/es/pt/ja/ko', category: 'Dialect', description: 'Deep sincere Shaanxi voice', source: 'builtin' },
	{ id: 'Roy', name: 'Roy', gender: 'Male', age: 'Adult', language: 'Minnanyu/en/fr/de/ru/it/es/pt/ja/ko', category: 'Dialect', description: 'Humorous Southern Min male voice', source: 'builtin' },
	{ id: 'Peter', name: 'Peter', gender: 'Male', age: 'Adult', language: 'Tianjin/en/fr/de/ru/it/es/pt/ja/ko', category: 'Dialect', description: 'Tianjin-style crosstalk voice', source: 'builtin' },
	{ id: 'Sunny', name: 'Sunny', gender: 'Female', age: 'Young adult', language: 'Sichuan/en/fr/de/ru/it/es/pt/ja/ko', category: 'Dialect', description: 'Sweet Sichuan female voice', source: 'builtin' },
	{ id: 'Eric', name: 'Eric', gender: 'Male', age: 'Adult', language: 'Sichuan/en/fr/de/ru/it/es/pt/ja/ko', category: 'Dialect', description: 'Sichuanese male voice from Chengdu', source: 'builtin' },
	{ id: 'Rocky', name: 'Rocky', gender: 'Male', age: 'Adult', language: 'Cantonese/en/fr/de/ru/it/es/pt/ja/ko', category: 'Dialect', description: 'Humorous Cantonese male voice', source: 'builtin' },
	{ id: 'Kiki', name: 'Kiki', gender: 'Female', age: 'Young adult', language: 'Cantonese/en/fr/de/ru/it/es/pt/ja/ko', category: 'Dialect', description: 'Sweet Cantonese female voice', source: 'builtin' },
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

function builtinVoicesForModel(modelId: string): VoiceOption[] {
	if (modelId === 'cosyvoice-v3.5-plus' || modelId === 'cosyvoice-v3.5-flash') {
		return []
	}
	if (modelId === 'qwen3-tts-instruct-flash') return qwen3Voices.filter(voice => !qwen3InstructUnsupportedVoices.has(voice.id))
	if (modelId === 'qwen3-tts-flash') return qwen3Voices
	return []
}

function mergeVoices(voices: VoiceOption[]): VoiceOption[] {
	const byId = new Map<string, VoiceOption>()
	for (const voice of voices) {
		byId.set(voice.id, { ...byId.get(voice.id), ...voice })
	}
	return [...byId.values()]
}

export class DashScopeAudioProvider implements AudioProvider {
	name = 'DashScope'

	constructor(
		private apiKey: string,
		private app: App,
		private outputDir: string,
	) {}

	async generateAudio(prompt: string, options: { mode: 'tts' | 'music' | 'sound-effect'; modelId?: string; [k: string]: unknown }): Promise<GenerateAudioResult> {
		if (options.mode !== 'tts') {
			throw new Error('DashScope currently supports TTS only.')
		}

		const modelId = stringParam(options.modelId, 'cosyvoice-v3.5-plus')
		const voice = stringParam(options.voice, '')
		if (!voice) {
			throw new Error('DashScope TTS needs a voice. Pick a system/custom voice, or connect one upstream audio file to clone it first.')
		}

		const qwen = isQwenModel(modelId)
		const input: UnknownRecord = { text: prompt, voice }
		if (!qwen) {
			input.format = 'mp3'
			input.sample_rate = 24000
			const instruction = optionalStringParam(options.instruction)
			if (instruction) input.instruction = instruction
		} else {
			const languageType = optionalStringParam(options.language_type) || optionalStringParam(options.language)
			if (languageType) input.language_type = languageType
		}

		const resp = await requestUrl({
			url: qwen ? QWEN_TTS_URL : COSY_TTS_URL,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({ model: modelId, input }),
			throw: false,
		})

		if (isInvalidApiKeyResponse(resp)) throw new Error(`DashScope auth: ${parseErr(resp) || 'invalid API key.'}`)
		if (resp.status >= 400) throw new Error(`DashScope TTS: ${parseErr(resp)}`)

		const payload: unknown = resp.json
		const audioUrl = extractAudioUrl(payload)
		if (audioUrl) return this.downloadAudio(audioUrl, qwen ? 'qwen_tts' : 'cosyvoice_tts')

		const audioData = extractAudioData(payload)
		if (audioData) return this.saveBase64Audio(audioData, qwen ? 'qwen_tts' : 'cosyvoice_tts')

		throw new Error(`DashScope TTS: no audio URL in response - ${safePayloadSnippet(payload)}`)
	}

	async listVoices(options?: ListVoicesOptions): Promise<VoiceOption[]> {
		const modelId = options?.modelId || ''
		const source = options?.source || 'all'
		const voices = source === 'custom' ? [] : [...builtinVoicesForModel(modelId)]

		if (source !== 'builtin') try {
			voices.push(...await this.listCustomVoices(modelId))
		} catch (err) {
			if (voices.length === 0) throw err
		}

		const query = options?.query?.trim().toLowerCase()
		const merged = mergeVoices(voices)
		if (!query) return merged
		return merged.filter(voice => [
			voice.id,
			voice.name,
			voice.description,
			voice.gender,
			voice.age,
			voice.language,
			voice.category,
		].some(value => String(value || '').toLowerCase().includes(query)))
	}

	async cloneVoice(options: VoiceCloneOptions): Promise<VoiceCloneResult> {
		const modelId = options.modelId
		const qwen = isQwenModel(modelId)
		const input: UnknownRecord = qwen
			? {
				action: 'create',
				target_model: modelId,
				preferred_name: sanitizeQwenName(options.voiceNamePrefix || options.sourceHash),
				audio: { data: options.audioUrl },
			}
			: {
				action: 'create_voice',
				target_model: modelId,
				prefix: sanitizeCosyPrefix(options.voiceNamePrefix || options.sourceHash),
				url: options.audioUrl,
			}

		const resp = await requestUrl({
			url: CUSTOMIZATION_URL,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: qwen ? 'qwen-voice-enrollment' : 'voice-enrollment',
				input,
			}),
			throw: false,
		})

		if (isInvalidApiKeyResponse(resp)) throw new Error(`DashScope auth: ${parseErr(resp) || 'invalid API key.'}`)
		if (resp.status >= 400) throw new Error(`DashScope voice clone: ${parseErr(resp)}`)

		const payload: unknown = resp.json
		const voiceId = extractVoiceId(payload, qwen)
		if (!voiceId) throw new Error(`DashScope voice clone: no voice id in response - ${safePayloadSnippet(payload)}`)
		return {
			voiceId,
			name: voiceId,
		}
	}

	private async listCustomVoices(modelId: string): Promise<VoiceOption[]> {
		if (!modelId) return []
		const qwen = isQwenModel(modelId)
		const input: UnknownRecord = qwen
			? { action: 'list', page_size: 100, page_index: 0 }
			: { action: 'list_voice', page_size: 100, page_index: 0 }

		const resp = await requestUrl({
			url: CUSTOMIZATION_URL,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: qwen ? 'qwen-voice-enrollment' : 'voice-enrollment',
				input,
			}),
			throw: false,
		})

		if (isInvalidApiKeyResponse(resp)) throw new Error(`DashScope auth: ${parseErr(resp) || 'invalid API key.'}`)
		if (resp.status >= 400) throw new Error(`DashScope voice list: ${parseErr(resp)}`)

		const payload: unknown = resp.json
		const output = getAt(payload, ['output'])
		const list = isRecord(output) && Array.isArray(output.voice_list) ? output.voice_list : []
		return list
			.filter(isRecord)
			.map(record => toVoiceOption(record, qwen, modelId))
			.filter((voice): voice is VoiceOption => !!voice)
	}

	private async downloadAudio(url: string, prefix: string): Promise<{ filePath: string }> {
		const audioResponse = await requestUrl({ url })
		const ext = extensionFromUrl(url)
		const fileName = `${prefix}_${Date.now()}.${ext}`
		const outputDir = outputDirectoryPath(this.outputDir)
		const filePath = outputFilePath(this.outputDir, fileName)
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(outputDir)) await adapter.mkdir(outputDir)
		await adapter.writeBinary(filePath, audioResponse.arrayBuffer)
		return { filePath }
	}

	private async saveBase64Audio(data: string, prefix: string): Promise<{ filePath: string }> {
		const match = data.match(/^data:([^;]+);base64,(.+)$/)
		const base64 = match ? match[2] : data
		const mime = match?.[1] || 'audio/mpeg'
		const ext = mime.includes('wav') ? 'wav' : mime.includes('mp4') ? 'm4a' : mime.includes('opus') ? 'opus' : 'mp3'
		const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
		const outputDir = outputDirectoryPath(this.outputDir)
		const filePath = outputFilePath(this.outputDir, `${prefix}_${Date.now()}.${ext}`)
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(outputDir)) await adapter.mkdir(outputDir)
		await adapter.writeBinary(filePath, bytes.buffer)
		return { filePath }
	}
}

function extensionFromUrl(url: string): string {
	const clean = url.split('?')[0].toLowerCase()
	if (clean.endsWith('.wav')) return 'wav'
	if (clean.endsWith('.opus')) return 'opus'
	if (clean.endsWith('.m4a') || clean.endsWith('.mp4')) return 'm4a'
	if (clean.endsWith('.aac')) return 'aac'
	return 'mp3'
}

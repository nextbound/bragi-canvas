/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import type { AudioProvider, GenerateAudioResult, ListVoicesOptions, VoiceOption } from './types'

const TTS_URL = 'https://api.minimax.io/v1/t2a_v2'
const MUSIC_URL = 'https://api.minimax.io/v1/music_generation'
const VOICES_URL = 'https://api.minimax.io/v1/get_voice'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number') return String(value)
	return ''
}

function descriptionValue(value: unknown): string | undefined {
	if (typeof value === 'string' && value.trim()) return value.trim()
	if (Array.isArray(value)) {
		const parts = value.map(item => stringValue(item)).filter(Boolean)
		if (parts.length > 0) return parts.join(' ')
	}
	return undefined
}

function voiceTypeForSource(source?: 'builtin' | 'custom' | 'all'): string {
	if (source === 'builtin') return 'system'
	if (source === 'custom') return 'voice_cloning'
	return 'all'
}

function normalizeVoice(record: UnknownRecord, source: VoiceOption['source']): VoiceOption | null {
	const id = stringValue(record.voice_id || record.voiceId || record.id)
	if (!id) return null
	const name = stringValue(record.voice_name || record.name || record.voice_id || id)
	const description = descriptionValue(record.description)
	return {
		id,
		name: name || id,
		description,
		category: source === 'custom' ? 'Custom' : 'System',
		source,
	}
}

export class MiniMaxProvider implements AudioProvider {
	name = 'MiniMax'
	constructor(
		private apiKey: string,
		private app: App,
		private outputDir: string,
	) {}

	async generateAudio(prompt: string, options: { mode: 'tts' | 'music' | 'sound-effect', modelId?: string, [k: string]: unknown }): Promise<GenerateAudioResult> {
		if (options.mode === 'tts') return this.generateTTS(prompt, options)
		if (options.mode === 'music') return this.generateMusic(prompt, options)
		throw new Error(`MiniMax: unsupported audio mode "${options.mode}"`)
	}

	async listVoices(options?: ListVoicesOptions): Promise<VoiceOption[]> {
		const response = await requestUrl({
			url: VOICES_URL,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({ voice_type: voiceTypeForSource(options?.source) }),
			throw: false,
		})
		if (response.status === 401 || response.status === 403) throw new Error('MiniMax: invalid token')
		if (response.status >= 400) throw new Error(`MiniMax voices: status ${response.status}`)

		const data = response.json
		if (data?.base_resp?.status_code && data.base_resp.status_code !== 0) {
			throw new Error(`MiniMax voices: ${data.base_resp.status_msg || data.base_resp.status_code}`)
		}

		const voices: VoiceOption[] = []
		for (const key of ['system_voice', 'voice_cloning', 'voice_generation']) {
			const list = Array.isArray(data?.[key]) ? data[key] : []
			const source: VoiceOption['source'] = key === 'system_voice' ? 'builtin' : 'custom'
			for (const record of list) {
				if (!isRecord(record)) continue
				const voice = normalizeVoice(record, source)
				if (voice) voices.push(voice)
			}
		}

		const query = options?.query?.trim().toLowerCase()
		if (!query) return voices
		return voices.filter(voice => [
			voice.id,
			voice.name,
			voice.description,
			voice.category,
		].some(value => value?.toLowerCase().includes(query)))
	}

	async generateTTS(text: string, params?: Record<string, unknown>): Promise<{ filePath: string }> {
		const modelId = params?.modelId || 'speech-2.8-hd'
		const voiceId = params?.voice || 'English_Graceful_Lady'
		const speed = parseFloat(params?.speed || '1.0')

		const response = await requestUrl({
			url: TTS_URL,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: modelId,
				text,
				output_format: 'url',
				voice_setting: { voice_id: voiceId, speed },
			}),
		})

		const data = response.json
		if (data.base_resp?.status_code !== 0) {
			throw new Error(`MiniMax TTS: ${data.base_resp?.status_msg || 'Unknown error'}`)
		}

		const audioUrl = data.data?.audio
		if (!audioUrl) throw new Error('MiniMax TTS: No audio URL in response')

		return this.downloadAudio(audioUrl, 'tts')
	}

	async generateMusic(prompt: string, params?: Record<string, unknown>): Promise<{ filePath: string }> {
		const modelId = params?.modelId || 'music-2.6'
		const isInstrumental = params?.instrumental === 'true'
		const lyrics = params?.lyrics || ''

		const body: unknown = {
			model: modelId,
			prompt,
			is_instrumental: isInstrumental,
			output_format: 'url',
		}
		if (!isInstrumental && lyrics) {
			body.lyrics = lyrics
		}

		const response = await requestUrl({
			url: MUSIC_URL,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify(body),
		})

		const data = response.json
		if (data.base_resp?.status_code !== 0) {
			throw new Error(`MiniMax Music: ${data.base_resp?.status_msg || 'Unknown error'}`)
		}

		const audioUrl = data.data?.audio
		if (!audioUrl) throw new Error('MiniMax Music: No audio URL in response')

		return this.downloadAudio(audioUrl, 'music')
	}

	private async downloadAudio(url: string, prefix: string): Promise<{ filePath: string }> {
		const audioResponse = await requestUrl({ url })
		const timestamp = Date.now()
		const fileName = `${prefix}_${timestamp}.mp3`
		const filePath = `${this.outputDir}/${fileName}`

		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) {
			await adapter.mkdir(this.outputDir)
		}
		await adapter.writeBinary(filePath, audioResponse.arrayBuffer)

		return { filePath }
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

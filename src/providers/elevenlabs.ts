/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- ElevenLabs API responses arrive as runtime-shaped JSON narrowed at use sites. */
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import type { AudioProvider, GenerateAudioResult, ListVoicesOptions, VoiceChangeOptions, VoiceCloneOptions, VoiceCloneResult, VoiceOption } from './types'
import { optionalStringParam, stringParam } from './params'

const BASE_URL = 'https://api.elevenlabs.io'
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128'

type UnknownRecord = Record<string, unknown>

function voiceString(value: unknown, fallback = ''): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number') return String(value)
	return fallback
}

function isRecord(value: unknown): value is UnknownRecord {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function numericParam(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value !== 'string' || !value.trim()) return null
	const parsed = parseFloat(value)
	return Number.isFinite(parsed) ? parsed : null
}

function integerParam(value: unknown): number | null {
	const parsed = numericParam(value)
	if (parsed === null) return null
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function booleanParam(value: unknown): boolean | null {
	if (typeof value === 'boolean') return value
	if (typeof value === 'string') {
		if (value === 'true') return true
		if (value === 'false') return false
	}
	return null
}

function appendMultipartField(parts: Uint8Array[], boundary: string, name: string, value: string): void {
	const enc = new TextEncoder()
	parts.push(enc.encode(`--${boundary}\r\n`))
	parts.push(enc.encode(`Content-Disposition: form-data; name="${name}"\r\n\r\n`))
	parts.push(enc.encode(value))
	parts.push(enc.encode('\r\n'))
}

function appendMultipartFile(parts: Uint8Array[], boundary: string, name: string, filename: string, mime: string, bytes: Uint8Array): void {
	const enc = new TextEncoder()
	parts.push(enc.encode(`--${boundary}\r\n`))
	parts.push(enc.encode(`Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`))
	parts.push(enc.encode(`Content-Type: ${mime}\r\n\r\n`))
	parts.push(bytes)
	parts.push(enc.encode('\r\n'))
}

function concatBytes(parts: Uint8Array[]): ArrayBuffer {
	let total = 0
	for (const part of parts) total += part.length
	const body = new Uint8Array(total)
	let offset = 0
	for (const part of parts) {
		body.set(part, offset)
		offset += part.length
	}
	return body.buffer
}

function safeSnippet(value: unknown): string {
	try {
		return JSON.stringify(value).substring(0, 200)
	} catch {
		return String(value).substring(0, 200)
	}
}

function parseErr(resp: { status: number; text?: string; json?: unknown }): string {
	const body = typeof resp.json === 'undefined' ? resp.text : resp.json
	if (isRecord(body)) {
		const detail = body.detail
		if (typeof body.message === 'string') return body.message
		if (typeof body.error === 'string') return body.error
		if (typeof detail === 'string') return detail
		if (Array.isArray(detail) && detail.length > 0) return safeSnippet(detail)
	}
	return typeof resp.text === 'string' && resp.text ? resp.text : `HTTP ${resp.status}: ${safeSnippet(body)}`
}

function sanitizeVoiceName(sourceHash: string): string {
	return `bragi_${sourceHash.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || Date.now().toString(36)}`
}

/**
 * ElevenLabs native provider for audio generation.
 * Key difference from fal.ai: responses are binary audio streams, not URLs.
 */
export class ElevenLabsProvider implements AudioProvider {
	name = 'ElevenLabs'
	private apiKey: string
	private app: App
	private outputDir: string

	constructor(apiKey: string, app: App, outputDir: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
	}

	async generateAudio(prompt: string, options: { mode: 'tts' | 'music' | 'sound-effect', modelId?: string, [k: string]: unknown }): Promise<GenerateAudioResult> {
		if (options.mode === 'tts') return this.generateTTS(prompt, options)
		if (options.mode === 'music') return this.generateMusic(prompt, options)
		if (options.mode === 'sound-effect') return this.generateSFX(prompt, options)
		throw new Error('ElevenLabs: unsupported audio mode')
	}

	async listVoices(options?: ListVoicesOptions): Promise<VoiceOption[]> {
		const response = await requestUrl({
			url: `${BASE_URL}/v1/voices`,
			method: 'GET',
			headers: { 'xi-api-key': this.apiKey },
			throw: false,
		})
		if (response.status === 401 || response.status === 403) throw new Error('ElevenLabs: invalid API key')
		if (response.status >= 400) throw new Error(`ElevenLabs voices: status ${response.status}`)

		const voices = Array.isArray(response.json?.voices) ? response.json.voices : []
		const query = options?.query?.trim().toLowerCase()
		return voices.map((voice: unknown) => {
			const record = voice as Record<string, unknown>
			const labels = (record.labels || {}) as Record<string, string>
			return {
				id: voiceString(record.voice_id),
				name: voiceString(record.name, voiceString(record.voice_id, 'Untitled voice')),
				description: typeof record.description === 'string' ? record.description : labels.description || labels.use_case,
				gender: labels.gender,
				age: labels.age,
				language: labels.language || labels.accent,
				category: labels.use_case || (typeof record.category === 'string' ? record.category : undefined),
				previewUrl: typeof record.preview_url === 'string' ? record.preview_url : undefined,
				source: record.category === 'cloned' ? 'custom' : 'provider',
			}
		}).filter((voice: VoiceOption) => {
			if (!voice.id) return false
			if (!query) return true
			return [
				voice.id,
				voice.name,
				voice.description,
				voice.gender,
				voice.age,
				voice.language,
				voice.category,
			].some(value => String(value || '').toLowerCase().includes(query))
		})
	}

	async cloneVoice(options: VoiceCloneOptions): Promise<VoiceCloneResult> {
		if (!options.audioBytes) {
			throw new Error('ElevenLabs voice clone needs audio bytes from an upstream audio file.')
		}

		const voiceName = sanitizeVoiceName(options.voiceNamePrefix || options.sourceHash)
		const boundary = '----BragiElevenLabsBoundary' + Math.random().toString(36).slice(2)
		const parts: Uint8Array[] = []

		appendMultipartField(parts, boundary, 'name', voiceName)
		appendMultipartField(parts, boundary, 'remove_background_noise', 'false')
		appendMultipartFile(
			parts,
			boundary,
			'files',
			options.filename || 'voice.mp3',
			options.mimeType || 'audio/mpeg',
			new Uint8Array(options.audioBytes),
		)
		parts.push(new TextEncoder().encode(`--${boundary}--\r\n`))

		const response = await requestUrl({
			url: `${BASE_URL}/v1/voices/add`,
			method: 'POST',
			headers: {
				'Content-Type': `multipart/form-data; boundary=${boundary}`,
				'xi-api-key': this.apiKey,
			},
			body: concatBytes(parts),
			throw: false,
		})

		if (response.status === 401 || response.status === 403) throw new Error(`ElevenLabs auth: ${parseErr(response)}`)
		if (response.status >= 400) throw new Error(`ElevenLabs voice clone: ${parseErr(response)}`)

		const payload: unknown = response.json
		if (!isRecord(payload) || typeof payload.voice_id !== 'string') {
			throw new Error(`ElevenLabs voice clone: no voice_id in response - ${safeSnippet(payload)}`)
		}

		return {
			voiceId: payload.voice_id,
			name: voiceName,
			requiresVerification: typeof payload.requires_verification === 'boolean' ? payload.requires_verification : undefined,
		}
	}

	/**
	 * Voice Changer: POST /v1/speech-to-speech/{voice_id}
	 * The source audio supplies content, timing, and emotion; voice_id supplies
	 * the target voice created from the incoming reference audio.
	 */
	async changeVoice(options: VoiceChangeOptions): Promise<GenerateAudioResult> {
		if (!options.audioBytes) {
			throw new Error('ElevenLabs Voice Changer needs source audio bytes.')
		}

		const modelId = options.modelId || 'eleven_multilingual_sts_v2'
		const outputFormat = options.outputFormat || DEFAULT_OUTPUT_FORMAT
		const boundary = '----BragiElevenLabsBoundary' + Math.random().toString(36).slice(2)
		const parts: Uint8Array[] = []

		appendMultipartFile(
			parts,
			boundary,
			'audio',
			options.filename || 'source.mp3',
			options.mimeType || 'audio/mpeg',
			new Uint8Array(options.audioBytes),
		)
		appendMultipartField(parts, boundary, 'model_id', modelId)
		parts.push(new TextEncoder().encode(`--${boundary}--\r\n`))

		const response = await requestUrl({
			url: `${BASE_URL}/v1/speech-to-speech/${encodeURIComponent(options.voiceId)}?output_format=${encodeURIComponent(outputFormat)}`,
			method: 'POST',
			headers: {
				'Content-Type': `multipart/form-data; boundary=${boundary}`,
				'xi-api-key': this.apiKey,
			},
			body: concatBytes(parts),
			throw: false,
		})

		if (response.status === 401 || response.status === 403) {
			throw new Error(`ElevenLabs Voice Changer auth: ${parseErr(response)}`)
		}
		if (response.status >= 400) {
			throw new Error(`ElevenLabs Voice Changer: ${parseErr(response)}`)
		}

		return this.saveAudio(response.arrayBuffer, 'voice_changer')
	}

	/**
	 * TTS: POST /v1/text-to-speech/{voice_id}
	 * Returns binary mp3 directly.
	 */
	async generateTTS(text: string, params?: Record<string, unknown>): Promise<{ filePath: string }> {
		const voiceId = stringParam(params?.voice, '21m00Tcm4TlvDq8ikWAM') // Rachel default
		const modelId = stringParam(params?.modelId, 'eleven_v3')
		const outputFormat = stringParam(params?.output_format, DEFAULT_OUTPUT_FORMAT)
		const query = outputFormat ? `?output_format=${encodeURIComponent(outputFormat)}` : ''

		const voiceSettings: UnknownRecord = {}
		const stability = numericParam(params?.stability)
		const similarityBoost = numericParam(params?.similarity_boost)
		const style = numericParam(params?.style)
		const speed = numericParam(params?.speed)
		const useSpeakerBoost = booleanParam(params?.use_speaker_boost)
		if (stability !== null) voiceSettings.stability = stability
		if (similarityBoost !== null) voiceSettings.similarity_boost = similarityBoost
		if (style !== null) voiceSettings.style = style
		if (speed !== null) voiceSettings.speed = speed
		if (useSpeakerBoost !== null) voiceSettings.use_speaker_boost = useSpeakerBoost

		const body: UnknownRecord = {
			text,
			model_id: modelId,
		}
		const languageCode = optionalStringParam(params?.language_code)
		if (languageCode) body.language_code = languageCode
		const seed = integerParam(params?.seed)
		if (seed !== null) body.seed = seed
		const applyTextNormalization = optionalStringParam(params?.apply_text_normalization) || 'auto'
		body.apply_text_normalization = applyTextNormalization
		if (Object.keys(voiceSettings).length > 0) body.voice_settings = voiceSettings

		const response = await requestUrl({
			url: `${BASE_URL}/v1/text-to-speech/${voiceId}${query}`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'xi-api-key': this.apiKey,
			},
			body: JSON.stringify(body),
			throw: false,
		})
		if (response.status === 401 || response.status === 403) throw new Error(`ElevenLabs auth: ${parseErr(response)}`)
		if (response.status >= 400) throw new Error(`ElevenLabs TTS: ${parseErr(response)}`)

		return this.saveAudio(response.arrayBuffer, 'tts')
	}

	/**
	 * Music: POST /v1/music
	 * Returns binary mp3 directly.
	 */
	async generateMusic(prompt: string, params?: Record<string, unknown>): Promise<{ filePath: string }> {
		const body: unknown = {
			prompt,
			model_id: 'music_v1',
		}

		const musicLengthMs = optionalStringParam(params?.music_length_ms)
		if (musicLengthMs) {
			body.music_length_ms = parseInt(musicLengthMs, 10) * 1000
		}
		if (params?.instrumental === 'true') {
			body.force_instrumental = true
		}

		const response = await requestUrl({
			url: `${BASE_URL}/v1/music`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'xi-api-key': this.apiKey,
			},
			body: JSON.stringify(body),
		})

		return this.saveAudio(response.arrayBuffer, 'music')
	}

	/**
	 * Sound Effects: POST /v1/sound-generation
	 * Returns binary mp3 directly.
	 */
	async generateSFX(text: string, params?: Record<string, unknown>): Promise<{ filePath: string }> {
		const body: unknown = {
			text,
			model_id: 'eleven_text_to_sound_v2',
		}

		const duration = optionalStringParam(params?.duration)
		if (duration) {
			const parsed = parseFloat(duration)
			if (Number.isFinite(parsed)) body.duration_seconds = clamp(parsed, 0.5, 30)
		}

		const response = await requestUrl({
			url: `${BASE_URL}/v1/sound-generation`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'xi-api-key': this.apiKey,
			},
			body: JSON.stringify(body),
		})

		return this.saveAudio(response.arrayBuffer, 'sfx')
	}

	private async saveAudio(data: ArrayBuffer, prefix: string): Promise<{ filePath: string }> {
		const timestamp = Date.now()
		const fileName = `${prefix}_${timestamp}.mp3`
		const filePath = `${this.outputDir}/${fileName}`

		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) {
			await adapter.mkdir(this.outputDir)
		}

		await adapter.writeBinary(filePath, data)
		return { filePath }
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max)
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Resume strict linting after the runtime-shaped data boundary. */

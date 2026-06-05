/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import type { AudioProvider, GenerateAudioResult } from './types'
import { optionalStringParam } from './params'

/**
 * fal.ai audio wrapper — submits to `https://fal.run/{apiModelId}` and downloads the resulting URL.
 * Handles TTS / music / sound-effect modes by shaping the request body accordingly.
 */
export class FalAudioProvider implements AudioProvider {
	name = 'fal.ai'
	private apiKey: string
	private app: App
	private outputDir: string

	constructor(apiKey: string, app: App, outputDir: string) {
		this.apiKey = apiKey
		this.app = app
		this.outputDir = outputDir
	}

	async generateAudio(prompt: string, options: { mode: 'tts' | 'music' | 'sound-effect', modelId?: string, upstreamPrompts?: string[], [k: string]: unknown }): Promise<GenerateAudioResult> {
		const apiModelId = options.modelId
		if (!apiModelId) throw new Error('fal audio: modelId required')

		const body = buildAudioInput(prompt, options, apiModelId, options.mode, options.upstreamPrompts)

		const response = await requestUrl({
			url: `https://fal.run/${apiModelId}`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Key ${this.apiKey}`,
			},
			body: JSON.stringify(body),
			throw: false,
		})
		if (response.status < 200 || response.status >= 300) {
			throw new Error(`fal.ai audio: ${parseErr(response)}`)
		}

		const data = response.json
		const audioUrl = data.audio?.url || data.audio_url || data.audio?.audio_url
		if (!audioUrl) {
			throw new Error(`fal.ai audio: No audio URL in response — ${JSON.stringify(data).substring(0, 200)}`)
		}

		const audioResponse = await requestUrl({ url: audioUrl })
		const timestamp = Date.now()
		const fileName = `audio_${timestamp}.mp3`
		const filePath = `${this.outputDir}/${fileName}`
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) await adapter.mkdir(this.outputDir)
		await adapter.writeBinary(filePath, audioResponse.arrayBuffer)

		return { filePath }
	}
}

function parseErr(response: { status: number; json?: unknown; text?: string }): string {
	const data = response.json
	if (isRecord(data)) {
		const detail = data.detail
		if (Array.isArray(detail) && detail.length > 0) {
			const first = detail[0]
			if (isRecord(first)) {
				const loc = Array.isArray(first.loc) ? first.loc.join('.') : ''
				const msg = typeof first.msg === 'string' ? first.msg : ''
				if (loc || msg) return `${response.status} ${loc ? `${loc}: ` : ''}${msg}`.trim()
			}
		}
		if (typeof detail === 'string' && detail) return `${response.status} ${detail}`
		if (typeof data.message === 'string' && data.message) return `${response.status} ${data.message}`
		return `${response.status} ${JSON.stringify(data).substring(0, 500)}`
	}
	return `${response.status} ${(response.text || '').substring(0, 500)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function buildAudioInput(prompt: string, params: Record<string, unknown>, apiModelId: string, mode: unknown, upstreamPrompts?: string[]): unknown {
	const input: Record<string, unknown> = {}
	if (mode === 'tts') {
		const voice = stringParam(params.voice)
		if (apiModelId.includes('/elevenlabs/tts/')) {
			input.text = prompt
			if (voice) input.voice = voice
			const speed = numericParam(params.speed)
			if (speed !== null) input.speed = speed
		} else if (apiModelId.includes('/minimax/')) {
			input.prompt = prompt
			input.output_format = 'url'
			const voiceSetting: Record<string, unknown> = {}
			if (voice) voiceSetting.voice_id = voice
			const speed = numericParam(params.speed)
			if (speed !== null) voiceSetting.speed = speed
			if (Object.keys(voiceSetting).length > 0) input.voice_setting = voiceSetting
		} else {
			input.text = prompt
			if (voice) input.voice_id = voice
			const speed = numericParam(params.speed)
			if (speed !== null) input.speed = speed
		}
	} else if (mode === 'music') {
		input.prompt = prompt
		const musicLengthMs = optionalStringParam(params.music_length_ms)
		if (musicLengthMs) {
			input.music_length_ms = parseInt(musicLengthMs, 10) * 1000
		}
		if (params.instrumental === 'true') {
			input.force_instrumental = true
			input.is_instrumental = true
		} else {
			input.is_instrumental = false
			if (upstreamPrompts && upstreamPrompts.length > 0) {
				input.lyrics = upstreamPrompts.join('\n')
			}
		}
	} else if (mode === 'sound-effect') {
		input.text = prompt
		const duration = numericParam(params.duration)
		if (duration !== null) {
			if (apiModelId === 'fal-ai/elevenlabs/sound-effects/v2' && duration > 22) {
				throw new Error('fal.ai ElevenLabs Sound Effects supports up to 22 seconds. Choose 20s or switch the model provider to native ElevenLabs for 30s.')
			}
			input.duration_seconds = duration
		}
	} else {
		input.prompt = prompt
	}
	return input
}

function numericParam(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value !== 'string' || !value.trim()) return null
	const parsed = parseFloat(value)
	return Number.isFinite(parsed) ? parsed : null
}

function stringParam(value: unknown): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number' && Number.isFinite(value)) return String(value)
	return ''
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

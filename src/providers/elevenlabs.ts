import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import type { AudioProvider, GenerateAudioResult } from './types'

const BASE_URL = 'https://api.elevenlabs.io'

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

	async generateAudio(prompt: string, options: { mode: 'tts' | 'music' | 'sound-effect', modelId?: string, [k: string]: any }): Promise<GenerateAudioResult> {
		if (options.mode === 'tts') return this.generateTTS(prompt, options)
		if (options.mode === 'music') return this.generateMusic(prompt, options)
		if (options.mode === 'sound-effect') return this.generateSFX(prompt, options)
		throw new Error(`ElevenLabs: unsupported audio mode "${options.mode}"`)
	}

	/**
	 * TTS: POST /v1/text-to-speech/{voice_id}
	 * Returns binary mp3 directly.
	 */
	async generateTTS(text: string, params?: Record<string, any>): Promise<{ filePath: string }> {
		const voiceId = params?.voice || '21m00Tcm4TlvDq8ikWAM' // Rachel default
		const modelId = params?.modelId || 'eleven_v3'

		const response = await requestUrl({
			url: `${BASE_URL}/v1/text-to-speech/${voiceId}`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'xi-api-key': this.apiKey,
			},
			body: JSON.stringify({
				text,
				model_id: modelId,
			}),
		})

		return this.saveAudio(response.arrayBuffer, 'tts')
	}

	/**
	 * Music: POST /v1/music
	 * Returns binary mp3 directly.
	 */
	async generateMusic(prompt: string, params?: Record<string, any>): Promise<{ filePath: string }> {
		const body: any = {
			prompt,
			model_id: 'music_v1',
		}

		if (params?.music_length_ms) {
			body.music_length_ms = parseInt(String(params.music_length_ms)) * 1000
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
	async generateSFX(text: string, params?: Record<string, any>): Promise<{ filePath: string }> {
		const body: any = {
			text,
			model_id: 'eleven_text_to_sound_v2',
		}

		if (params?.duration) {
			body.duration_seconds = parseFloat(String(params.duration))
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

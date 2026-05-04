import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import type { AudioProvider, GenerateAudioResult } from './types'

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

	async generateAudio(prompt: string, options: { mode: 'tts' | 'music' | 'sound-effect', modelId?: string, upstreamPrompts?: string[], [k: string]: any }): Promise<GenerateAudioResult> {
		const apiModelId = options.modelId
		if (!apiModelId) throw new Error('fal audio: modelId required')

		const body = buildAudioInput(prompt, options as Record<string, any>, options.mode, options.upstreamPrompts)

		const response = await requestUrl({
			url: `https://fal.run/${apiModelId}`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Key ${this.apiKey}`,
			},
			body: JSON.stringify(body),
		})

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

function buildAudioInput(prompt: string, params: Record<string, any>, mode: any, upstreamPrompts?: string[]): any {
	const input: any = {}
	if (mode === 'tts') {
		input.text = prompt
		if (params.voice) input.voice_id = params.voice
		if (params.speed) input.speed = parseFloat(params.speed)
	} else if (mode === 'music') {
		input.prompt = prompt
		if (params.music_length_ms) {
			input.music_length_ms = parseInt(String(params.music_length_ms)) * 1000
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
		if (params.duration) input.duration_seconds = parseFloat(params.duration)
	} else {
		input.prompt = prompt
	}
	return input
}

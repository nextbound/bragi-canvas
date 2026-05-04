import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import type { AudioProvider, GenerateAudioResult } from './types'

const TTS_URL = 'https://api.minimax.io/v1/t2a_v2'
const MUSIC_URL = 'https://api.minimax.io/v1/music_generation'

export class MiniMaxProvider implements AudioProvider {
	name = 'MiniMax'
	constructor(
		private apiKey: string,
		private app: App,
		private outputDir: string,
	) {}

	async generateAudio(prompt: string, options: { mode: 'tts' | 'music' | 'sound-effect', modelId?: string, [k: string]: any }): Promise<GenerateAudioResult> {
		if (options.mode === 'tts') return this.generateTTS(prompt, options)
		if (options.mode === 'music') return this.generateMusic(prompt, options)
		throw new Error(`MiniMax: unsupported audio mode "${options.mode}"`)
	}

	async generateTTS(text: string, params?: Record<string, any>): Promise<{ filePath: string }> {
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

	async generateMusic(prompt: string, params?: Record<string, any>): Promise<{ filePath: string }> {
		const modelId = params?.modelId || 'music-2.6'
		const isInstrumental = params?.instrumental === 'true'
		const lyrics = params?.lyrics || ''

		const body: any = {
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

/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import type { App } from 'obsidian'
import { requestUrl } from 'obsidian'
import type { AudioProvider, GenerateAudioResult, ListVoicesOptions, VoiceCloneOptions, VoiceCloneResult, VoiceOption } from './types'

const TTS_URL = 'https://api.minimax.io/v1/t2a_v2'
const MUSIC_URL = 'https://api.minimax.io/v1/music_generation'
const VOICES_URL = 'https://api.minimax.io/v1/get_voice'
const FILE_UPLOAD_URL = 'https://api.minimax.io/v1/files/upload'
const VOICE_CLONE_URL = 'https://api.minimax.io/v1/voice_clone'

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number') return String(value)
	return ''
}

function numericParam(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value !== 'string' || !value.trim()) return null
	const parsed = parseFloat(value)
	return Number.isFinite(parsed) ? parsed : null
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
		const baseResp = body.base_resp
		if (isRecord(baseResp) && typeof baseResp.status_msg === 'string' && baseResp.status_msg) return baseResp.status_msg
		if (typeof body.message === 'string') return body.message
		if (typeof body.error === 'string') return body.error
	}
	return typeof resp.text === 'string' && resp.text ? resp.text : `HTTP ${resp.status}: ${safeSnippet(body)}`
}

function baseRespMessage(data: unknown): string | null {
	if (!isRecord(data)) return null
	const baseResp = data.base_resp
	if (!isRecord(baseResp)) return null
	const status = baseResp.status_code
	const ok = status === 0 || status === '0' || typeof status === 'undefined'
	if (ok) return null
	return stringValue(baseResp.status_msg) || stringValue(status) || 'Unknown error'
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

function getFileExtension(filePath: string, fallback: string): string {
	return filePath.split('.').pop()?.toLowerCase() || fallback
}

function supportedCloneFile(filename: string): boolean {
	return ['mp3', 'm4a', 'wav'].includes(getFileExtension(filename, 'mp3'))
}

function sanitizeVoiceId(sourceHash: string): string {
	const clean = sourceHash.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 48)
	const id = `Bragi_${clean || Date.now().toString(36)}`
	return id.replace(/[-_]+$/g, '').slice(0, 256)
}

function fileIdFromUploadResponse(resp: { text?: string; json?: unknown }): string {
	if (typeof resp.text === 'string') {
		const match = resp.text.match(/"file_id"\s*:\s*"?(\d+)"?/)
		if (match) return match[1]
	}
	const data = resp.json
	if (isRecord(data) && isRecord(data.file)) {
		const id = data.file.file_id
		if (typeof id === 'string' && id.trim()) return id.trim()
		if (typeof id === 'number' && Number.isFinite(id)) return String(Math.trunc(id))
	}
	return ''
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

	async cloneVoice(options: VoiceCloneOptions): Promise<VoiceCloneResult> {
		if (!options.audioBytes) {
			throw new Error('MiniMax voice clone needs audio bytes from an upstream audio file.')
		}
		const filename = options.filename || 'voice.mp3'
		if (!supportedCloneFile(filename)) {
			throw new Error('MiniMax voice clone supports mp3, m4a, and wav source audio.')
		}

		const voiceId = sanitizeVoiceId(options.voiceNamePrefix || options.sourceHash)
		const fileId = await this.uploadCloneAudio(options.audioBytes, filename, options.mimeType || 'audio/mpeg')
		const response = await requestUrl({
			url: VOICE_CLONE_URL,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: `{"file_id":${fileId},"voice_id":${JSON.stringify(voiceId)},"need_noise_reduction":false,"need_volume_normalization":false}`,
			throw: false,
		})

		if (response.status === 401 || response.status === 403) throw new Error('MiniMax: invalid token')
		if (response.status >= 400) throw new Error(`MiniMax voice clone: ${parseErr(response)}`)

		const data = response.json
		const err = baseRespMessage(data)
		if (err) throw new Error(`MiniMax voice clone: ${err}`)

		const demoAudio = isRecord(data) ? stringValue(data.demo_audio || data.preview_audio) : ''
		return {
			voiceId,
			name: voiceId,
			previewUrl: demoAudio || undefined,
		}
	}

	async generateTTS(text: string, params?: Record<string, unknown>): Promise<{ filePath: string }> {
		const modelId = params?.modelId || 'speech-2.8-hd'
		const voiceId = params?.voice || 'English_Graceful_Lady'
		const speed = numericParam(params?.speed) ?? 1.0

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
		const nodePrompt = typeof params?.nodePrompt === 'string' ? params.nodePrompt : prompt
		const lyrics = Array.isArray(params?.upstreamPrompts)
			? params.upstreamPrompts.filter((value): value is string => typeof value === 'string' && !!value.trim()).join('\n')
			: typeof params?.lyrics === 'string' ? params.lyrics : ''

		const body: unknown = {
			model: modelId,
			prompt: nodePrompt,
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

	private async uploadCloneAudio(audioBytes: ArrayBuffer, filename: string, mimeType: string): Promise<string> {
		const boundary = '----BragiMiniMaxBoundary' + Math.random().toString(36).slice(2)
		const parts: Uint8Array[] = []
		appendMultipartField(parts, boundary, 'purpose', 'voice_clone')
		appendMultipartFile(parts, boundary, 'file', filename, mimeType, new Uint8Array(audioBytes))
		parts.push(new TextEncoder().encode(`--${boundary}--\r\n`))

		const response = await requestUrl({
			url: FILE_UPLOAD_URL,
			method: 'POST',
			headers: {
				'Content-Type': `multipart/form-data; boundary=${boundary}`,
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: concatBytes(parts),
			throw: false,
		})

		if (response.status === 401 || response.status === 403) throw new Error('MiniMax: invalid token')
		if (response.status >= 400) throw new Error(`MiniMax voice clone upload: ${parseErr(response)}`)

		const data = response.json
		const err = baseRespMessage(data)
		if (err) throw new Error(`MiniMax voice clone upload: ${err}`)

		const fileId = fileIdFromUploadResponse(response)
		if (!fileId) throw new Error(`MiniMax voice clone upload: no file_id in response - ${safeSnippet(data)}`)
		return fileId
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

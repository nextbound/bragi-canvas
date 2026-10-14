import { normalizePath, requestUrl, type App } from 'obsidian'
import { errorMessage } from '../task-errors'
import type { AudioProvider, GenerateAudioResult, VoicePreviewOptions, VoicePreviewResult } from './types'

const API_BASE = 'https://api.breeze.blue/v1'
type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : {}
}

function responseError(value: unknown, status: number): string {
	const data = record(value)
	const message = data.detail || record(data.error).message || data.error
	return typeof message === 'string' ? message.slice(0, 500) : `HTTP ${status}`
}

function previewText(value: string, label: string): string {
	const text = value.trim()
	const length = [...text].length
	if (length < 3 || length > 500) throw new Error(`BreezeBlue ${label} must contain 3–500 characters.`)
	return text
}

export function buildBreezeBluePreviewRequest(options: VoicePreviewOptions): UnknownRecord {
	const count = Number(options.previewCount ?? 1)
	if (!Number.isInteger(count) || count < 1 || count > 3) {
		throw new Error('BreezeBlue supports 1–3 candidates per request.')
	}
	return {
		model_id: options.modelId,
		voice_description: previewText(options.voicePrompt, 'voice description'),
		text: previewText(options.previewText, 'preview script'),
		preview_count: count,
	}
}

export class BreezeBlueProvider implements AudioProvider {
	name = 'BreezeBlue'

	constructor(private apiKey: string, private app: App, private outputDir: string) {}

	generateAudio(): Promise<GenerateAudioResult> {
		return Promise.reject(new Error('BreezeBlue needs Design with an upstream voice description and a script in the current node.'))
	}

	async generateVoicePreviews(options: VoicePreviewOptions): Promise<VoicePreviewResult> {
		const body = buildBreezeBluePreviewRequest(options)
		const response = await requestUrl({
			url: `${API_BASE}/voice-previews/design`,
			method: 'POST',
			headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			throw: false,
		})
		const data: unknown = response.json
		if (response.status >= 400) throw new Error(`BreezeBlue voice design: ${responseError(data, response.status)}`)
		const previews = record(data).previews
		if (!Array.isArray(previews) || previews.length !== body.preview_count) {
			throw new Error('BreezeBlue did not return the requested number of voice candidates.')
		}
		// Decode every candidate before writing files. Temporary voice IDs are not needed for audio references.
		const audio = previews.map((value: unknown) => {
			const preview = record(value)
			const extensions: Record<string, string> = {
				'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/vnd.wave': 'wav',
				'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
			}
			const mediaType = typeof preview.media_type === 'string' ? preview.media_type.split(';')[0]?.trim().toLowerCase() : ''
			const extension = extensions[mediaType || '']
			if (!extension || typeof preview.audio_base_64 !== 'string' || !preview.audio_base_64) {
				throw new Error('BreezeBlue returned a candidate without supported audio.')
			}
			let bytes: Uint8Array<ArrayBuffer>
			try {
				bytes = Uint8Array.from(atob(preview.audio_base_64), char => char.charCodeAt(0))
			} catch {
				throw new Error('BreezeBlue returned invalid candidate audio.')
			}
			if (!bytes.length) throw new Error('BreezeBlue returned empty candidate audio.')
			return { bytes, extension }
		})
		const directory = normalizePath(this.outputDir)
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(directory)) await adapter.mkdir(directory)
		const group = crypto.randomUUID()
		const filePaths: string[] = []
		for (const [index, candidate] of audio.entries()) {
			const path = normalizePath(`${directory}/breezeblue_${group}_${index + 1}.${candidate.extension}`)
			await adapter.writeBinary(path, candidate.bytes.buffer)
			filePaths.push(path)
		}
		return { filePaths }
	}
}

export async function testBreezeBlueConnection(apiKey: string): Promise<{ ok: boolean; message: string }> {
	if (!apiKey.trim()) return { ok: false, message: 'API key is empty.' }
	try {
		const response = await requestUrl({ url: `${API_BASE}/models`, headers: { 'xi-api-key': apiKey }, throw: false })
		if (response.status !== 200) return { ok: false, message: responseError(response.json as unknown, response.status) }
		return { ok: true, message: 'Connected.' }
	} catch (error: unknown) {
		return { ok: false, message: `Network error: ${errorMessage(error)}` }
	}
}

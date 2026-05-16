import { requestUrl } from 'obsidian'
import type { VoiceOption } from './providers/types'

const VOICE_SAMPLES_BASE_URL = 'https://api.bragi.now/voice-samples/v1'

interface VoiceSampleListResponse {
	voices?: unknown
}

interface VoiceSampleRecord {
	id?: unknown
	name?: unknown
	sample?: unknown
	description?: unknown
	language?: unknown
	gender?: unknown
	age?: unknown
	tags?: unknown
}

export async function listPublicVoiceSamples(modelId: string): Promise<VoiceOption[]> {
	const response = await requestUrl({
		url: `${VOICE_SAMPLES_BASE_URL}/${encodeURIComponent(modelId)}/list.json`,
		method: 'GET',
		throw: false,
	})

	if (response.status === 404) return []
	if (response.status >= 400) throw new Error(`Bragi voice samples: status ${response.status}`)

	const data = response.json as VoiceSampleListResponse
	const records = Array.isArray(data?.voices) ? data.voices : []
	return records
		.map(record => normalizeVoiceSample(record))
		.filter((voice): voice is VoiceOption => !!voice)
}

function normalizeVoiceSample(value: unknown): VoiceOption | null {
	if (!isRecord(value)) return null
	const record = value as VoiceSampleRecord
	const id = stringValue(record.id)
	const name = stringValue(record.name)
	const sample = stringValue(record.sample)
	if (!id || !name || !sample) return null

	return compactVoice({
		id,
		name,
		description: stringValue(record.description),
		language: stringArrayValue(record.language),
		gender: stringValue(record.gender),
		age: stringValue(record.age),
		tags: stringArrayValue(record.tags),
		previewUrl: sample,
		source: 'builtin',
	})
}

function compactVoice(voice: VoiceOption): VoiceOption {
	const next: VoiceOption = {
		id: voice.id,
		name: voice.name,
		source: voice.source,
	}
	if (voice.description) next.description = voice.description
	if (voice.language && (!Array.isArray(voice.language) || voice.language.length > 0)) next.language = voice.language
	if (voice.gender) next.gender = voice.gender
	if (voice.age) next.age = voice.age
	if (voice.tags && voice.tags.length > 0) next.tags = voice.tags
	if (voice.previewUrl) next.previewUrl = voice.previewUrl
	return next
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function stringValue(value: unknown): string {
	return typeof value === 'string' ? value.trim() : ''
}

function stringArrayValue(value: unknown): string[] | undefined {
	if (typeof value === 'string') return value.trim() ? [value.trim()] : undefined
	if (!Array.isArray(value)) return undefined
	const strings = value
		.filter((item): item is string => typeof item === 'string')
		.map(item => item.trim())
		.filter(Boolean)
	return strings.length > 0 ? strings : undefined
}

import { writeTaskResult, pollRequest, assertPendingStatus, TaskPollingError } from '../task-errors'
import type { App } from 'obsidian'
import { normalizePath, requestUrl } from 'obsidian'
import type {
	AudioProvider,
	GenerateAudioResult,
	GenerateVideoResult,
	ListVoicesOptions,
	VideoProvider,
	VoiceCloneOptions,
	VoiceCloneResult,
	VoiceDesignOptions,
	VoiceDesignResult,
	VoiceOption,
} from './types'
import { optionalStringParam, stringParam } from './params'
import { uploadRef } from './upload'

export const DEFAULT_DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1'
const QWEN_TTS_PATH = '/services/aigc/multimodal-generation/generation'
const COSY_TTS_PATH = '/services/audio/tts/SpeechSynthesizer'
const CUSTOMIZATION_PATH = '/services/audio/tts/customization'
const VIDEO_SYNTHESIS_PATH = '/services/aigc/video-generation/video-synthesis'
const TASK_PATH = '/tasks'
const WAN27_T2V = 'wan2.7-t2v-2026-04-25'
const WAN27_I2V = 'wan2.7-i2v-2026-04-25'
const WAN27_R2V = 'wan2.7-r2v'
const WAN27_VIDEOEDIT = 'wan2.7-videoedit'
const WAN30_VIDEO = 'wan3.0-video'
const HAPPYHORSE_T2V = 'happyhorse-1.1-t2v'
const HAPPYHORSE_I2V = 'happyhorse-1.1-i2v'
const HAPPYHORSE_R2V = 'happyhorse-1.1-r2v'
// Alibaba ships no 1.1 build of the editing model; 1.0 is its latest version.
const HAPPYHORSE_VIDEO_EDIT = 'happyhorse-1.0-video-edit'
const HAPPYHORSE_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '4:5', '5:4', '21:9', '9:21']
const VIDEO_DONE_STATUSES = new Set(['SUCCEEDED', 'SUCCESS', 'COMPLETED'])
const VIDEO_FAILED_STATUSES = new Set(['FAILED', 'FAILURE', 'ERROR', 'CANCELED', 'CANCELLED', 'UNKNOWN'])

type UnknownRecord = Record<string, unknown>

export function normalizeDashScopeBaseUrl(baseUrl?: string): string {
	const trimmed = (baseUrl || '').trim()
	return (trimmed || DEFAULT_DASHSCOPE_BASE_URL).replace(/\/+$/, '')
}

export function dashScopeUrl(baseUrl: string | undefined, path: string): string {
	const normalizedPath = path.startsWith('/') ? path : `/${path}`
	return `${normalizeDashScopeBaseUrl(baseUrl)}${normalizedPath}`
}

export function dashScopeRegion(baseUrl?: string): string {
	try {
		const host = new URL(normalizeDashScopeBaseUrl(baseUrl)).hostname
		const match = host.match(/\.([a-z]+-[a-z]+-\d+)\.maas\.aliyuncs\.com$/)
		if (match?.[1]) return match[1]
		if (host === 'dashscope.aliyuncs.com') return 'cn-beijing'
		return host
	} catch {
		return 'cn-beijing'
	}
}

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

function extractPreviewAudio(json: unknown): string | null {
	const paths = [
		['output', 'preview_audio', 'url'],
		['output', 'preview_audio', 'public_url'],
		['preview_audio', 'url'],
		['preview_audio', 'public_url'],
	]
	for (const path of paths) {
		const value = getStringAt(json, path)
		if (value && /^https?:\/\//i.test(value)) return value
	}
	return null
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

function stringList(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function optionalBooleanParam(value: unknown): boolean | undefined {
	if (typeof value === 'boolean') return value
	if (typeof value === 'number') return value !== 0
	if (typeof value !== 'string') return undefined
	const normalized = value.trim().toLowerCase()
	if (!normalized) return undefined
	if (['false', '0', 'off', 'no'].includes(normalized)) return false
	return true
}

function optionalNumberParam(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value
	if (typeof value !== 'string') return undefined
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : undefined
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
	const parsed = optionalNumberParam(value)
	const n = parsed === undefined ? fallback : Math.round(parsed)
	return Math.min(Math.max(n, min), max)
}

function normalizeResolution(value: unknown): string {
	const text = stringParam(value, '720P').trim().toUpperCase()
	return text === '1080P' ? '1080P' : '720P'
}

/** 480P / 720P / 1080P tier, shared by Wan 3.0 and HappyHorse. */
function normalizeResolutionTier(value: unknown): string {
	const text = stringParam(value, '1080P').trim().toUpperCase()
	return ['480P', '720P', '1080P'].includes(text) ? text : '1080P'
}

/** HappyHorse video editing accepts 720P / 1080P only. */
function normalizeHappyHorseEditResolution(value: unknown): string {
	const text = stringParam(value, '1080P').trim().toUpperCase()
	return text === '720P' ? '720P' : '1080P'
}

function normalizeHappyHorseRatio(value: unknown): string {
	const ratio = stringParam(value, '16:9').trim()
	return HAPPYHORSE_RATIOS.includes(ratio) ? ratio : '16:9'
}

function normalizeRatio(value: unknown): string | undefined {
	const ratio = stringParam(value, '').trim()
	return ['16:9', '9:16', '1:1', '4:3', '3:4'].includes(ratio) ? ratio : undefined
}

function normalizeWan30Ratio(value: unknown): string {
	const ratio = stringParam(value, 'adaptive').trim()
	return ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4'].includes(ratio) ? ratio : 'adaptive'
}

function normalizeWan30Duration(value: unknown): number {
	const parsed = optionalNumberParam(value)
	if (parsed !== undefined && Math.round(parsed) === -1) return -1
	return boundedInt(value, 5, 2, 30)
}

function applyHappyHorseSeed(parameters: UnknownRecord, params: Record<string, unknown>): void {
	const seed = optionalNumberParam(params.seed)
	if (seed === undefined) return
	parameters.seed = Math.min(Math.max(Math.round(seed), 0), 2147483647)
}

function isHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value)
}

function extensionForMime(mimeType: string, kind: 'image' | 'audio' | 'video' | 'pdf'): string {
	if (mimeType.includes('pdf')) return 'pdf'
	if (mimeType.includes('webp')) return 'webp'
	if (mimeType.includes('bmp')) return 'bmp'
	if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg'
	if (mimeType.includes('png')) return 'png'
	if (mimeType.includes('quicktime')) return 'mov'
	if (mimeType.includes('webm')) return 'webm'
	if (mimeType.includes('mp4')) return 'mp4'
	if (mimeType.includes('wav')) return 'wav'
	if (mimeType.includes('flac')) return 'flac'
	if (mimeType.includes('aac')) return 'aac'
	if (mimeType.includes('ogg')) return 'ogg'
	if (mimeType.includes('opus')) return 'opus'
	if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3'
	return kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : kind === 'pdf' ? 'pdf' : 'png'
}

function dataUriToBytes(dataUri: string, kind: 'image' | 'audio' | 'video' | 'pdf'): { bytes: Uint8Array; ext: string; mimeType: string } | null {
	const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
	if (!match) return null
	const mimeType = match[1]
	return {
		bytes: Uint8Array.from(atob(match[2]), c => c.charCodeAt(0)),
		ext: extensionForMime(mimeType, kind),
		mimeType,
	}
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return new Uint8Array(bytes).buffer
}

function videoExtFromUrl(url: string): string {
	const clean = url.split(/[?#]/)[0].toLowerCase()
	if (clean.endsWith('.mov')) return 'mov'
	if (clean.endsWith('.webm')) return 'webm'
	return 'mp4'
}

function extractVideoTaskId(data: unknown): string | null {
	return getStringAt(data, ['output', 'task_id']) || getStringAt(data, ['task_id'])
}

function extractVideoStatus(data: unknown): string {
	return (
		getStringAt(data, ['output', 'task_status'])
		|| getStringAt(data, ['task_status'])
		|| getStringAt(data, ['status'])
		|| ''
	).trim().toUpperCase()
}

function firstUrlInArray(value: unknown): string | null {
	if (!Array.isArray(value)) return null
	for (const item of value) {
		if (typeof item === 'string' && isHttpUrl(item)) return item
		if (isRecord(item)) {
			const url = stringParam(item.url || item.video_url || item.file_url, '')
			if (isHttpUrl(url)) return url
		}
	}
	return null
}

function extractVideoUrl(json: unknown): string | null {
	const paths = [
		['output', 'video_url'],
		['output', 'url'],
		['output', 'video', 'url'],
		['output', 'data', 'video_url'],
		['output', 'data', 'url'],
		['video_url'],
		['url'],
	]
	for (const path of paths) {
		const value = getStringAt(json, path)
		if (value && isHttpUrl(value)) return value
	}
	return (
		firstUrlInArray(getAt(json, ['output', 'results']))
		|| firstUrlInArray(getAt(json, ['output', 'videos']))
		|| firstUrlInArray(getAt(json, ['results']))
		|| firstUrlInArray(getAt(json, ['videos']))
	)
}

function videoFailureMessage(data: unknown): string {
	return (
		getStringAt(data, ['output', 'message'])
		|| getStringAt(data, ['output', 'code'])
		|| getStringAt(data, ['error', 'message'])
		|| getStringAt(data, ['message'])
		|| safePayloadSnippet(data)
		|| 'Task failed'
	)
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
	return []
}

function mergeVoices(voices: VoiceOption[]): VoiceOption[] {
	const byId = new Map<string, VoiceOption>()
	for (const voice of voices) {
		byId.set(voice.id, { ...byId.get(voice.id), ...voice })
	}
	return [...byId.values()]
}

type MediaKind = 'image' | 'audio' | 'video' | 'pdf'

interface WanVideoRoute {
	model: string
	input: UnknownRecord
	parameters: UnknownRecord
}

export class DashScopeVideoProvider implements VideoProvider {
	name = 'DashScope'

	constructor(
		private apiKey: string,
		private app: App,
		private outputDir: string,
		private baseUrl = DEFAULT_DASHSCOPE_BASE_URL,
	) {}

	async generateVideo(prompt: string, params?: Record<string, unknown>): Promise<GenerateVideoResult> {
		const options = params || {}
		const modelId = stringParam(options.modelId, 'wan-2.7')
		const route = modelId.startsWith('happyhorse')
			? await this.buildHappyHorseRoute(prompt, options)
			: modelId === WAN30_VIDEO
				? await this.buildWan30Route(prompt, options)
				: await this.buildWan27Route(prompt, options)
		const resp = await requestUrl({
			url: dashScopeUrl(this.baseUrl, VIDEO_SYNTHESIS_PATH),
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
				'X-DashScope-Async': 'enable',
			},
			body: JSON.stringify({
				model: route.model,
				input: route.input,
				parameters: route.parameters,
			}),
			throw: false,
		})

		if (isInvalidApiKeyResponse(resp)) throw new Error(`DashScope auth: ${parseErr(resp) || 'invalid API key.'}`)
		if (resp.status >= 400) throw new Error(`DashScope video: ${parseErr(resp) || `HTTP ${resp.status}`}`)

		const taskId = extractVideoTaskId(resp.json)
		if (!taskId) throw new Error(`DashScope video: task_id was not returned - ${safePayloadSnippet(resp.json)}`)
		return { done: false, taskId }
	}

	async checkStatus(taskId: string): Promise<GenerateVideoResult> {
		const resp = await pollRequest({
			url: dashScopeUrl(this.baseUrl, `${TASK_PATH}/${encodeURIComponent(taskId)}`),
			method: 'GET',
			headers: { 'Authorization': `Bearer ${this.apiKey}` },
			throw: false,
		})

		if (isInvalidApiKeyResponse(resp)) throw new Error(`DashScope auth: ${parseErr(resp) || 'invalid API key.'}`)
		if (resp.status >= 400) throw new Error(`DashScope video: ${parseErr(resp) || `HTTP ${resp.status}`}`)

		const payload: unknown = resp.json
		const status = extractVideoStatus(payload)
		const videoUrl = extractVideoUrl(payload)
		if (VIDEO_DONE_STATUSES.has(status) || videoUrl) {
			if (!videoUrl) throw new Error(`DashScope video: completed task has no video URL - ${safePayloadSnippet(payload)}`)
			return { done: true, filePath: await this.downloadVideo(videoUrl) }
		}
		if (VIDEO_FAILED_STATUSES.has(status)) {
			throw new TaskPollingError(`DashScope video: ${videoFailureMessage(payload)}`, 'terminal')
		}
		assertPendingStatus(status)
		return { done: false, taskId }
	}

	/**
	 * HappyHorse 1.1 is aggregated: the canvas mode picks one of four upstream
	 * ids. All four post to the same async video-synthesis endpoint and poll
	 * through the shared `checkStatus`.
	 */
	private async buildHappyHorseRoute(prompt: string, params: Record<string, unknown>): Promise<WanVideoRoute> {
		const genMode = stringParam(params.genMode, 'text-to-video')
		const refImages = stringList(params.refImages)
		const refVideos = stringList(params.refVideos)
		const supportedModes = new Set(['text-to-video', 'first-frame', 'image-ref', 'video-edit'])
		if (!supportedModes.has(genMode)) throw new Error(`HappyHorse 1.1 does not support ${genMode} mode.`)

		if (genMode === 'video-edit') {
			if (!refVideos[0]) throw new Error('HappyHorse video editing requires one upstream video.')
			if (refImages.length > 5) throw new Error('HappyHorse video editing supports at most 5 reference images.')
			const media: UnknownRecord[] = [{ type: 'video', url: await this.ensureUrl(refVideos[0], 'video') }]
			for (const ref of refImages) {
				media.push({ type: 'reference_image', url: await this.ensureUrl(ref, 'image') })
			}
			// Duration and ratio follow the source clip.
			const parameters: UnknownRecord = {
				resolution: normalizeHappyHorseEditResolution(params.resolution),
				watermark: false,
			}
			const audioSetting = stringParam(params.audio_setting, '')
			if (audioSetting === 'auto' || audioSetting === 'origin') parameters.audio_setting = audioSetting
			applyHappyHorseSeed(parameters, params)
			return { model: HAPPYHORSE_VIDEO_EDIT, input: { prompt, media }, parameters }
		}

		const parameters: UnknownRecord = {
			resolution: normalizeResolutionTier(params.resolution),
			duration: boundedInt(params.duration, 5, 3, 15),
			watermark: false,
		}
		applyHappyHorseSeed(parameters, params)

		if (genMode === 'first-frame') {
			if (!refImages[0]) throw new Error('HappyHorse image-to-video requires one upstream image.')
			// i2v derives the frame size from the input image, so it takes no ratio.
			return {
				model: HAPPYHORSE_I2V,
				input: { prompt, media: [{ type: 'first_frame', url: await this.ensureUrl(refImages[0], 'image') }] },
				parameters,
			}
		}

		parameters.ratio = normalizeHappyHorseRatio(params.ratio || params.aspectRatio || params.aspect_ratio)

		if (genMode === 'image-ref') {
			if (refImages.length === 0) throw new Error('HappyHorse reference-to-video requires at least one upstream image.')
			if (refImages.length > 9) throw new Error('HappyHorse reference-to-video supports at most 9 reference images.')
			const media = await Promise.all(refImages.map(async url => ({
				type: 'reference_image',
				url: await this.ensureUrl(url, 'image'),
			})))
			return { model: HAPPYHORSE_R2V, input: { prompt, media }, parameters }
		}

		return { model: HAPPYHORSE_T2V, input: { prompt }, parameters }
	}

	private async buildWan30Route(prompt: string, params: Record<string, unknown>): Promise<WanVideoRoute> {
		const genMode = stringParam(params.genMode, 'text-to-video')
		const refImages = stringList(params.refImages)
		const refAudios = stringList(params.refAudios)
		const refVideos = stringList(params.refVideos)
		const refPdfs = stringList(params.refPdfs)
		const supportedModes = new Set(['text-to-video', 'first-frame', 'first-last-frame', 'image-ref', 'video-ref'])
		if (!supportedModes.has(genMode)) throw new Error(`Wan 3.0 does not support ${genMode} mode.`)

		const media: UnknownRecord[] = []
		if (genMode === 'first-frame' || genMode === 'first-last-frame') {
			const expectedImages = genMode === 'first-last-frame' ? 2 : 1
			if (refImages.length !== expectedImages) {
				throw new Error(`Wan 3.0 ${genMode} mode requires exactly ${expectedImages} upstream image${expectedImages === 1 ? '' : 's'}.`)
			}
			if (refVideos.length > 0 || refAudios.length > 0 || refPdfs.length > 0) {
				throw new Error('Wan 3.0 first-frame modes cannot be combined with reference video, audio, or files.')
			}
			media.push({ type: 'first_frame', url: await this.ensureUrl(refImages[0], 'image') })
			if (genMode === 'first-last-frame') {
				media.push({ type: 'last_frame', url: await this.ensureUrl(refImages[1], 'image') })
			}
		} else {
			if (refImages.length > 10) throw new Error('Wan 3.0 supports at most 10 reference images.')
			if (refVideos.length > 5) throw new Error('Wan 3.0 supports at most 5 reference videos.')
			if (refAudios.length > 5) throw new Error('Wan 3.0 supports at most 5 reference audio clips.')
			if (refPdfs.length > 1) throw new Error('Wan 3.0 supports at most 1 reference file.')
			const imageMedia = await Promise.all(refImages.map(async url => ({ type: 'reference_image', url: await this.ensureUrl(url, 'image') })))
			const videoMedia = await Promise.all(refVideos.map(async url => ({ type: 'reference_video', url: await this.ensureUrl(url, 'video') })))
			const audioMedia = await Promise.all(refAudios.map(async url => ({ type: 'reference_audio', url: await this.ensureUrl(url, 'audio') })))
			const fileMedia = await Promise.all(refPdfs.map(async url => ({ type: 'file', url: await this.ensureUrl(url, 'pdf') })))
			media.push(...imageMedia, ...videoMedia, ...audioMedia, ...fileMedia)
			if ((genMode === 'image-ref' || genMode === 'video-ref') && media.length === 0) {
				throw new Error(`Wan 3.0 ${genMode} mode requires at least one upstream reference.`)
			}
		}

		const input: UnknownRecord = { prompt }
		if (media.length > 0) input.media = media
		const parameters: UnknownRecord = {
			resolution: normalizeResolutionTier(params.resolution),
			ratio: normalizeWan30Ratio(params.ratio || params.aspectRatio || params.aspect_ratio),
			duration: normalizeWan30Duration(params.duration),
			audio: optionalBooleanParam(params.audio) ?? true,
			watermark: optionalBooleanParam(params.watermark) ?? false,
		}
		const seed = optionalNumberParam(params.seed)
		if (seed !== undefined) parameters.seed = Math.min(Math.max(Math.round(seed), 0), 2147483647)

		return { model: WAN30_VIDEO, input, parameters }
	}

	private async buildWan27Route(prompt: string, params: Record<string, unknown>): Promise<WanVideoRoute> {
		const genMode = stringParam(params.genMode, 'text-to-video')
		const modelId = stringParam(params.modelId, 'wan-2.7')
		const refImages = stringList(params.refImages)
		const refAudios = stringList(params.refAudios)
		const refVideos = stringList(params.refVideos)

		if (modelId === WAN27_VIDEOEDIT || genMode === 'video-edit') {
			return this.buildWan27VideoEdit(prompt, params, refImages, refVideos)
		}
		if (modelId === WAN27_R2V || genMode === 'image-ref' || genMode === 'multi-image-ref' || genMode === 'video-ref') {
			return this.buildWan27R2v(prompt, params, refImages, refVideos, refAudios)
		}
		if (modelId === WAN27_I2V || genMode === 'first-frame' || genMode === 'first-last-frame' || genMode === 'video-extend') {
			return this.buildWan27I2v(prompt, params, genMode, refImages, refVideos, refAudios)
		}
		return this.buildWan27T2v(prompt, params, refAudios)
	}

	private async buildWan27T2v(prompt: string, params: Record<string, unknown>, refAudios: string[]): Promise<WanVideoRoute> {
		const input: UnknownRecord = { prompt }
		if (refAudios[0]) input.audio_url = await this.ensureUrl(refAudios[0], 'audio')
		return {
			model: WAN27_T2V,
			input,
			parameters: this.commonParameters(params, 15),
		}
	}

	private async buildWan27I2v(
		prompt: string,
		params: Record<string, unknown>,
		genMode: string,
		refImages: string[],
		refVideos: string[],
		refAudios: string[],
	): Promise<WanVideoRoute> {
		const media: UnknownRecord[] = []
		if (genMode === 'video-extend') {
			if (!refVideos[0]) throw new Error('Wan 2.7 video extend requires one upstream video.')
			media.push({ type: 'first_clip', url: await this.ensureUrl(refVideos[0], 'video') })
			if (refImages[0]) media.push({ type: 'last_frame', url: await this.ensureUrl(refImages[0], 'image') })
		} else {
			if (!refImages[0]) throw new Error('Wan 2.7 image-to-video requires one upstream image.')
			media.push({ type: 'first_frame', url: await this.ensureUrl(refImages[0], 'image') })
			if (genMode === 'first-last-frame') {
				if (!refImages[1]) throw new Error('Wan 2.7 first-last-frame mode requires two upstream images.')
				media.push({ type: 'last_frame', url: await this.ensureUrl(refImages[1], 'image') })
			}
		}
		if (refAudios[0]) media.push({ type: 'driving_audio', url: await this.ensureUrl(refAudios[0], 'audio') })
		return {
			model: WAN27_I2V,
			input: { prompt, media },
			parameters: this.commonParameters(params, 15),
		}
	}

	private async buildWan27R2v(
		prompt: string,
		params: Record<string, unknown>,
		refImages: string[],
		refVideos: string[],
		refAudios: string[],
	): Promise<WanVideoRoute> {
		const media: UnknownRecord[] = []
		const imageMedia = await Promise.all(refImages.map(async url => ({ type: 'reference_image', url: await this.ensureUrl(url, 'image') })))
		const videoMedia = await Promise.all(refVideos.map(async url => ({ type: 'reference_video', url: await this.ensureUrl(url, 'video') })))
		const refs: UnknownRecord[] = [...imageMedia, ...videoMedia]
		if (refs.length === 0) throw new Error('Wan 2.7 reference mode requires at least one upstream image or video.')
		if (media.length + refs.length > 5) throw new Error('Wan 2.7 reference mode supports at most 5 media inputs.')
		for (let i = 0; i < refs.length; i++) {
			if (refAudios[i]) refs[i].reference_voice = await this.ensureUrl(refAudios[i], 'audio')
		}
		media.push(...refs)
		return {
			model: WAN27_R2V,
			input: { prompt, media },
			parameters: this.commonParameters(params, 10),
		}
	}

	private async buildWan27VideoEdit(
		prompt: string,
		params: Record<string, unknown>,
		refImages: string[],
		refVideos: string[],
	): Promise<WanVideoRoute> {
		if (!refVideos[0]) throw new Error('Wan 2.7 VideoEdit requires one upstream video.')
		if (refImages.length > 3) throw new Error('Wan 2.7 VideoEdit supports at most 3 reference images.')
		const media: UnknownRecord[] = [
			{ type: 'video', url: await this.ensureUrl(refVideos[0], 'video') },
		]
		for (const ref of refImages) {
			media.push({ type: 'reference_image', url: await this.ensureUrl(ref, 'image') })
		}
		const parameters = this.commonParameters(params, 10)
		const audioSetting = stringParam(params.audio_setting, '')
		if (audioSetting === 'auto' || audioSetting === 'origin') parameters.audio_setting = audioSetting
		return {
			model: WAN27_VIDEOEDIT,
			input: { prompt, media },
			parameters,
		}
	}

	private commonParameters(params: Record<string, unknown>, maxDuration: number): UnknownRecord {
		const parameters: UnknownRecord = {
			resolution: normalizeResolution(params.resolution),
			duration: boundedInt(params.duration, 5, 2, maxDuration),
			prompt_extend: optionalBooleanParam(params.prompt_extend) ?? true,
			watermark: false,
		}
		const ratio = normalizeRatio(params.ratio || params.aspectRatio || params.aspect_ratio)
		if (ratio) parameters.ratio = ratio
		const negativePrompt = optionalStringParam(params.negative_prompt)
		if (negativePrompt) parameters.negative_prompt = negativePrompt
		return parameters
	}

	private async ensureUrl(ref: string, kind: MediaKind): Promise<string> {
		if (isHttpUrl(ref)) return ref
		if (ref.startsWith('asset://')) {
			throw new Error('DashScope video does not support provider asset:// references; use URL-uploaded media.')
		}
		const decoded = dataUriToBytes(ref, kind)
		if (!decoded) throw new Error(`DashScope video: unsupported reference ${kind} format`)
		return uploadRef(undefined, copyToArrayBuffer(decoded.bytes), `dashscope-ref.${decoded.ext}`, decoded.mimeType)
	}

	private async downloadVideo(url: string): Promise<string> {
		const resp = await pollRequest({ url })
		const outputDir = outputDirectoryPath(this.outputDir)
		// `checkStatus` only receives a task id, so the file name stays model-neutral
		// rather than mislabelling Wan 3.0 / HappyHorse output as Wan 2.7.
		const filePath = outputFilePath(this.outputDir, `dashscope_video_${Date.now()}.${videoExtFromUrl(url)}`)
		const adapter = this.app.vault.adapter
		if (!await adapter.exists(outputDir)) await adapter.mkdir(outputDir)
		await writeTaskResult(adapter, filePath, resp.arrayBuffer)
		return filePath
	}
}

export class DashScopeAudioProvider implements AudioProvider {
	name = 'DashScope'

	constructor(
		private apiKey: string,
		private app: App,
		private outputDir: string,
		private baseUrl = DEFAULT_DASHSCOPE_BASE_URL,
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
			url: dashScopeUrl(this.baseUrl, qwen ? QWEN_TTS_PATH : COSY_TTS_PATH),
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
		if (!options.audioUrl) throw new Error('DashScope voice clone needs an uploaded audio URL.')
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
			url: dashScopeUrl(this.baseUrl, CUSTOMIZATION_PATH),
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

	async designVoice(options: VoiceDesignOptions): Promise<VoiceDesignResult> {
		const modelId = options.modelId
		const qwen = isQwenModel(modelId)
		const input: UnknownRecord = qwen
			? {
				action: 'create',
				target_model: modelId,
				preferred_name: sanitizeQwenName(options.voiceNamePrefix || options.promptHash),
				voice_prompt: options.voicePrompt,
				preview_text: options.previewText,
			}
			: {
				action: 'create_voice',
				target_model: modelId,
				prefix: sanitizeCosyPrefix(options.voiceNamePrefix || options.promptHash),
				voice_prompt: options.voicePrompt,
				preview_text: options.previewText,
			}

		const resp = await requestUrl({
			url: dashScopeUrl(this.baseUrl, CUSTOMIZATION_PATH),
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: qwen ? 'qwen-voice-design' : 'voice-enrollment',
				input,
				parameters: {
					sample_rate: 24000,
					response_format: 'wav',
				},
			}),
			throw: false,
		})

		if (isInvalidApiKeyResponse(resp)) throw new Error(`DashScope auth: ${parseErr(resp) || 'invalid API key.'}`)
		if (resp.status >= 400) throw new Error(`DashScope voice design: ${parseErr(resp)}`)

		const payload: unknown = resp.json
		const voiceId = extractVoiceId(payload, qwen)
		if (!voiceId) throw new Error(`DashScope voice design: no voice id in response - ${safePayloadSnippet(payload)}`)
		return {
			voiceId,
			name: voiceId,
			previewUrl: extractPreviewAudio(payload) || undefined,
		}
	}

	private async listCustomVoices(modelId: string): Promise<VoiceOption[]> {
		if (!modelId) return []
		const qwen = isQwenModel(modelId)
		const input: UnknownRecord = qwen
			? { action: 'list', page_size: 100, page_index: 0 }
			: { action: 'list_voice', page_size: 100, page_index: 0 }

		const resp = await requestUrl({
			url: dashScopeUrl(this.baseUrl, CUSTOMIZATION_PATH),
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

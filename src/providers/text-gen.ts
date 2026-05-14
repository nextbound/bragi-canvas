/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import { requestUrl } from 'obsidian'
import { signRequest } from './sigv4'
import { stringParam } from './params'
import { uploadRef } from './upload'
import { throwForGoogleError } from './google-errors'

export interface TextGenResult {
	text: string
}

const SYSTEM_PROMPT = `You are a helpful assistant on a visual canvas. Follow the user's instructions precisely.
If the user asks you to produce multiple separate items (e.g. "split into 3 chapters", "give me 5 titles", "break this into sections"), output each item separated by a line containing only ---SPLIT--- on its own. Do NOT use ---SPLIT--- for any other purpose. If the output is a single piece of content, do not use ---SPLIT--- at all.`

export interface TextGenProvider {
	name: string
	generateText(prompt: string, params?: Record<string, unknown>): Promise<TextGenResult>
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : []
}

function unwrapDataEnvelope(data: unknown): unknown {
	const record = asRecord(data)
	const inner = asRecord(record?.data)
	return inner || data
}

function parseProviderError(provider: string, resp: { status: number; text?: string; json?: unknown }): string {
	const body = asRecord(resp.json) || (() => {
		try { return asRecord(JSON.parse(resp.text || '')) } catch { return null }
	})()
	const error = asRecord(body?.error)
	const msg = stringParam(error?.message || body?.message || resp.text, `HTTP ${resp.status}`)
	const code = stringParam(error?.code || error?.type || body?.code, '')
	return `${provider}: ${code ? code + ' — ' : ''}${msg}`
}

function isOpenAIResponsesModel(modelId: string): boolean {
	return /^gpt-5\.[45]-pro(?:-|$)/.test(modelId)
}

function videoMimeTypeFromRef(ref: string): string {
	const path = ref.split(/[?#]/)[0].toLowerCase()
	if (path.endsWith('.mov')) return 'video/quicktime'
	if (path.endsWith('.webm')) return 'video/webm'
	return 'video/mp4'
}

function audioMimeTypeFromRef(ref: string): string {
	const path = ref.split(/[?#]/)[0].toLowerCase()
	if (path.endsWith('.wav')) return 'audio/wav'
	if (path.endsWith('.m4a') || path.endsWith('.mp4')) return 'audio/mp4'
	if (path.endsWith('.aac')) return 'audio/aac'
	if (path.endsWith('.flac')) return 'audio/flac'
	if (path.endsWith('.ogg')) return 'audio/ogg'
	if (path.endsWith('.opus')) return 'audio/opus'
	return 'audio/mpeg'
}

function extensionForMime(mimeType: string): string {
	if (mimeType === 'application/pdf') return 'pdf'
	if (mimeType.includes('quicktime')) return 'mov'
	if (mimeType.includes('webm')) return 'webm'
	if (mimeType.includes('wav')) return 'wav'
	if (mimeType.includes('mp4')) return 'mp4'
	if (mimeType.includes('aac')) return 'aac'
	if (mimeType.includes('flac')) return 'flac'
	if (mimeType.includes('ogg')) return 'ogg'
	if (mimeType.includes('opus')) return 'opus'
	if (mimeType.includes('mpeg')) return 'mp3'
	return 'bin'
}

function parseDataUri(dataUri: string): { mimeType: string; data: string } | null {
	const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
	if (!match) return null
	return { mimeType: match[1], data: match[2] }
}

function dataUriToBytes(dataUri: string): { mimeType: string; bytes: Uint8Array } | null {
	const parsed = parseDataUri(dataUri)
	if (!parsed) return null
	return {
		mimeType: parsed.mimeType,
		bytes: Uint8Array.from(atob(parsed.data), c => c.charCodeAt(0)),
	}
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const out = new Uint8Array(bytes.byteLength)
	out.set(bytes)
	return out.buffer
}

function extractOpenAIChatText(data: unknown): string {
	const choices = asArray(asRecord(unwrapDataEnvelope(data))?.choices)
	const message = asRecord(asRecord(choices[0])?.message)
	const content = message?.content
	if (typeof content === 'string') return content.trim()
	if (Array.isArray(content)) {
		return content
			.map(part => asRecord(part))
			.filter(Boolean)
			.filter(part => part?.type === 'text')
			.map(part => stringParam(part?.text, ''))
			.join('\n')
			.trim()
	}
	return ''
}

function extractOpenAIResponsesText(data: unknown): string {
	const responseData = unwrapDataEnvelope(data)
	const direct = stringParam(asRecord(responseData)?.output_text, '').trim()
	if (direct) return direct

	const chunks: string[] = []
	const visit = (value: unknown, depth = 0): void => {
		if (depth > 8 || value == null) return
		if (typeof value === 'string') return
		if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1)
			return
		}

		const record = asRecord(value)
		if (!record) return
		const type = stringParam(record.type, '')
		const text = stringParam(record.text, '')
		if ((type === 'output_text' || type === 'text') && text) chunks.push(text)
		for (const key of ['output', 'content', 'message', 'data']) visit(record[key], depth + 1)
	}

	visit(responseData)
	return chunks.join('\n').trim()
}

/**
 * OpenAI-compatible text generation with vision support.
 */
export class OpenAITextProvider implements TextGenProvider {
	name = 'OpenAI'
	private apiKey: string
	private baseUrl: string

	constructor(apiKey: string, baseUrl: string = 'https://api.openai.com/v1') {
		this.apiKey = apiKey
		this.baseUrl = baseUrl.replace(/\/$/, '')
	}

	async generateText(prompt: string, params?: Record<string, unknown>): Promise<TextGenResult> {
		const modelId = stringParam(params?.modelId, 'gpt-5.5')
		const refImages: string[] = Array.isArray(params?.refImages) ? params.refImages : []

		if (isOpenAIResponsesModel(modelId)) return this.generateViaResponses(modelId, prompt, refImages)

		// Build messages with optional images
		const content: unknown[] = []

		for (const dataUri of refImages) {
			content.push({
				type: 'image_url',
				image_url: { url: dataUri },
			})
		}

		content.push({ type: 'text', text: prompt })

		const response = await requestUrl({
			url: `${this.baseUrl}/chat/completions`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			throw: false,
			body: JSON.stringify({
				model: modelId,
				messages: [
					{ role: 'system', content: SYSTEM_PROMPT },
					{ role: 'user', content },
				],
				max_completion_tokens: 4096,
			}),
		})

		if (response.status >= 400) throw new Error(parseProviderError('OpenAI text', response))
		const text = extractOpenAIChatText(response.json)
		if (!text) throw new Error('GPT: No text in response')

		return { text }
	}

	private async generateViaResponses(modelId: string, prompt: string, refImages: string[]): Promise<TextGenResult> {
		const content: unknown[] = []
		for (const dataUri of refImages) {
			content.push({ type: 'input_image', image_url: dataUri })
		}
		content.push({ type: 'input_text', text: prompt })

		const response = await requestUrl({
			url: `${this.baseUrl}/responses`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			throw: false,
			body: JSON.stringify({
				model: modelId,
				instructions: SYSTEM_PROMPT,
				input: [{ role: 'user', content }],
				max_output_tokens: 4096,
			}),
		})

		if (response.status >= 400) throw new Error(parseProviderError('OpenAI responses', response))
		const text = extractOpenAIResponsesText(response.json)
		if (!text) throw new Error('GPT: No text in response')
		return { text }
	}
}

/**
 * APIMart general chat API for GPT text models.
 */
export class APIMartTextProvider implements TextGenProvider {
	name = 'APIMart'
	private apiKey: string
	private baseUrl: string

	constructor(apiKey: string, baseUrl: string = 'https://api.apimart.ai/v1') {
		this.apiKey = apiKey
		this.baseUrl = baseUrl.replace(/\/$/, '')
	}

	async generateText(prompt: string, params?: Record<string, unknown>): Promise<TextGenResult> {
		const modelId = stringParam(params?.modelId, 'gpt-5.5')
		const refImages: string[] = Array.isArray(params?.refImages) ? params.refImages : []

		if (refImages.length > 0) return this.generateViaResponses(modelId, prompt, refImages)

		return this.generateViaChat(modelId, prompt)
	}

	private responseFailed(response: { status: number; json?: unknown }): boolean {
		if (response.status >= 400) return true
		const code = asRecord(response.json)?.code
		return typeof code === 'number' && code !== 0 && code !== 200
	}

	private async generateViaChat(modelId: string, prompt: string): Promise<TextGenResult> {
		const content: unknown[] = []
		content.push({ type: 'text', text: prompt })

		const response = await requestUrl({
			url: `${this.baseUrl}/chat/completions`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			throw: false,
			body: JSON.stringify({
				model: modelId,
				messages: [
					{ role: 'system', content: SYSTEM_PROMPT },
					{ role: 'user', content },
				],
				max_tokens: 4096,
				stream: false,
			}),
		})

		if (this.responseFailed(response)) throw new Error(parseProviderError('APIMart text', response))

		const text = extractOpenAIChatText(response.json)
		if (!text) throw new Error('APIMart GPT: No text in response')
		return { text }
	}

	private async generateViaResponses(modelId: string, prompt: string, refImages: string[]): Promise<TextGenResult> {
		const content: unknown[] = []
		content.push({ type: 'input_text', text: prompt })
		for (const dataUri of refImages) {
			content.push({ type: 'input_image', image_url: await this.ensureImageUrl(dataUri) })
		}

		const response = await requestUrl({
			url: `${this.baseUrl}/responses`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			throw: false,
			body: JSON.stringify({
				model: modelId,
				instructions: SYSTEM_PROMPT,
				input: [{ role: 'user', content }],
				max_tokens: 4096,
			}),
		})

		if (this.responseFailed(response)) throw new Error(parseProviderError('APIMart responses', response))

		const text = extractOpenAIResponsesText(response.json)
		if (!text) throw new Error('APIMart GPT: No text in response')
		return { text }
	}

	private async ensureImageUrl(ref: string): Promise<string> {
		if (/^https?:\/\//i.test(ref)) return ref

		const match = ref.match(/^data:([^;]+);base64,(.+)$/)
		if (!match) return ref

		const mime = match[1]
		const b64 = match[2]
		const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
		const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'png'
		return uploadRef(undefined, bytes.buffer, `ref.${ext}`, mime)
	}
}

/**
 * Gemini text generation with vision support.
 */
export class GeminiTextProvider implements TextGenProvider {
	name = 'Gemini'
	private apiKey: string

	constructor(apiKey: string) {
		this.apiKey = apiKey
	}

	async generateText(prompt: string, params?: Record<string, unknown>): Promise<TextGenResult> {
		const modelId = stringParam(params?.modelId, 'gemini-2.5-flash')
		const refImages = Array.isArray(params?.refImages) ? params.refImages.filter((ref): ref is string => typeof ref === 'string') : []
		const refVideos = Array.isArray(params?.refVideos) ? params.refVideos.filter((ref): ref is string => typeof ref === 'string') : []
		const refAudios = Array.isArray(params?.refAudios) ? params.refAudios.filter((ref): ref is string => typeof ref === 'string') : []
		const refPdfs = Array.isArray(params?.refPdfs) ? params.refPdfs.filter((ref): ref is string => typeof ref === 'string') : []

		// Build parts: media first, then text
		const parts: unknown[] = []

		for (const dataUri of refImages) {
			const parsed = parseDataUri(dataUri)
			if (parsed) {
				parts.push({
					inlineData: { mimeType: parsed.mimeType, data: parsed.data },
				})
			}
		}
		for (const ref of refVideos) {
			const file = await this.fileDataPart(ref, videoMimeTypeFromRef(ref), 'video')
			parts.push({ fileData: file })
		}
		for (const ref of refAudios) {
			const file = await this.fileDataPart(ref, audioMimeTypeFromRef(ref), 'audio')
			parts.push({ fileData: file })
		}
		for (const ref of refPdfs) {
			const file = await this.fileDataPart(ref, 'application/pdf', 'document')
			parts.push({ fileData: file })
		}

		parts.push({ text: prompt })

		const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelId}:generateContent`

		const response = await requestUrl({
			url,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-goog-api-key': this.apiKey,
			},
			throw: false,
			body: JSON.stringify({
				systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
				contents: [{ parts }],
			}),
		})

		throwForGoogleError('Gemini text', response)
		const data = response.json
		const text = asArray(asRecord(asRecord(asArray(asRecord(data)?.candidates)[0])?.content)?.parts)
			.map(part => asRecord(part))
			.filter(Boolean)
			.filter(part => part?.text)
			.map(part => stringParam(part?.text, ''))
			?.join('\n')
			?.trim()

		if (!text) throw new Error('Gemini: No text in response')

		return { text }
	}

	private async fileDataPart(ref: string, fallbackMimeType: string, label: string): Promise<{ mimeType: string; fileUri: string }> {
		const decoded = dataUriToBytes(ref)
		if (!decoded) return { mimeType: fallbackMimeType, fileUri: ref }
		const fileUri = await uploadRef(undefined, copyToArrayBuffer(decoded.bytes), `${label}.${extensionForMime(decoded.mimeType)}`, decoded.mimeType)
		return { mimeType: decoded.mimeType, fileUri }
	}
}

/**
 * Build Anthropic Messages API content blocks from prompt + optional images.
 */
function buildAnthropicContent(prompt: string, refImages: string[]): unknown[] {
	const content: unknown[] = []
	for (const dataUri of refImages) {
		const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
		if (match) {
			content.push({
				type: 'image',
				source: { type: 'base64', media_type: match[1], data: match[2] },
			})
		}
	}
	content.push({ type: 'text', text: prompt })
	return content
}

function parseAnthropicText(data: unknown): string {
	const blocks = data?.content
	if (!Array.isArray(blocks)) return ''
	return blocks.filter((b: unknown) => b.type === 'text').map((b: unknown) => b.text).join('\n').trim()
}

/**
 * Anthropic Claude text generation (direct API).
 */
export class AnthropicTextProvider implements TextGenProvider {
	name = 'Claude'
	private apiKey: string

	constructor(apiKey: string) {
		this.apiKey = apiKey
	}

	async generateText(prompt: string, params?: Record<string, unknown>): Promise<TextGenResult> {
		const modelId = params?.modelId || 'claude-sonnet-4-6'
		const refImages: string[] = params?.refImages || []

		const response = await requestUrl({
			url: 'https://api.anthropic.com/v1/messages',
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': this.apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify({
				model: modelId,
				max_tokens: 4096,
				system: SYSTEM_PROMPT,
				messages: [{ role: 'user', content: buildAnthropicContent(prompt, refImages) }],
			}),
		})

		const text = parseAnthropicText(response.json)
		if (!text) throw new Error('Claude: No text in response')

		return { text }
	}
}

/**
 * Anthropic Claude text generation via AWS Bedrock (SigV4-signed).
 */
export class BedrockClaudeTextProvider implements TextGenProvider {
	name = 'Bedrock Claude'
	private accessKeyId: string
	private secretAccessKey: string
	private region: string

	constructor(accessKeyId: string, secretAccessKey: string, region: string) {
		this.accessKeyId = accessKeyId
		this.secretAccessKey = secretAccessKey
		this.region = region || 'us-east-1'
	}

	async generateText(prompt: string, params?: Record<string, unknown>): Promise<TextGenResult> {
		const bedrockModelId = params?.modelId
		if (!bedrockModelId) throw new Error('Bedrock: missing modelId')
		const refImages: string[] = params?.refImages || []

		const url = `https://bedrock-runtime.${this.region}.amazonaws.com/model/${encodeURIComponent(bedrockModelId)}/invoke`
		const body = JSON.stringify({
			anthropic_version: 'bedrock-2023-05-31',
			max_tokens: 4096,
			system: SYSTEM_PROMPT,
			messages: [{ role: 'user', content: buildAnthropicContent(prompt, refImages) }],
		})

		const headers = await signRequest({
			method: 'POST',
			url,
			region: this.region,
			service: 'bedrock',
			accessKeyId: this.accessKeyId,
			secretAccessKey: this.secretAccessKey,
			body,
			extraHeaders: {
				'content-type': 'application/json',
				accept: 'application/json',
			},
			})

		// Electron's requestUrl forbids manually setting the `host` header (ERR_INVALID_ARGUMENT).
		// It must still be in the SigV4 signature, but stripped from outgoing headers.
		const sendHeaders = { ...headers }
		delete sendHeaders.host
		const response = await requestUrl({ url, method: 'POST', headers: sendHeaders, body })
		const text = parseAnthropicText(response.json)
		if (!text) throw new Error('Bedrock Claude: No text in response')

		return { text }
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Resume strict linting after the runtime-shaped data boundary. */

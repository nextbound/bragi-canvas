/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import { requestUrl } from 'obsidian'
import { signRequest } from './sigv4'
import { stringParam } from './params'

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

function extractOpenAIChatText(data: unknown): string {
	const choices = asArray(asRecord(data)?.choices)
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
	const direct = stringParam(asRecord(data)?.output_text, '').trim()
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

	visit(data)
	return chunks.join('\n').trim()
}

/**
 * OpenAI text generation (GPT-4o) with vision support.
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
		const refImages: string[] = params?.refImages || []

		// Build parts: images first, then text
		const parts: unknown[] = []

		for (const dataUri of refImages) {
			const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
			if (match) {
				parts.push({
					inlineData: { mimeType: match[1], data: match[2] },
				})
			}
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
			body: JSON.stringify({
				systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
				contents: [{ parts }],
			}),
		})

		const data = response.json
		const text = data.candidates?.[0]?.content?.parts
			?.filter((p: unknown) => p.text)
			?.map((p: unknown) => p.text)
			?.join('\n')
			?.trim()

		if (!text) throw new Error('Gemini: No text in response')

		return { text }
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

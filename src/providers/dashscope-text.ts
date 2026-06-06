/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- DashScope API responses arrive as runtime-shaped JSON narrowed at use sites. */
import { requestUrl } from 'obsidian'
import { stringParam } from './params'
import { uploadRef } from './upload'
import type { TextGenProvider, TextGenResult } from './text-gen'
import { DEFAULT_DASHSCOPE_BASE_URL, dashScopeUrl } from './dashscope'

const MULTIMODAL_PATH = '/services/aigc/multimodal-generation/generation'

const SYSTEM_PROMPT = `You are a helpful assistant on a visual canvas. Follow the user's instructions precisely.
If the user asks you to produce multiple separate items (e.g. "split into 3 chapters", "give me 5 titles", "break this into sections"), output each item separated by a line containing only ---SPLIT--- on its own. Do NOT use ---SPLIT--- for any other purpose. If the output is a single piece of content, do not use ---SPLIT--- at all.`

function parseErr(resp: { status: number; text?: string; json?: unknown }): string {
	const body = resp.json || (() => { try { return JSON.parse(resp.text || '') } catch { return null } })()
	const msg = body?.message || body?.error?.message || resp.text || `HTTP ${resp.status}`
	return typeof msg === 'string' ? msg : JSON.stringify(msg).substring(0, 240)
}

function parseDataUri(dataUri: string): { mimeType: string; data: string } | null {
	const match = dataUri.match(/^data:([^;]+);base64,(.+)$/)
	if (!match) return null
	return { mimeType: match[1], data: match[2] }
}

async function ensurePublicUrl(ref: string, fallbackMime: string, label: string): Promise<string> {
	if (/^https?:\/\//i.test(ref)) return ref
	const parsed = parseDataUri(ref)
	if (!parsed) return ref
	const bytes = Uint8Array.from(atob(parsed.data), c => c.charCodeAt(0))
	const ext = label.includes('.') ? label.split('.').pop() || 'bin' : label
	return uploadRef(undefined, bytes.buffer, `ref.${ext}`, parsed.mimeType || fallbackMime)
}

async function buildContentParts(
	prompt: string,
	refImages: string[],
	refVideos: string[],
	refAudios: string[],
	refPdfs: string[],
): Promise<Array<Record<string, unknown>>> {
	const parts: Array<Record<string, unknown>> = []

	for (const ref of refImages) {
		if (/^https?:\/\//i.test(ref) || parseDataUri(ref)) {
			parts.push({ image: ref })
		}
	}

	for (const ref of refVideos) {
		const url = await ensurePublicUrl(ref, 'video/mp4', 'mp4')
		parts.push({ video: url, fps: 2 })
	}

	for (const ref of refAudios) {
		const url = await ensurePublicUrl(ref, 'audio/mpeg', 'mp3')
		parts.push({ audio: url })
	}

	for (const ref of refPdfs) {
		const url = await ensurePublicUrl(ref, 'application/pdf', 'pdf')
		parts.push({ file: url })
	}

	parts.push({ text: prompt })
	return parts
}

export class DashScopeTextProvider implements TextGenProvider {
	name = 'DashScope'
	private apiKey: string
	private baseUrl: string

	constructor(apiKey: string, baseUrl = DEFAULT_DASHSCOPE_BASE_URL) {
		this.apiKey = apiKey
		this.baseUrl = baseUrl
	}

	async generateText(prompt: string, params?: Record<string, unknown>): Promise<TextGenResult> {
		const modelId = stringParam(params?.modelId, 'qwen3.6-plus')
		const refImages: string[] = Array.isArray(params?.refImages) ? params.refImages.filter((r): r is string => typeof r === 'string') : []
		const refVideos: string[] = Array.isArray(params?.refVideos) ? params.refVideos.filter((r): r is string => typeof r === 'string') : []
		const refAudios: string[] = Array.isArray(params?.refAudios) ? params.refAudios.filter((r): r is string => typeof r === 'string') : []
		const refPdfs: string[] = Array.isArray(params?.refPdfs) ? params.refPdfs.filter((r): r is string => typeof r === 'string') : []

		const content = await buildContentParts(prompt, refImages, refVideos, refAudios, refPdfs)

		const response = await requestUrl({
			url: dashScopeUrl(this.baseUrl, MULTIMODAL_PATH),
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this.apiKey}`,
			},
			throw: false,
			body: JSON.stringify({
				model: modelId,
				input: {
					messages: [
						{ role: 'system', content: [{ text: SYSTEM_PROMPT }] },
						{ role: 'user', content },
					],
				},
			}),
		})

		if (response.status >= 400) throw new Error(`DashScope text: ${parseErr(response)}`)

		const choices = response.json?.output?.choices
		const messageContent = choices?.[0]?.message?.content
		let text = ''
		if (Array.isArray(messageContent)) {
			text = messageContent
				.map((part: unknown) => (part && typeof part === 'object' && 'text' in part ? String((part as { text?: string }).text || '') : ''))
				.join('\n')
				.trim()
		} else if (typeof messageContent === 'string') {
			text = messageContent.trim()
		}

		if (!text) throw new Error('DashScope: No text in response')
		return { text }
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Resume strict linting after the runtime-shaped data boundary. */

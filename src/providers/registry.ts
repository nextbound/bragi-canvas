/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import type { App } from 'obsidian'
import type { BragiSettings } from '../settings'
import type { ImageProvider, VideoProvider, AudioProvider } from './types'
import type { TextGenProvider } from './text-gen'

import { OpenAIProvider } from './openai'
import { GeminiProvider } from './gemini'
import { SeedreamProvider } from './seedream'
import { SeedanceProvider } from './seedance'
import { KlingProvider } from './kling'
import { VeoProvider } from './veo'
import { FalImageProvider, FalVideoProvider } from './fal'
import { FalAudioProvider } from './fal-audio'
import { ElevenLabsProvider } from './elevenlabs'
import { MiniMaxProvider } from './minimax'
import { LegnextProvider } from './legnext'
import { APIMartProvider } from './apimart'
import { LumaProvider } from './luma'
import { MuleRouterVideoProvider, testMuleRouterConnection } from './mulerouter'
import { XAIImageProvider, XAIVideoProvider, XAIAudioProvider } from './xai'
import { TokenRouterImageProvider, TokenRouterTextProvider, TokenRouterVideoProvider } from './tokenrouter'
import { Token360VideoProvider } from './token360'
import { DashScopeAudioProvider } from './dashscope'

const LUMA_ENDPOINT = 'https://luma.bragi.now'
import { OpenAITextProvider, APIMartTextProvider, GeminiTextProvider, AnthropicTextProvider, BedrockClaudeTextProvider, XAITextProvider } from './text-gen'
import { DashScopeTextProvider } from './dashscope-text'
import { requestUrl } from 'obsidian'

export type ProviderKey = keyof BragiSettings['providers']

export interface ProviderField {
	key: ProviderKey
	label: string
	placeholder: string
	type?: 'password' | 'text' | 'select'
	options?: Array<{ label: string; value: string }>
}

export interface ProviderCtx {
	settings: BragiSettings
	app: App
	outputDir: string
}

export interface TestResult {
	ok: boolean
	/** One-line human message shown in Notice. */
	message: string
}

export interface ProviderSpec {
	id: string
	name: string
	description?: string
	docUrl?: string
	fields: ProviderField[]
	isConfigured: (s: BragiSettings) => boolean
	makeImage?: (ctx: ProviderCtx) => ImageProvider
	makeVideo?: (ctx: ProviderCtx) => VideoProvider
	makeText?: (ctx: ProviderCtx) => TextGenProvider
	makeAudio?: (ctx: ProviderCtx) => AudioProvider
	/**
	 * Try a cheap, no-quota-consuming call to verify key + network.
	 * Takes the provider's draft field values so Test works before Save.
	 */
	testConnection?: (draft: Partial<Record<ProviderKey, string>>) => Promise<TestResult>
}

// ── Generic test helpers (work for most OpenAI-compatible gateways) ──

async function testListModels(url: string, token: string): Promise<TestResult> {
	try {
		const resp = await requestUrl({
			url, method: 'GET',
			headers: { 'Authorization': `Bearer ${token}` },
			throw: false,
		})
		if (resp.status === 200) return { ok: true, message: 'Connected.' }
		if (resp.status === 401 || resp.status === 403) return { ok: false, message: 'Invalid API key.' }
		return { ok: false, message: `Unexpected status ${resp.status}.` }
	} catch (err: unknown) {
		return { ok: false, message: `Network error: ${err?.message || err}` }
	}
}

async function testGenericGet(url: string, headers: Record<string, string>): Promise<TestResult> {
	try {
		const resp = await requestUrl({ url, method: 'GET', headers, throw: false })
		if (resp.status === 200) return { ok: true, message: 'Connected.' }
		if (resp.status === 401 || resp.status === 403) return { ok: false, message: 'Invalid API key.' }
		return { ok: false, message: `Unexpected status ${resp.status}.` }
	} catch (err: unknown) {
		return { ok: false, message: `Network error: ${err?.message || err}` }
	}
}

function responseMessage(resp: { json?: unknown; text?: string }): string {
	const body = resp.json || (() => { try { return JSON.parse(resp.text || '') } catch { return null } })()
	const msg = body?.error?.message || body?.message || body?.output?.message || body?.code || resp.text || ''
	return typeof msg === 'string' ? msg : JSON.stringify(msg).substring(0, 240)
}

function isCredentialFailure(resp: { status: number; json?: unknown; text?: string }): boolean {
	if (resp.status === 401) return true
	if (resp.status !== 403) return false
	const msg = responseMessage(resp).toLowerCase()
	return /invalid|incorrect|unauthorized|api-?key/.test(msg) && /key|token|credential|api/.test(msg)
}

export const PROVIDERS: ProviderSpec[] = [
	{
		id: 'openai',
		name: 'OpenAI',
		description: 'GPT and GPT Image models.',
		docUrl: 'https://platform.openai.com/api-keys',
		fields: [{ key: 'openai', label: 'API Key', placeholder: 'sk-proj-...', type: 'password' }],
		isConfigured: (s) => !!s.providers.openai,
		makeImage: ({ settings, app, outputDir }) =>
			new OpenAIProvider(settings.providers.openai, app, outputDir),
		makeText: ({ settings }) =>
			new OpenAITextProvider(settings.providers.openai),
		testConnection: (d) => testListModels('https://api.openai.com/v1/models', d.openai || ''),
	},
	{
		id: 'anthropic',
		name: 'Anthropic',
		description: 'Claude models.',
		docUrl: 'https://console.anthropic.com/settings/keys',
		fields: [{ key: 'anthropic', label: 'API Key', placeholder: 'sk-ant-...', type: 'password' }],
		isConfigured: (s) => !!s.providers.anthropic,
		makeText: ({ settings }) =>
			new AnthropicTextProvider(settings.providers.anthropic),
		testConnection: async (d) => {
			const key = d.anthropic || ''
			if (!key) return { ok: false, message: 'API key is empty.' }
			try {
				// POST with invalid body → if auth fails returns 401/403; if 400 → auth passed
				const resp = await requestUrl({
					url: 'https://api.anthropic.com/v1/messages',
					method: 'POST',
					headers: {
						'x-api-key': key,
						'anthropic-version': '2023-06-01',
						'content-type': 'application/json',
					},
					body: '{}',
					throw: false,
				})
				if (resp.status === 401 || resp.status === 403) return { ok: false, message: 'Invalid API key.' }
				// 400 (missing fields) means auth passed — key is valid
				if (resp.status === 400 || resp.status === 200) return { ok: true, message: 'Connected.' }
				return { ok: false, message: `Unexpected status ${resp.status}.` }
			} catch (err: unknown) {
				return { ok: false, message: `Network error: ${err?.message || err}` }
			}
		},
	},
	{
		id: 'bedrock',
		name: 'AWS Bedrock',
		description: 'Claude via AWS.',
		docUrl: 'https://console.aws.amazon.com/bedrock/',
		fields: [
			{ key: 'bedrockAccessKeyId', label: 'Access Key ID', placeholder: 'Access Key ID', type: 'password' },
			{ key: 'bedrockSecretAccessKey', label: 'Secret Access Key', placeholder: 'Secret Access Key', type: 'password' },
			{ key: 'bedrockRegion', label: 'Region', placeholder: 'us-east-1', type: 'select', options: [
				{ label: 'us-east-1', value: 'us-east-1' },
				{ label: 'us-west-2', value: 'us-west-2' },
			]},
		],
		isConfigured: (s) => !!(s.providers.bedrockAccessKeyId && s.providers.bedrockSecretAccessKey && s.providers.bedrockRegion),
		makeText: ({ settings }) =>
			new BedrockClaudeTextProvider(settings.providers.bedrockAccessKeyId, settings.providers.bedrockSecretAccessKey, settings.providers.bedrockRegion),
		// Bedrock test would need full AWS SigV4 signing; skip for now (ship key-validation later)
	},
	{
		id: 'gemini',
		name: 'Google Gemini',
		description: 'Gemini, Imagen, and Veo.',
		docUrl: 'https://aistudio.google.com/apikey',
		fields: [{ key: 'gemini', label: 'API Key', placeholder: 'AIza...', type: 'password' }],
		isConfigured: (s) => !!s.providers.gemini,
		makeImage: ({ settings, app, outputDir }) =>
			new GeminiProvider(settings.providers.gemini, app, outputDir),
		makeVideo: ({ settings, app, outputDir }) =>
			new VeoProvider(settings.providers.gemini, app, outputDir),
		makeText: ({ settings }) =>
			new GeminiTextProvider(settings.providers.gemini),
		testConnection: async (d) => {
			const key = d.gemini || ''
			if (!key) return { ok: false, message: 'API key is empty.' }
			try {
				const resp = await requestUrl({
					url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
					method: 'GET',
					throw: false,
				})
				if (resp.status === 200) return { ok: true, message: 'Connected.' }
				// Gemini surfaces invalid / expired keys as 400 with reason = API_KEY_INVALID
				const err = resp.json?.error
				if (resp.status === 400 && err?.status === 'INVALID_ARGUMENT') {
					return { ok: false, message: err?.message || 'Invalid API key.' }
				}
				if (resp.status === 401 || resp.status === 403) return { ok: false, message: 'Invalid API key.' }
				return { ok: false, message: `Unexpected status ${resp.status}.` }
			} catch (err: unknown) {
				return { ok: false, message: `Network error: ${err?.message || err}` }
			}
		},
	},
	{
		id: 'bytedance',
		name: 'Volcengine',
		description: 'Seedream and Seedance.',
		docUrl: 'https://console.volcengine.com/ark',
		fields: [{ key: 'bytedance', label: 'ARK API Key', placeholder: '...', type: 'password' }],
		isConfigured: (s) => !!s.providers.bytedance,
		makeImage: ({ settings, app, outputDir }) =>
			new SeedreamProvider(settings.providers.bytedance, app, outputDir),
		makeVideo: ({ settings, app, outputDir }) =>
			new SeedanceProvider(settings.providers.bytedance, app, outputDir),
		testConnection: (d) => testListModels('https://ark.cn-beijing.volces.com/api/v3/models', d.bytedance || ''),
	},
	{
		id: 'byteplus',
		name: 'BytePlus',
		description: 'Seedance on the global endpoint.',
		docUrl: 'https://console.byteplus.com/ark',
		fields: [
			{ key: 'byteplus', label: 'ARK API Key', placeholder: '...', type: 'password' },
			{ key: 'byteplusAccessKey', label: 'Access Key (optional)', placeholder: 'AK...', type: 'password' },
			{ key: 'byteplusSecretKey', label: 'Secret Key (optional)', placeholder: 'SK...', type: 'password' },
			{ key: 'byteplusProjectName', label: 'Asset group ID (optional)', placeholder: 'default', type: 'text' },
		],
		isConfigured: (s) => !!s.providers.byteplus,
		makeVideo: ({ settings, app, outputDir }) =>
			new SeedanceProvider(settings.providers.byteplus, app, outputDir, 'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks'),
		testConnection: (d) => testListModels('https://ark.ap-southeast.bytepluses.com/api/v3/models', d.byteplus || ''),
	},
	{
		id: 'kling',
		name: 'Kling',
		description: 'Kling video models.',
		docUrl: 'https://app.klingai.com/global/dev/document-api/',
		fields: [
			{ key: 'klingAk', label: 'Access Key', placeholder: 'AK', type: 'password' },
			{ key: 'klingSk', label: 'Secret Key', placeholder: 'SK', type: 'password' },
		],
		isConfigured: (s) => !!(s.providers.klingAk && s.providers.klingSk),
		makeVideo: ({ settings, app, outputDir }) =>
			new KlingProvider(settings.providers.klingAk, settings.providers.klingSk, app, outputDir),
		// Kling uses JWT with HMAC-SHA256; auth is complex. Skip network test for now — Save will fail fast at first use.
	},
	{
		id: 'fal',
		name: 'fal.ai',
		description: 'Multi-model gateway.',
		docUrl: 'https://fal.ai/dashboard/keys',
		fields: [{ key: 'fal', label: 'API Key', placeholder: 'key-id:secret', type: 'password' }],
		isConfigured: (s) => !!s.providers.fal,
		makeImage: ({ settings, app, outputDir }) =>
			new FalImageProvider(settings.providers.fal, app, outputDir),
		makeVideo: ({ settings, app, outputDir }) =>
			new FalVideoProvider(settings.providers.fal, app, outputDir),
		makeAudio: ({ settings, app, outputDir }) =>
			new FalAudioProvider(settings.providers.fal, app, outputDir),
		testConnection: async (d) => {
			const key = d.fal || ''
			if (!key) return { ok: false, message: 'API key is empty.' }
			// fal uses `Authorization: Key <key>`. Hit the queue status endpoint of a well-known model.
			try {
				const resp = await requestUrl({
					url: 'https://queue.fal.run/fal-ai/fast-sdxl/requests/ping-test/status',
					method: 'GET',
					headers: { 'Authorization': `Key ${key}` },
					throw: false,
				})
				// 401/403 = bad key. 404 (request id not found) or any other status = auth passed.
				if (resp.status === 401 || resp.status === 403) return { ok: false, message: 'Invalid API key.' }
				return { ok: true, message: 'Connected.' }
			} catch (err: unknown) {
				return { ok: false, message: `Network error: ${err?.message || err}` }
			}
		},
	},
	{
		id: 'elevenlabs',
		name: 'ElevenLabs',
		description: 'Speech, music, and sound effects.',
		docUrl: 'https://elevenlabs.io/app/settings/api-keys',
		fields: [{ key: 'elevenlabs', label: 'API Key', placeholder: 'sk_...', type: 'password' }],
		isConfigured: (s) => !!s.providers.elevenlabs,
		makeAudio: ({ settings, app, outputDir }) =>
			new ElevenLabsProvider(settings.providers.elevenlabs, app, outputDir),
		testConnection: async (d) => {
			const key = d.elevenlabs || ''
			if (!key) return { ok: false, message: 'API key is empty.' }
			// ElevenLabs keys are fine-grained; a key scoped only for TTS returns 401 on
			// /v1/user + /v1/voices. Distinguish "bad key" from "valid key without this scope"
			// by inspecting the error code in the response body.
			try {
				const resp = await requestUrl({
					url: 'https://api.elevenlabs.io/v1/user',
					method: 'GET',
					headers: { 'xi-api-key': key },
					throw: false,
				})
				if (resp.status === 200) return { ok: true, message: 'Connected.' }
				const body = resp.json?.detail
				const reason = body?.status || body?.code || ''
				// missing_permissions / paid_plan_required / etc. → key is valid, just scoped
				if (typeof reason === 'string' && reason.startsWith('missing_permissions')) {
					return { ok: true, message: 'Connected (key is scope-limited, but valid).' }
				}
				if (resp.status === 401) return { ok: false, message: 'Invalid API key.' }
				return { ok: false, message: `Unexpected status ${resp.status}.` }
			} catch (err: unknown) {
				return { ok: false, message: `Network error: ${err?.message || err}` }
			}
		},
	},
	{
		id: 'minimax',
		name: 'MiniMax',
		description: 'Speech and music generation.',
		docUrl: 'https://platform.minimaxi.com/',
		fields: [{ key: 'minimax', label: 'Bearer Token', placeholder: 'eyJ...', type: 'password' }],
		isConfigured: (s) => !!s.providers.minimax,
		makeAudio: ({ settings, app, outputDir }) =>
			new MiniMaxProvider(settings.providers.minimax, app, outputDir),
		testConnection: async (d) => {
			const key = d.minimax || ''
			if (!key) return { ok: false, message: 'Token is empty.' }
			// MiniMax token is a JWT; decode for GroupId. The most reliable test is a cheap TTS call with dry-run false
			// but that costs quota. Use a GET on the API root — returns 401 on bad token, 404 or 200 on good.
			try {
				const resp = await requestUrl({
					url: 'https://api.minimax.io/v1/files/list',
					method: 'GET',
					headers: { 'Authorization': `Bearer ${key}` },
					throw: false,
				})
				if (resp.status === 401 || resp.status === 403) return { ok: false, message: 'Invalid token.' }
				// 200 / 400 / 404 all mean auth passed
				if (resp.status < 500) return { ok: true, message: 'Connected.' }
				return { ok: false, message: `Unexpected status ${resp.status}.` }
			} catch (err: unknown) {
				return { ok: false, message: `Network error: ${err?.message || err}` }
			}
		},
	},
	{
		id: 'dashscope',
		name: 'DashScope',
		description: 'Alibaba Cloud official model provider.',
		docUrl: 'https://dashscope.console.aliyun.com/',
		fields: [{ key: 'dashscope', label: 'API Key', placeholder: 'sk-...', type: 'password' }],
		isConfigured: (s) => !!s.providers.dashscope,
		makeAudio: ({ settings, app, outputDir }) =>
			new DashScopeAudioProvider(settings.providers.dashscope, app, outputDir),
		makeText: ({ settings }) =>
			new DashScopeTextProvider(settings.providers.dashscope),
		testConnection: async (d) => {
			const key = d.dashscope || ''
			if (!key) return { ok: false, message: 'API key is empty.' }
			try {
				const resp = await requestUrl({
					url: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${key}`,
					},
					// Deliberately invalid body: 400 means auth passed, without spending tokens.
					body: '{}',
					throw: false,
				})
				if (isCredentialFailure(resp)) return { ok: false, message: responseMessage(resp) || 'Invalid API key.' }
				if (resp.status < 500) return { ok: true, message: 'Connected.' }
				return { ok: false, message: `Unexpected status ${resp.status}.` }
			} catch (err: unknown) {
				return { ok: false, message: `Network error: ${err?.message || err}` }
			}
		},
	},
	{
		id: 'legnext',
		name: 'Legnext',
		description: 'Midjourney proxy.',
		docUrl: 'https://legnext.ai',
		fields: [{ key: 'legnext', label: 'API Key', placeholder: 'key...', type: 'password' }],
		isConfigured: (s) => !!s.providers.legnext,
		makeImage: ({ settings, app, outputDir }) =>
			new LegnextProvider(settings.providers.legnext, app, outputDir),
		testConnection: async (d) => {
			const key = d.legnext || ''
			if (!key) return { ok: false, message: 'API key is empty.' }
			return testGenericGet('https://api.legnext.ai/api/account/balance', { 'x-api-key': key })
		},
	},
	{
		id: 'tokenrouter',
		name: 'TokenRouter',
		description: 'All-in-one model gateway.',
		docUrl: 'https://www.tokenrouter.com',
		fields: [
			{ key: 'tokenrouter', label: 'API Key', placeholder: 'sk-...', type: 'password' },
			{ key: 'tokenrouterModelArkAssetGroupId', label: 'Asset group ID (optional)', placeholder: 'asset_group_id', type: 'text' },
		],
		isConfigured: (s) => !!s.providers.tokenrouter,
		makeImage: ({ settings, app, outputDir }) =>
			new TokenRouterImageProvider(settings.providers.tokenrouter, app, outputDir, 'https://api.tokenrouter.com/v1'),
		makeVideo: ({ settings, app, outputDir }) =>
			new TokenRouterVideoProvider(settings.providers.tokenrouter, app, outputDir, 'https://api.tokenrouter.com/v1'),
		makeText: ({ settings }) =>
			new TokenRouterTextProvider(settings.providers.tokenrouter, 'https://api.tokenrouter.com/v1'),
		testConnection: (d) => testListModels('https://api.tokenrouter.com/v1/models', d.tokenrouter || ''),
	},
	{
		id: 'token360',
		name: 'Token360',
		description: 'Unified AI gateway for Seedance video.',
		docUrl: 'https://www.token360.ai/en-US/docs/api-reference/video-generation/submit-video-generation-request',
		fields: [
			{ key: 'token360', label: 'API Key', placeholder: 'sk-token360-...', type: 'password' },
			{ key: 'token360AssetGroupId', label: 'Asset group ID (optional)', placeholder: 'legacy_rf_9032', type: 'text' },
		],
		isConfigured: (s) => !!s.providers.token360,
		makeVideo: ({ settings, app, outputDir }) =>
			new Token360VideoProvider(settings.providers.token360, app, outputDir),
		testConnection: async (d) => {
			const key = d.token360 || ''
			if (!key) return { ok: false, message: 'API key is empty.' }
			return testGenericGet('https://api.token360.ai/v1/videos?limit=1', { 'Authorization': `Bearer ${key}` })
		},
	},
	{
		id: 'mulerouter',
		name: 'MuleRouter',
		description: 'Wan 2.7 Spicy image-to-video.',
		docUrl: 'https://www.mulerouter.ai/docs/api-reference/endpoint/carrothub/wan2.7-i2v-spicy/generation',
		fields: [{ key: 'mulerouter', label: 'API Key', placeholder: 'sk-mr-...', type: 'password' }],
		isConfigured: (s) => !!s.providers.mulerouter,
		makeVideo: ({ settings, app, outputDir }) =>
			new MuleRouterVideoProvider(settings.providers.mulerouter, app, outputDir),
		testConnection: (d) => testMuleRouterConnection(d.mulerouter || ''),
	},
	{
		id: 'apimart',
		name: 'APIMart',
		description: 'GPT text and GPT Image 2 gateway.',
		docUrl: 'https://docs.apimart.ai/en/api-reference/texts/general/chat-completions-nostream',
		fields: [{ key: 'apimart', label: 'API Key', placeholder: 'sk-...', type: 'password' }],
		isConfigured: (s) => !!s.providers.apimart,
		makeImage: ({ settings, app, outputDir }) =>
			new APIMartProvider(settings.providers.apimart, app, outputDir),
		makeText: ({ settings }) =>
			new APIMartTextProvider(settings.providers.apimart, 'https://api.apimart.ai/v1'),
		testConnection: (d) => testListModels('https://api.apimart.ai/v1/models', d.apimart || ''),
	},
	{
		id: 'xai',
		name: 'xAI',
		description: 'Grok text, image, video, and TTS.',
		docUrl: 'https://console.x.ai',
		fields: [{ key: 'xai', label: 'API Key', placeholder: 'xai-...', type: 'password' }],
		isConfigured: (s) => !!s.providers.xai,
		makeImage: ({ settings, app, outputDir }) =>
			new XAIImageProvider(settings.providers.xai, app, outputDir),
		makeVideo: ({ settings, app, outputDir }) =>
			new XAIVideoProvider(settings.providers.xai, app, outputDir),
		makeText: ({ settings }) =>
			new XAITextProvider(settings.providers.xai),
		makeAudio: ({ settings, app, outputDir }) =>
			new XAIAudioProvider(settings.providers.xai, app, outputDir),
		testConnection: (d) => testListModels('https://api.x.ai/v1/models', d.xai || ''),
	},
	{
		id: 'luma',
		name: 'Luma',
		description: 'Luma Uni-1 image generation.',
		fields: [
			{ key: 'lumaToken', label: 'API Key', placeholder: 'API Key', type: 'password' },
		],
		isConfigured: (s) => !!s.providers.lumaToken,
		makeImage: ({ settings, app, outputDir }) =>
			new LumaProvider(LUMA_ENDPOINT, settings.providers.lumaToken, app, outputDir),
		testConnection: async (d) => {
			const endpoint = LUMA_ENDPOINT
			const token = d.lumaToken || ''
			if (!token) return { ok: false, message: 'API key is empty.' }
			try {
				// POST with empty body: 401 = bad token, 400 = token OK but missing prompt.
				const authResp = await requestUrl({
					url: `${endpoint}/v1/images/generate`,
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${token}`,
					},
					body: '{}',
					throw: false,
				})
				if (authResp.status === 401) return { ok: false, message: 'Invalid API key.' }
				if (authResp.status !== 400 && authResp.status !== 200) {
					return { ok: false, message: `Unexpected status ${authResp.status}.` }
				}
				// Auth passed — now check upstream account health.
				const healthResp = await requestUrl({ url: `${endpoint}/health`, method: 'GET', throw: false })
				const healthy = healthResp.json?.accounts?.healthy ?? 0
				if (healthy > 0) return { ok: true, message: `Connected. ${healthy} account(s) healthy.` }
				return { ok: false, message: 'Token OK but no healthy Luma accounts upstream.' }
			} catch (err: unknown) {
				return { ok: false, message: `Network error: ${err?.message || err}` }
			}
		},
	},
]

export function getProvider(id: string): ProviderSpec | undefined {
	return PROVIDERS.find(p => p.id === id)
}

export function getConfiguredProviderIds(settings: BragiSettings): string[] {
	return PROVIDERS.filter(p => p.isConfigured(settings)).map(p => p.id)
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

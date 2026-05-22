import type { ModelConfig } from './types'

export const gpt55: ModelConfig = {
	id: 'gpt-5.5',
	name: 'GPT-5.5',
	type: 'text',
	supportedProviders: {
		openai: { apiModelId: 'gpt-5.5' },
		tokenrouter: { apiModelId: 'openai/gpt-5.5' },
		apimart: { apiModelId: 'gpt-5.5' },
	},
	modes: ['text-to-text'],
	params: [],
}

export const gpt55Pro: ModelConfig = {
	id: 'gpt-5.5-pro',
	name: 'GPT-5.5 Pro',
	type: 'text',
	supportedProviders: {
		openai: { apiModelId: 'gpt-5.5-pro' },
		tokenrouter: { apiModelId: 'openai/gpt-5.5-pro' },
		apimart: { apiModelId: 'gpt-5.5-pro' },
	},
	modes: ['text-to-text'],
	params: [],
}

export const gemini31Pro: ModelConfig = {
	id: 'gemini-3.1-pro',
	name: 'Gemini 3.1 Pro',
	type: 'text',
	supportedProviders: {
		gemini: { apiModelId: 'gemini-3.1-pro-preview' },
		tokenrouter: { apiModelId: 'google/gemini-3.1-pro-preview' },
	},
	modes: ['text-to-text'],
	params: [],
}

export const gemini3Flash: ModelConfig = {
	id: 'gemini-3-flash',
	name: 'Gemini 3 Flash',
	type: 'text',
	supportedProviders: {
		gemini: { apiModelId: 'gemini-3-flash-preview' },
		tokenrouter: { apiModelId: 'google/gemini-3-flash-preview' },
	},
	modes: ['text-to-text'],
	params: [],
}

export const claudeOpus47: ModelConfig = {
	id: 'claude-opus-4-7',
	name: 'Claude Opus 4.7',
	type: 'text',
	supportedProviders: {
		anthropic: { apiModelId: 'claude-opus-4-7' },
		bedrock: { apiModelId: 'us.anthropic.claude-opus-4-7' },
		tokenrouter: { apiModelId: 'anthropic/claude-opus-4.7' },
	},
	modes: ['text-to-text'],
	params: [],
}

export const qwen36Plus: ModelConfig = {
	id: 'qwen-3-6-plus',
	name: 'Qwen 3.6 Plus',
	type: 'text',
	supportedProviders: {
		tokenrouter: { apiModelId: 'qwen/qwen3.6-plus' },
	},
	modes: ['text-to-text'],
	params: [],
}

export const claudeSonnet46: ModelConfig = {
	id: 'claude-sonnet-4-6',
	name: 'Claude Sonnet 4.6',
	type: 'text',
	supportedProviders: {
		anthropic: { apiModelId: 'claude-sonnet-4-6' },
		bedrock: { apiModelId: 'us.anthropic.claude-sonnet-4-6' },
		tokenrouter: { apiModelId: 'anthropic/claude-sonnet-4.6' },
	},
	modes: ['text-to-text'],
	params: [],
}

export const grok43: ModelConfig = {
	id: 'grok-4-3',
	name: 'Grok 4.3',
	type: 'text',
	supportedProviders: {
		xai: { apiModelId: 'grok-4.3' },
		tokenrouter: { apiModelId: 'x-ai/grok-4.3' },
	},
	modes: ['text-to-text'],
	params: [],
}

export const grok4Fast: ModelConfig = {
	id: 'grok-4-fast',
	name: 'Grok 4 Fast',
	type: 'text',
	supportedProviders: {
		xai: { apiModelId: 'grok-4-fast-non-reasoning' },
		tokenrouter: { apiModelId: 'x-ai/grok-4.1-fast' },
	},
	modes: ['text-to-text'],
	params: [],
}

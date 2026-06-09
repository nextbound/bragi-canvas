import type { ModelConfig, GenerationType, Mode } from './types'
import { gptImage } from './gpt-image'
import { nanoBananaPro, nanoBanana2 } from './nano-banana'
import { seedream5, seedream5Lite, seedream45 } from './seedream'
import { seedance2, seedance2Fast } from './seedance'
import { kling3, kling26 } from './kling'
import { happyHorseT2V, happyHorseI2V } from './happyhorse'
import { veo31, veo31Lite } from './veo'
import { zImageSpicy, qwenImageEditSpicy, wan27 } from './wan'
import { gpt55, gpt55Pro, gemini31Pro, gemini35Flash, gemini3Flash, claudeOpus47, claudeSonnet46, qwen36Plus, grok43, grok4Fast } from './text-gen'
import { grokImagine, grokVideo } from './grok'
import { midjourneyV8, midjourneyNiji7 } from './midjourney'
import { lumaUni1 } from './luma'
import { omniFlashExt } from './omni-flash'
import {
	elevenLabsTTS,
	minimaxTTS,
	dashScopeCosyVoice35Plus,
	dashScopeCosyVoice35Flash,
	dashScopeQwenVoice,
	grokTTS,
	elevenLabsMusic,
	minimaxMusic,
	elevenLabsSFX,
} from './audio'

// All registered models (default order within each type)
export const ALL_MODELS: ModelConfig[] = [
	// Image
	nanoBananaPro,
	nanoBanana2,
	gptImage,
	grokImagine,
	midjourneyV8,
	midjourneyNiji7,
	lumaUni1,
	seedream5,
	seedream5Lite,
	seedream45,
	zImageSpicy,
	qwenImageEditSpicy,
	// Video
	seedance2,
	seedance2Fast,
	kling3,
	kling26,
	happyHorseT2V,
	happyHorseI2V,
	wan27,
	veo31,
	veo31Lite,
	grokVideo,
	omniFlashExt,
	// Text
	claudeOpus47,
	claudeSonnet46,
	gemini35Flash,
	gemini3Flash,
	gemini31Pro,
	grok43,
	grok4Fast,
	qwen36Plus,
	gpt55Pro,
	gpt55,
	// Audio
	dashScopeCosyVoice35Plus,
	dashScopeCosyVoice35Flash,
	dashScopeQwenVoice,
	elevenLabsTTS,
	minimaxTTS,
	grokTTS,
	elevenLabsMusic,
	minimaxMusic,
	elevenLabsSFX,
]

/** Get all models of a given type */
export function getModelsByType(type: GenerationType): ModelConfig[] {
	return ALL_MODELS.filter(m => m.type === type)
}

/**
 * The modes a given provider actually exposes for a model. A provider may
 * restrict itself to a subset of the model's modes via `supportedProviders[p].modes`
 * (e.g. MuleRouter only offers Wan 2.7 first-frame). Falls back to the model's modes.
 */
export function getProviderModes(model: ModelConfig, providerId: string | undefined): Mode[] {
	const restricted = providerId ? model.supportedProviders[providerId]?.modes : undefined
	if (!restricted) return model.modes
	return model.modes.filter(mode => restricted.includes(mode))
}

/** Whether this provider routes the model's modes to multiple upstream ids internally. */
export function isAggregated(model: ModelConfig, providerId: string | undefined): boolean {
	return !!(providerId && model.supportedProviders[providerId]?.aggregated)
}

/** Get model by ID */
export function getModelById(id: string): ModelConfig | undefined {
	if (id === 'gpt-5.4') return gpt55
	if (id === 'gpt-5.4-pro') return gpt55Pro
	return ALL_MODELS.find(m => m.id === id)
}

/**
 * Get the active provider for a model, considering user preference and key availability.
 * Returns null if no provider is available.
 */
export function getActiveProvider(
	model: ModelConfig,
	selectedProvider: string | undefined,
	configuredProviders: string[]
): string | null {
	const supported = Object.keys(model.supportedProviders)

	// If user selected a provider and it's still valid, use it
	if (selectedProvider && supported.includes(selectedProvider) && configuredProviders.includes(selectedProvider)) {
		return selectedProvider
	}

	// Fallback to first supported provider that has a key
	for (const p of supported) {
		if (configuredProviders.includes(p)) return p
	}

	return null
}

/**
 * Get the ordered list of enabled models for a type, based on user settings.
 */
export function getEnabledModels(
	type: GenerationType,
	modelOrder: string[] | undefined,
	modelPrefs: Record<string, { enabled: boolean; selectedProvider: string }>,
	availableProviders: string[] | ((model: ModelConfig) => string[])
): ModelConfig[] {
	const allOfType = getModelsByType(type)

	// Apply user ordering
	let ordered: ModelConfig[]
	if (modelOrder && modelOrder.length > 0) {
		// Start with user-ordered models
		ordered = []
		for (const id of modelOrder) {
			const m = allOfType.find(m => m.id === id)
			if (m) ordered.push(m)
		}
		// Append any new models not in the saved order (e.g., added in an update)
		for (const m of allOfType) {
			if (!ordered.includes(m)) ordered.push(m)
		}
	} else {
		ordered = allOfType
	}

	// Filter to enabled models that have at least one configured provider
	return ordered.filter(m => {
		const pref = modelPrefs[m.id]
		if (pref?.enabled !== true) return false
		const providers = typeof availableProviders === 'function'
			? availableProviders(m)
			: availableProviders
		// Must have at least one working provider connected to this model.
		return getActiveProvider(m, pref.selectedProvider, providers) !== null
	})
}

export type { ModelConfig, GenerationType, Mode } from './types'

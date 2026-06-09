import type { BragiSettings } from './settings'
import { ALL_MODELS, getModelById, type ModelConfig } from './models'
import type { RefDelivery, RefModality } from './models/types'
import { getConfiguredProviderIds, getProvider, type ProviderKey } from './providers/registry'

export type ProviderCredentialDraft = Partial<Record<ProviderKey, string>>

export interface ResolvedRefDelivery {
	delivery: RefDelivery
	relayIfLargerThanBytes?: number
	nativeAssetProvider?: 'byteplus' | 'token360' | 'tokenrouter'
}

/**
 * Resolve how reference media of `modality` should be delivered to `providerId`
 * for `model`: per-model override (`supportedProviders[p].refDelivery`) wins over
 * the provider's `defaultRefDelivery`, falling back to `relay`.
 */
export function getRefDelivery(model: ModelConfig, providerId: string, modality: RefModality): ResolvedRefDelivery {
	const perModel = model.supportedProviders[providerId]?.refDelivery
	const perProvider = getProvider(providerId)?.defaultRefDelivery
	return {
		delivery: perModel?.[modality] ?? perProvider?.[modality] ?? 'relay',
		relayIfLargerThanBytes: perModel?.relayIfLargerThanBytes ?? perProvider?.relayIfLargerThanBytes,
		nativeAssetProvider: perModel?.nativeAssetProvider ?? perProvider?.nativeAssetProvider,
	}
}

function ensureProviderPrefs(settings: BragiSettings, providerId: string): Record<string, boolean> {
	if (!settings.providerModelPrefs) settings.providerModelPrefs = {}
	if (!settings.providerModelPrefs[providerId]) settings.providerModelPrefs[providerId] = {}
	return settings.providerModelPrefs[providerId]
}

export function providerSupportsModel(providerId: string, model: ModelConfig): boolean {
	return model.supportedProviders[providerId] !== undefined
}

const SUPPORT_TYPE_ORDER = ['text', 'image', 'video', 'audio'] as const
const SUPPORT_TYPE_LABELS: Record<(typeof SUPPORT_TYPE_ORDER)[number], string> = {
	text: 'text',
	image: 'image',
	video: 'video',
	audio: 'audio',
}

/**
 * One-line summary of how many catalog models of each type a provider supports,
 * e.g. "5 image, 3 video, 2 text models". Used in place of a static description.
 */
export function describeProviderModelSupport(providerId: string): string {
	const counts: Record<string, number> = {}
	let total = 0
	for (const model of ALL_MODELS) {
		if (model.supportedProviders[providerId]) {
			counts[model.type] = (counts[model.type] || 0) + 1
			total++
		}
	}
	if (total === 0) return 'No catalog models'
	const parts = SUPPORT_TYPE_ORDER
		.filter(type => counts[type])
		.map(type => `${counts[type]} ${SUPPORT_TYPE_LABELS[type]}`)
	return `Supports ${parts.join(', ')} model${total === 1 ? '' : 's'}`
}

/**
 * The API model id to send for `model` via `providerId`. Honours a user override
 * (settings.apiModelIdOverrides), then the catalog default, then the model id.
 */
export function resolveApiModelId(settings: BragiSettings, providerId: string, model: ModelConfig): string {
	return settings.apiModelIdOverrides?.[providerId]?.[model.id]
		|| model.supportedProviders[providerId]?.apiModelId
		|| model.id
}

export function isProviderConnectedToModel(settings: BragiSettings, providerId: string, modelId: string): boolean {
	const model = getModelById(modelId)
	return !!model && providerSupportsModel(providerId, model) && settings.providerModelPrefs?.[providerId]?.[modelId] === true
}

export function getConnectedProviderIds(settings: BragiSettings, model: ModelConfig): string[] {
	return Object.keys(model.supportedProviders)
		.filter(providerId => settings.providerModelPrefs?.[providerId]?.[model.id] === true)
}

export function getConnectedConfiguredProviderIds(settings: BragiSettings, model: ModelConfig): string[] {
	const configured = new Set(getConfiguredProviderIds(settings))
	return getConnectedProviderIds(settings, model).filter(providerId => configured.has(providerId))
}

export function connectProviderToModel(settings: BragiSettings, providerId: string, modelId: string): boolean {
	const model = getModelById(modelId)
	if (!model || !providerSupportsModel(providerId, model)) return false
	ensureProviderPrefs(settings, providerId)[modelId] = true
	return true
}

export function disconnectProviderFromModel(settings: BragiSettings, providerId: string, modelId: string): void {
	const providerPrefs = settings.providerModelPrefs?.[providerId]
	if (!providerPrefs) return
	delete providerPrefs[modelId]
	if (Object.keys(providerPrefs).length === 0) delete settings.providerModelPrefs[providerId]
}

export function disconnectModelFromAllProviders(settings: BragiSettings, modelId: string): void {
	for (const providerId of Object.keys(settings.providerModelPrefs || {})) {
		disconnectProviderFromModel(settings, providerId, modelId)
	}
}

export function enableModelWithProvider(
	settings: BragiSettings,
	modelId: string,
	providerId: string,
	options: { preserveActiveProvider?: boolean } = {},
): boolean {
	if (!connectProviderToModel(settings, providerId, modelId)) return false
	const existing = settings.modelPrefs[modelId]
	const keepActive = options.preserveActiveProvider !== false
		&& existing?.enabled === true
		&& !!existing.selectedProvider
	settings.modelPrefs[modelId] = {
		enabled: true,
		selectedProvider: keepActive ? existing.selectedProvider : providerId,
	}
	return true
}

export function disableModel(settings: BragiSettings, modelId: string): void {
	const pref = settings.modelPrefs[modelId]
	settings.modelPrefs[modelId] = {
		enabled: false,
		selectedProvider: pref?.selectedProvider || '',
	}
	disconnectModelFromAllProviders(settings, modelId)
}

export function getReplacementProvider(settings: BragiSettings, model: ModelConfig, removedProviderId: string): string | null {
	return getConnectedConfiguredProviderIds(settings, model)
		.find(providerId => providerId !== removedProviderId) || null
}

export function applyProviderCredentialDraft(
	settings: BragiSettings,
	providerId: string,
	draft: ProviderCredentialDraft,
): void {
	const spec = getProvider(providerId)
	if (!spec) return
	const providers = settings.providers as Record<ProviderKey, string>
	for (const field of spec.fields) {
		providers[field.key] = (draft[field.key] || '').trim()
	}
}

export function settingsWithProviderCredentialDraft(
	settings: BragiSettings,
	providerId: string,
	draft: ProviderCredentialDraft,
): BragiSettings {
	const providerModelPrefs: Record<string, Record<string, boolean>> = {}
	for (const [id, prefs] of Object.entries(settings.providerModelPrefs || {})) {
		providerModelPrefs[id] = { ...prefs }
	}
	const next: BragiSettings = {
		...settings,
		providers: { ...settings.providers },
		modelPrefs: { ...settings.modelPrefs },
		providerModelPrefs,
		modelOrder: {
			image: [...settings.modelOrder.image],
			video: [...settings.modelOrder.video],
			text: [...settings.modelOrder.text],
			audio: [...settings.modelOrder.audio],
		},
		knownCanvases: [...settings.knownCanvases],
		generatedAssets: [...settings.generatedAssets],
	}
	applyProviderCredentialDraft(next, providerId, draft)
	return next
}

export function pruneProviderModelPrefs(settings: BragiSettings): void {
	const validModelIds = new Set(ALL_MODELS.map(model => model.id))
	for (const [providerId, prefs] of Object.entries(settings.providerModelPrefs || {})) {
		const provider = getProvider(providerId)
		if (!provider) {
			delete settings.providerModelPrefs[providerId]
			continue
		}
		for (const modelId of Object.keys(prefs)) {
			const model = getModelById(modelId)
			if (!validModelIds.has(modelId) || !model || !providerSupportsModel(providerId, model) || prefs[modelId] !== true) {
				delete prefs[modelId]
			}
		}
		if (Object.keys(prefs).length === 0) delete settings.providerModelPrefs[providerId]
	}
}

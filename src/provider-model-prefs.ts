import type { BragiSettings } from './settings'
import { ALL_MODELS, getModelById, type ModelConfig } from './models'
import { getConfiguredProviderIds, getProvider, type ProviderKey } from './providers/registry'

export type ProviderCredentialDraft = Partial<Record<ProviderKey, string>>

function ensureProviderPrefs(settings: BragiSettings, providerId: string): Record<string, boolean> {
	if (!settings.providerModelPrefs) settings.providerModelPrefs = {}
	if (!settings.providerModelPrefs[providerId]) settings.providerModelPrefs[providerId] = {}
	return settings.providerModelPrefs[providerId]
}

export function providerSupportsModel(providerId: string, model: ModelConfig): boolean {
	return model.supportedProviders[providerId] !== undefined
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

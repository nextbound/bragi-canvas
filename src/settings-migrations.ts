import { ALL_MODELS } from './models'
import {
	connectProviderToModel,
	disconnectModelFromAllProviders,
	getConnectedConfiguredProviderIds,
	pruneProviderModelPrefs,
} from './provider-model-prefs'
import { getConfiguredProviderIds } from './providers/registry'
import { DEFAULT_SETTINGS, type BragiSettings, type GeneratedAssetRecord, type LastSelection, type ModelPref, type UpdatePromptState } from './settings'

type UnknownRecord = Record<string, unknown>

export const CURRENT_SETTINGS_SCHEMA_VERSION = 7
const PROVIDER_MODEL_PREFS_SCHEMA_VERSION = 2

export interface SettingsMigrationResult {
	settings: BragiSettings
	changed: boolean
	valid: boolean
	errors: string[]
}

export interface SettingsMigrationOptions {
	requireRecognizable?: boolean
	strict?: boolean
}

function isRecord(value: unknown): value is UnknownRecord {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cloneDefaultSettings(defaults: BragiSettings): BragiSettings {
	return {
		...defaults,
		providers: { ...defaults.providers },
		modelPrefs: {},
		providerModelPrefs: {},
		apiModelIdOverrides: {},
		modelOrder: {
			image: [],
			video: [],
			text: [],
			audio: [],
		},
		knownCanvases: [],
		generatedAssets: [],
		updatePrompt: {},
	}
}

function readOptionalString(source: UnknownRecord, key: string, target: UnknownRecord, errors: string[]): void {
	if (!(key in source)) return
	const value = source[key]
	if (typeof value !== 'string') {
		errors.push(key)
		return
	}
	target[key] = value
}

function readOptionalBoolean(source: UnknownRecord, key: string, target: UnknownRecord, errors: string[]): void {
	if (!(key in source)) return
	const value = source[key]
	if (typeof value !== 'boolean') {
		errors.push(key)
		return
	}
	target[key] = value
}

function readOptionalSchemaVersion(source: UnknownRecord, settings: BragiSettings, errors: string[]): void {
	if (!('settingsSchemaVersion' in source)) return
	const value = source.settingsSchemaVersion
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
		errors.push('settingsSchemaVersion')
		return
	}
	settings.settingsSchemaVersion = value
}

function readOptionalPort(source: UnknownRecord, key: string, target: UnknownRecord, errors: string[]): void {
	if (!(key in source)) return
	const value = source[key]
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
		errors.push(key)
		return
	}
	target[key] = value
}

function readOptionalStringArray(source: UnknownRecord, key: string, target: UnknownRecord, errors: string[]): void {
	if (!(key in source)) return
	const value = source[key]
	if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
		errors.push(key)
		return
	}
	target[key] = [...new Set(value)]
}

function readGeneratedAssets(source: UnknownRecord, errors: string[]): GeneratedAssetRecord[] {
	if (!('generatedAssets' in source)) return []
	const value = source.generatedAssets
	if (!Array.isArray(value)) {
		errors.push('generatedAssets')
		return []
	}
	const items = value as unknown[]
	const records: GeneratedAssetRecord[] = []
	for (let i = 0; i < items.length; i++) {
		const record = items[i]
		if (!isRecord(record)) {
			errors.push(`generatedAssets.${i}`)
			continue
		}
		if (typeof record.path !== 'string') {
			errors.push(`generatedAssets.${i}.path`)
			continue
		}
		if (typeof record.canvasPath !== 'string') {
			errors.push(`generatedAssets.${i}.canvasPath`)
			continue
		}
		if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) {
			errors.push(`generatedAssets.${i}.createdAt`)
			continue
		}
		records.push({
			path: record.path,
			canvasPath: record.canvasPath,
			createdAt: record.createdAt,
		})
	}
	return records
}

function readUpdatePrompt(source: UnknownRecord, errors: string[]): UpdatePromptState {
	if (!('updatePrompt' in source)) return {}
	const value = source.updatePrompt
	if (!isRecord(value)) {
		errors.push('updatePrompt')
		return {}
	}

	const result: UpdatePromptState = {}
	for (const key of ['lastCheckedAt', 'lastPromptedAt'] as const) {
		const n = value[key]
		if (n === undefined) continue
		if (typeof n !== 'number' || !Number.isFinite(n)) {
			errors.push(`updatePrompt.${key}`)
			continue
		}
		result[key] = n
	}
	for (const key of ['latestVersion', 'latestReleaseUrl', 'latestReleaseName', 'lastPromptedVersion'] as const) {
		const s = value[key]
		if (s === undefined) continue
		if (typeof s !== 'string') {
			errors.push(`updatePrompt.${key}`)
			continue
		}
		result[key] = s
	}

	return result
}

function readLastSelection(source: UnknownRecord, key: string, errors: string[]): LastSelection | undefined {
	if (!(key in source)) return undefined
	const value = source[key]
	if (!isRecord(value)) {
		errors.push(key)
		return undefined
	}

	const result: LastSelection = {}

	if ('modelId' in value) {
		if (typeof value.modelId !== 'string') errors.push(`${key}.modelId`)
		else result.modelId = value.modelId
	}

	if ('batchCount' in value) {
		if (typeof value.batchCount !== 'number' || !Number.isFinite(value.batchCount)) errors.push(`${key}.batchCount`)
		else result.batchCount = value.batchCount
	}

	if ('params' in value) {
		if (!isRecord(value.params)) {
			errors.push(`${key}.params`)
		} else {
			const params: Record<string, string | number> = {}
			for (const [paramKey, paramValue] of Object.entries(value.params)) {
				if (typeof paramValue !== 'string' && (typeof paramValue !== 'number' || !Number.isFinite(paramValue))) {
					errors.push(`${key}.params.${paramKey}`)
					continue
				}
				params[paramKey] = paramValue
			}
			result.params = params
		}
	}

	return result
}

function readModelPrefs(raw: UnknownRecord, settings: BragiSettings, errors: string[]): void {
	if (!('modelPrefs' in raw)) return
	if (!isRecord(raw.modelPrefs)) {
		errors.push('modelPrefs')
		return
	}
	for (const [modelId, value] of Object.entries(raw.modelPrefs)) {
		if (!isRecord(value)) {
			errors.push(`modelPrefs.${modelId}`)
			continue
		}
		if (typeof value.enabled !== 'boolean') {
			errors.push(`modelPrefs.${modelId}.enabled`)
			continue
		}
		if ('selectedProvider' in value && typeof value.selectedProvider !== 'string') {
			errors.push(`modelPrefs.${modelId}.selectedProvider`)
			continue
		}
		settings.modelPrefs[modelId] = {
			enabled: value.enabled,
			selectedProvider: typeof value.selectedProvider === 'string' ? value.selectedProvider : '',
		}
	}
}

function readProviderModelPrefs(raw: UnknownRecord, settings: BragiSettings, errors: string[]): void {
	if (!('providerModelPrefs' in raw)) return
	if (!isRecord(raw.providerModelPrefs)) {
		errors.push('providerModelPrefs')
		return
	}
	for (const [providerId, rawPrefs] of Object.entries(raw.providerModelPrefs)) {
		if (!isRecord(rawPrefs)) {
			errors.push(`providerModelPrefs.${providerId}`)
			continue
		}
		const prefs: Record<string, boolean> = {}
		for (const [modelId, value] of Object.entries(rawPrefs)) {
			if (typeof value !== 'boolean') {
				errors.push(`providerModelPrefs.${providerId}.${modelId}`)
				continue
			}
			if (value) prefs[modelId] = true
		}
		if (Object.keys(prefs).length > 0) settings.providerModelPrefs[providerId] = prefs
	}
}

function readApiModelIdOverrides(raw: UnknownRecord, settings: BragiSettings, errors: string[]): void {
	if (!('apiModelIdOverrides' in raw)) return
	if (!isRecord(raw.apiModelIdOverrides)) {
		errors.push('apiModelIdOverrides')
		return
	}
	for (const [providerId, rawOverrides] of Object.entries(raw.apiModelIdOverrides)) {
		if (!isRecord(rawOverrides)) {
			errors.push(`apiModelIdOverrides.${providerId}`)
			continue
		}
		const overrides: Record<string, string> = {}
		for (const [modelId, value] of Object.entries(rawOverrides)) {
			if (typeof value !== 'string') {
				errors.push(`apiModelIdOverrides.${providerId}.${modelId}`)
				continue
			}
			const trimmed = value.trim()
			if (trimmed) overrides[modelId] = trimmed
		}
		if (Object.keys(overrides).length > 0) settings.apiModelIdOverrides[providerId] = overrides
	}
}

function readModelOrder(raw: UnknownRecord, settings: BragiSettings, errors: string[]): void {
	if (!('modelOrder' in raw)) return
	if (!isRecord(raw.modelOrder)) {
		errors.push('modelOrder')
		return
	}
	for (const type of ['image', 'video', 'text', 'audio'] as const) {
		const value = raw.modelOrder[type]
		if (value === undefined) continue
		if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
			errors.push(`modelOrder.${type}`)
			continue
		}
		settings.modelOrder[type] = [...(value as string[])]
	}
}

function readSettings(raw: UnknownRecord, defaults: BragiSettings): { settings: BragiSettings; errors: string[] } {
	const settings = cloneDefaultSettings(defaults)
	const target = settings as unknown as UnknownRecord
	const errors: string[] = []

	readOptionalSchemaVersion(raw, settings, errors)
	readOptionalString(raw, 'outputDir', target, errors)
	readOptionalBoolean(raw, 'migrationPrompted', target, errors)
	readOptionalBoolean(raw, 'migrationProviders_1_9', target, errors)
	readOptionalBoolean(raw, 'mcpEnabled', target, errors)
	readOptionalPort(raw, 'mcpPort', target, errors)
	readOptionalString(raw, 'mcpToken', target, errors)
	readOptionalStringArray(raw, 'knownCanvases', target, errors)
	settings.generatedAssets = readGeneratedAssets(raw, errors)
	settings.updatePrompt = readUpdatePrompt(raw, errors)

	if ('providers' in raw) {
		if (!isRecord(raw.providers)) {
			errors.push('providers')
		} else {
			const providerKeys = Object.keys(defaults.providers) as Array<keyof BragiSettings['providers']>
			for (const key of providerKeys) {
				const value = raw.providers[key]
				if (value === undefined) continue
				if (typeof value !== 'string') {
					errors.push(`providers.${key}`)
					continue
				}
				settings.providers[key] = value
			}
		}
	}

	readModelPrefs(raw, settings, errors)
	readProviderModelPrefs(raw, settings, errors)
	readApiModelIdOverrides(raw, settings, errors)
	readModelOrder(raw, settings, errors)

	const lastImage = readLastSelection(raw, 'lastImage', errors)
	const lastVideo = readLastSelection(raw, 'lastVideo', errors)
	const lastAudio = readLastSelection(raw, 'lastAudio', errors)
	const lastText = readLastSelection(raw, 'lastText', errors)
	if (lastImage) settings.lastImage = lastImage
	if (lastVideo) settings.lastVideo = lastVideo
	if (lastAudio) settings.lastAudio = lastAudio
	if (lastText) settings.lastText = lastText

	return { settings, errors }
}

const DASHSCOPE_PROVIDER_ID = 'dashscope'
const LEGACY_DASHSCOPE_PROVIDER_ID = ['bai', 'lian'].join('')
const LEGACY_DASHSCOPE_MODEL_PREFIX = `${LEGACY_DASHSCOPE_PROVIDER_ID}-`
const DASHSCOPE_MODEL_PREFIX = 'dashscope-'
const LEGACY_MODEL_ID_RENAMES: Record<string, string> = {
	'gpt-5.4': 'gpt-5.5',
	'gpt-5.4-pro': 'gpt-5.5-pro',
	'claude-opus-4-6': 'claude-opus-4-7',
	'dashscope-qwen3-tts-vc': 'dashscope-qwen-voice',
	'dashscope-qwen3-tts-flash': 'dashscope-qwen-voice',
	'dashscope-qwen3-tts-instruct-flash': 'dashscope-qwen-voice',
}

function normalizeDashScopeProviderId(provider: string): string {
	return provider === LEGACY_DASHSCOPE_PROVIDER_ID ? DASHSCOPE_PROVIDER_ID : provider
}

function normalizeLegacyModelId(modelId: string | undefined): string | undefined {
	if (!modelId) return modelId
	const dashScopeNormalized = modelId.startsWith(LEGACY_DASHSCOPE_MODEL_PREFIX)
		? `${DASHSCOPE_MODEL_PREFIX}${modelId.slice(LEGACY_DASHSCOPE_MODEL_PREFIX.length)}`
		: modelId
	return LEGACY_MODEL_ID_RENAMES[dashScopeNormalized] || dashScopeNormalized
}

function mergeModelPref(existing: ModelPref | undefined, incoming: ModelPref): ModelPref {
	if (!existing) return { ...incoming }
	if (existing.enabled === true) {
		return {
			enabled: true,
			selectedProvider: existing.selectedProvider || incoming.selectedProvider || '',
		}
	}
	if (incoming.enabled === true) {
		return {
			enabled: true,
			selectedProvider: incoming.selectedProvider || existing.selectedProvider || '',
		}
	}
	return {
		enabled: false,
		selectedProvider: existing.selectedProvider || incoming.selectedProvider || '',
	}
}

function migrateDashScopeSettings(settings: BragiSettings, raw: UnknownRecord): void {
	const rawProviders = isRecord(raw.providers) ? raw.providers : null
	const legacyKey = rawProviders?.[LEGACY_DASHSCOPE_PROVIDER_ID]
	if (!settings.providers.dashscope && typeof legacyKey === 'string') {
		settings.providers.dashscope = legacyKey
	}
	delete (settings.providers as UnknownRecord)[LEGACY_DASHSCOPE_PROVIDER_ID]

	const modelPrefs: Record<string, ModelPref> = {}
	for (const [modelId, pref] of Object.entries(settings.modelPrefs)) {
		const normalizedId = normalizeLegacyModelId(modelId) || modelId
		modelPrefs[normalizedId] = mergeModelPref(modelPrefs[normalizedId], {
			...pref,
			selectedProvider: normalizeDashScopeProviderId(pref.selectedProvider || ''),
		})
	}
	settings.modelPrefs = modelPrefs

	const providerModelPrefs: Record<string, Record<string, boolean>> = {}
	for (const [providerId, prefs] of Object.entries(settings.providerModelPrefs || {})) {
		const normalizedProvider = normalizeDashScopeProviderId(providerId)
		if (!providerModelPrefs[normalizedProvider]) providerModelPrefs[normalizedProvider] = {}
		for (const [modelId, enabled] of Object.entries(prefs)) {
			if (enabled) providerModelPrefs[normalizedProvider][normalizeLegacyModelId(modelId) || modelId] = true
		}
	}
	settings.providerModelPrefs = providerModelPrefs

	for (const type of ['image', 'video', 'text', 'audio'] as const) {
		const seen = new Set<string>()
		settings.modelOrder[type] = settings.modelOrder[type]
			.map(id => normalizeLegacyModelId(id) || id)
			.filter(id => {
				if (seen.has(id)) return false
				seen.add(id)
				return true
			})
	}

	for (const selection of [settings.lastImage, settings.lastVideo, settings.lastAudio, settings.lastText]) {
		if (selection?.modelId) selection.modelId = normalizeLegacyModelId(selection.modelId)
	}
}

function migrateByteplusGroupId(settings: BragiSettings, raw: UnknownRecord): void {
	// The old `byteplusProjectName` field was mislabelled "Asset group ID" in the UI,
	// so some users typed a real asset group id into it. Carry those over to the new
	// `byteplusAssetGroupId` field; plain project names (e.g. "default") are dropped.
	if (settings.providers.byteplusAssetGroupId) return
	const rawProviders = isRecord(raw.providers) ? raw.providers : null
	const legacy = rawProviders?.byteplusProjectName
	if (typeof legacy === 'string' && /^group-/.test(legacy.trim())) {
		settings.providers.byteplusAssetGroupId = legacy.trim()
	}
}

function migrateProviderPrefs19(settings: BragiSettings): void {
	if (settings.migrationProviders_1_9) return

	const configured = new Set(getConfiguredProviderIds(settings))
	for (const model of ALL_MODELS) {
		const existing = settings.modelPrefs[model.id]
		if (existing && existing.enabled === false) continue

		const supported = Object.keys(model.supportedProviders)
		const match = supported.find(providerId => configured.has(providerId))
		if (!match) continue

		settings.modelPrefs[model.id] = {
			enabled: true,
			selectedProvider: existing?.selectedProvider && supported.includes(existing.selectedProvider) && configured.has(existing.selectedProvider)
				? existing.selectedProvider
				: match,
		}
	}

	settings.migrationProviders_1_9 = true
}

function migrateProviderModelPrefs(settings: BragiSettings, previousVersion: number): void {
	if (previousVersion >= PROVIDER_MODEL_PREFS_SCHEMA_VERSION) {
		pruneProviderModelPrefs(settings)
		return
	}

	settings.providerModelPrefs = {}
	const configured = new Set(getConfiguredProviderIds(settings))

	for (const model of ALL_MODELS) {
		const pref = settings.modelPrefs[model.id]
		if (pref?.enabled !== true) {
			disconnectModelFromAllProviders(settings, model.id)
			continue
		}

		const supportedConfigured = Object.keys(model.supportedProviders)
			.filter(providerId => configured.has(providerId))
		for (const providerId of supportedConfigured) {
			connectProviderToModel(settings, providerId, model.id)
		}

		const connected = getConnectedConfiguredProviderIds(settings, model)
		if (pref.selectedProvider && connected.includes(pref.selectedProvider)) continue
		settings.modelPrefs[model.id] = {
			enabled: true,
			selectedProvider: connected[0] || '',
		}
		if (connected.length === 0) settings.modelPrefs[model.id].enabled = false
	}

	pruneProviderModelPrefs(settings)
}

function migrateDashScopeWan27(settings: BragiSettings, previousVersion: number): void {
	if (previousVersion >= 6) return
	if (!settings.providers.dashscope?.trim()) return
	const modelId = 'wan-2.7'
	if (!connectProviderToModel(settings, 'dashscope', modelId)) return
	settings.modelPrefs[modelId] = {
		enabled: true,
		selectedProvider: 'dashscope',
	}
}

const RECOGNIZABLE_KEYS = [
	'settingsSchemaVersion',
	'outputDir',
	'providers',
	'modelPrefs',
	'providerModelPrefs',
	'apiModelIdOverrides',
	'modelOrder',
	'mcpEnabled',
	'mcpPort',
	'mcpToken',
	'knownCanvases',
	'generatedAssets',
	'updatePrompt',
]

export function isSettingsLike(raw: unknown): boolean {
	return isRecord(raw) && RECOGNIZABLE_KEYS.some(key => key in raw)
}

export function migrateSettings(
	raw: unknown,
	defaults: BragiSettings = DEFAULT_SETTINGS,
	options: SettingsMigrationOptions = {},
): SettingsMigrationResult {
	if (!isRecord(raw)) {
		return {
			settings: cloneDefaultSettings(defaults),
			changed: true,
			valid: false,
			errors: ['root'],
		}
	}
	if (options.requireRecognizable && !isSettingsLike(raw)) {
		return {
			settings: cloneDefaultSettings(defaults),
			changed: false,
			valid: false,
			errors: ['unrecognized'],
		}
	}

	const { settings, errors } = readSettings(raw, defaults)
	const previousVersion = settings.settingsSchemaVersion || 0

	migrateDashScopeSettings(settings, raw)
	migrateByteplusGroupId(settings, raw)
	migrateProviderPrefs19(settings)
	migrateProviderModelPrefs(settings, previousVersion)
	migrateDashScopeWan27(settings, previousVersion)
	settings.settingsSchemaVersion = CURRENT_SETTINGS_SCHEMA_VERSION

	const valid = options.strict ? errors.length === 0 : true
	const before = JSON.stringify(raw)
	const after = JSON.stringify(settings)
	return {
		settings,
		changed: before !== after,
		valid,
		errors,
	}
}

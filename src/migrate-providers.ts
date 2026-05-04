import type BragiCanvas from './main'
import { ALL_MODELS } from './models'
import { getConfiguredProviderIds } from './providers/registry'

/**
 * One-time migration for 1.9.0 UX change:
 * Before: modelPrefs[id].enabled defaulted to "true for any model with a configured provider" (implicit).
 * After: modelPrefs[id].enabled must be explicitly true (Add Model flow). The setting.
 *
 * To keep existing users from losing their working setup, on first load post-1.9.0:
 *   - For every model that currently has a configured provider (under old rules), set enabled = true.
 *   - Mark migrationProviders_1_9 = true so we don't run this again.
 *
 * This is a no-op for fresh installs (no configured providers → nothing to enable).
 */
export async function migrateProviderPrefs(plugin: BragiCanvas): Promise<void> {
	if (plugin.settings.migrationProviders_1_9) return

	const configured = new Set(getConfiguredProviderIds(plugin.settings))
	for (const model of ALL_MODELS) {
		const existing = plugin.settings.modelPrefs[model.id]
		// If user explicitly disabled, respect that.
		if (existing && existing.enabled === false) continue

		const supported = Object.keys(model.supportedProviders)
		const match = supported.find(p => configured.has(p))
		if (!match) continue

		plugin.settings.modelPrefs[model.id] = {
			enabled: true,
			selectedProvider: existing?.selectedProvider && supported.includes(existing.selectedProvider) && configured.has(existing.selectedProvider)
				? existing.selectedProvider
				: match,
		}
	}

	plugin.settings.migrationProviders_1_9 = true
	await plugin.saveSettings()
}

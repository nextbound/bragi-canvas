import { App, Modal, Notice } from 'obsidian'
import type BragiCanvas from '../main'
import { PROVIDERS, getProvider, getConfiguredProviderIds } from '../providers/registry'
import { ALL_MODELS, type ModelConfig } from '../models'

type Impact = {
	disappearing: ModelConfig[]
	switching: Array<{ model: ModelConfig; from: string; to: string }>
}

/** Compute what happens to enabled models if we remove this provider. */
export function computeRemovalImpact(plugin: BragiCanvas, providerId: string): Impact {
	const spec = getProvider(providerId)
	if (!spec) return { disappearing: [], switching: [] }

	// Hypothetical settings: clear this provider's fields
	const fakeSettings = JSON.parse(JSON.stringify(plugin.settings))
	for (const f of spec.fields) {
		fakeSettings.providers[f.key] = ''
	}
	const nextConfigured = new Set(getConfiguredProviderIds(fakeSettings))

	const impact: Impact = { disappearing: [], switching: [] }
	for (const model of ALL_MODELS) {
		const pref = plugin.settings.modelPrefs[model.id]
		if (!pref?.enabled) continue

		const supported = Object.keys(model.supportedProviders)
		const currentProvider = pref.selectedProvider && supported.includes(pref.selectedProvider)
			? pref.selectedProvider
			: supported.find(p => getConfiguredProviderIds(plugin.settings).includes(p))

		if (!currentProvider || currentProvider !== providerId) continue

		// This model was using the provider we're removing — find a replacement
		const replacement = supported.find(p => p !== providerId && nextConfigured.has(p))
		if (replacement) {
			impact.switching.push({ model, from: providerId, to: replacement })
		} else {
			impact.disappearing.push(model)
		}
	}
	return impact
}

/** Apply the removal: blank the fields, then update modelPrefs for affected models. */
export async function applyRemoval(plugin: BragiCanvas, providerId: string, impact: Impact) {
	const spec = getProvider(providerId)
	if (!spec) return
	for (const f of spec.fields) {
		(plugin.settings.providers as any)[f.key] = ''
	}
	for (const { model, to } of impact.switching) {
		const pref = plugin.settings.modelPrefs[model.id] || { enabled: true, selectedProvider: to }
		pref.selectedProvider = to
		plugin.settings.modelPrefs[model.id] = pref
	}
	for (const model of impact.disappearing) {
		const pref = plugin.settings.modelPrefs[model.id] || { enabled: false, selectedProvider: '' }
		pref.enabled = false
		plugin.settings.modelPrefs[model.id] = pref
	}
	await plugin.saveSettings()
}

/**
 * Remove a provider. If any models would be unlisted, pops a confirm modal first.
 * Otherwise applies silently (with a Notice if models got switched).
 */
export function removeProvider(plugin: BragiCanvas, providerId: string, onDone: () => void) {
	const spec = getProvider(providerId)
	if (!spec) return

	const impact = computeRemovalImpact(plugin, providerId)

	if (impact.disappearing.length === 0) {
		// Silent removal (possibly with auto-switch Notice)
		applyRemoval(plugin, providerId, impact).then(() => {
			if (impact.switching.length > 0) {
				new Notice(`${spec.name} removed — ${impact.switching.length} model${impact.switching.length === 1 ? '' : 's'} switched provider`)
			} else {
				new Notice(`${spec.name} removed`)
			}
			onDone()
		})
		return
	}

	// Has disappearing models: confirm modal
	new RemoveProviderConfirmModal(plugin, spec.name, providerId, impact, onDone).open()
}

class RemoveProviderConfirmModal extends Modal {
	constructor(
		private plugin: BragiCanvas,
		private providerName: string,
		private providerId: string,
		private impact: Impact,
		private onDone: () => void,
	) {
		super(plugin.app)
	}

	onOpen() {
		const { contentEl, titleEl, modalEl } = this
		modalEl.classList.add('bragi-modal')
		titleEl.setText(`Remove ${this.providerName}?`)

		if (this.impact.disappearing.length > 0) {
			const p = contentEl.createEl('p', { cls: 'mod-warning' })
			p.setText(`These models will be removed because no other configured provider supports them:`)
			const ul = contentEl.createEl('ul')
			for (const m of this.impact.disappearing) {
				ul.createEl('li', { text: m.name })
			}
		}

		if (this.impact.switching.length > 0) {
			contentEl.createEl('p', { text: `These models will keep working but switch provider:` })
			const ul = contentEl.createEl('ul')
			for (const s of this.impact.switching) {
				const toName = getProvider(s.to)?.name || s.to
				ul.createEl('li', { text: `${s.model.name} → ${toName}` })
			}
		}

		const row = contentEl.createDiv({ cls: 'modal-button-container' })
		const cancel = row.createEl('button', { text: 'Cancel' })
		cancel.addEventListener('click', () => this.close())
		const confirm = row.createEl('button', { text: 'Remove', cls: 'mod-destructive' })
		confirm.style.backgroundColor = 'var(--text-error)'
		confirm.style.color = 'white'
		confirm.addEventListener('click', async () => {
			await applyRemoval(this.plugin, this.providerId, this.impact)
			this.close()
			new Notice(`${this.providerName} removed`)
			this.onDone()
		})
	}

	onClose() {
		this.contentEl.empty()
	}
}

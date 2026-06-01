/* eslint-disable @typescript-eslint/no-unsafe-assignment -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import { Modal, Setting, Notice, setIcon, setTooltip } from 'obsidian'
import type BragiCanvas from '../main'
import { describeProviderModelSupport, settingsWithProviderCredentialDraft, type ProviderCredentialDraft } from '../provider-model-prefs'
import { PROVIDERS, type ProviderSpec } from '../providers/registry'

export interface AddProviderModalOptions {
	/** Jump straight to the form for this provider (skips the picker). */
	initialProviderId?: string
	/** Restrict the form's provider dropdown to these provider IDs.
	 *  If exactly 1, behaves like `initialProviderId`.
	 *  If >1, the form renders with a Provider select at the top.
	 */
	providerChoices?: string[]
	/** Called after a successful save with the saved provider's id. */
	onSaved?: (providerId: string) => void
	/** Called with validated draft credentials without mutating settings. */
	onSubmitDraft?: (providerId: string, draft: ProviderCredentialDraft) => void
	initialDraftValues?: ProviderCredentialDraft
	submitLabel?: string
	/** If provided, the form's cancel button reads "Back" and calls this instead of just closing. */
	onBack?: () => void
}

/**
 * Modal for adding / editing a provider.
 * Flows:
 *   - Fresh open → picker (flat searchable list)
 *   - initialProviderId set → form for that provider
 *   - providerChoices set (>1) → form with top dropdown choosing between them
 */
export class AddProviderModal extends Modal {
	private readonly opts: AddProviderModalOptions

	constructor(plugin: BragiCanvas, optsOrLegacyId?: AddProviderModalOptions | string, legacyOnSaved?: () => void) {
		super(plugin.app)
		this.plugin = plugin
		// Back-compat: old signature was (plugin, initialProviderId?, onSaved?)
		if (typeof optsOrLegacyId === 'string' || optsOrLegacyId === undefined) {
			this.opts = {
				initialProviderId: typeof optsOrLegacyId === 'string' ? optsOrLegacyId : undefined,
				onSaved: legacyOnSaved ? () => legacyOnSaved() : undefined,
			}
		} else {
			this.opts = optsOrLegacyId
		}
	}

	private plugin: BragiCanvas

	onOpen() {
		const { contentEl, modalEl } = this
		modalEl.classList.add('bragi-modal', 'bragi-add-provider-modal')
		contentEl.empty()

		// From Add Model flow: always use the dropdown form, even for a single choice
		const choices = this.opts.providerChoices
		if (choices && choices.length > 0) {
			const initialId = this.opts.initialProviderId && choices.includes(this.opts.initialProviderId)
				? this.opts.initialProviderId
				: choices[0]
			const first = PROVIDERS.find(p => p.id === initialId)
			if (first) { this.renderForm(first); return }
		}

		// Direct open from Providers section: jump straight to that provider's form
		if (this.opts.initialProviderId) {
			const spec = PROVIDERS.find(p => p.id === this.opts.initialProviderId)
			if (spec) { this.renderForm(spec); return }
		}

		this.renderPicker()
	}

	onClose() {
		this.contentEl.empty()
	}

	private renderPicker() {
		const { contentEl, titleEl } = this
		contentEl.empty()
		titleEl.setText('Add a provider')

		const searchEl = contentEl.createEl('input', {
			type: 'text',
			placeholder: 'Search providers…',
			cls: 'bragi-add-modal-search',
		})
		const listEl = contentEl.createDiv({ cls: 'bragi-add-modal-list' })

		const candidates = PROVIDERS
			.filter(p => !p.isConfigured(this.plugin.settings))
			.sort((a, b) => a.name.localeCompare(b.name))
		if (candidates.length === 0) {
			listEl.createEl('p', { text: 'All supported providers are already added.', cls: 'mod-muted' })
			return
		}

		const render = (query: string) => {
			listEl.empty()
			const q = query.trim().toLowerCase()
			const matches = candidates.filter(p => !q || p.name.toLowerCase().includes(q))
			if (matches.length === 0) {
				listEl.createEl('p', { text: 'No matches.', cls: 'mod-muted' })
				return
			}
			for (const spec of matches) {
				const row = listEl.createDiv({ cls: 'bragi-add-modal-row' })
				const info = row.createDiv({ cls: 'bragi-add-modal-row-info' })
				info.createDiv({ cls: 'bragi-add-modal-row-name', text: spec.name })
				info.createDiv({ cls: 'bragi-add-modal-row-desc', text: describeProviderModelSupport(spec.id) })
				const btn = row.createEl('button', { text: 'Add', cls: 'mod-cta' })
				btn.addEventListener('click', () => this.renderForm(spec, true))
			}
		}

		searchEl.addEventListener('input', () => render(searchEl.value))
		render('')
		window.setTimeout(() => searchEl.focus(), 0)
	}

	private renderForm(spec: ProviderSpec, fromPicker: boolean = false) {
		const { contentEl, titleEl } = this
		contentEl.empty()

		const choices = this.opts.providerChoices
		const showDropdown = !!(choices && choices.length > 0)

		// In dropdown mode: fixed title + short desc; in single-provider mode: per-provider title + desc + doc link
		if (showDropdown) {
			titleEl.setText('Connect a provider')
		} else {
			const verb = this.opts.onSubmitDraft || !spec.isConfigured(this.plugin.settings) ? 'Add' : 'Edit'
			titleEl.setText(`${verb} ${spec.name}`)
		}

		let currentSpec = spec
		const draft: ProviderCredentialDraft = {}

		const loadDraft = () => {
			for (const f of currentSpec.fields) {
				draft[f.key] = this.opts.initialDraftValues?.[f.key] ?? this.plugin.settings.providers[f.key] ?? ''
			}
		}
		loadDraft()

		// Description (rendered once; never changes when dropdown switches)
		if (showDropdown) {
			contentEl.createEl('p', {
				cls: 'setting-item-description bragi-add-provider-desc',
				text: 'Pick a provider that supports this model and add its credentials.',
			})
		} else {
			// Non-dropdown mode has no provider switcher, so currentSpec is fixed here.
			const p = contentEl.createEl('p', { cls: 'setting-item-description bragi-add-provider-desc' })
			p.appendText('Enter your credentials to connect. ')
			if (currentSpec.docUrl) {
				const link = p.createEl('a', { text: 'Get key →', href: currentSpec.docUrl, cls: 'bragi-add-modal-doclink' })
				link.addEventListener('click', (e) => {
					e.preventDefault()
					window.open(currentSpec.docUrl, '_blank')
				})
			}
		}

		const body = contentEl.createDiv({ cls: 'bragi-add-provider-form' })

		const renderBody = () => {
			body.empty()

			// Provider dropdown (if in select mode)
			if (showDropdown) {
				new Setting(body)
					.setName('Provider')
					.addDropdown(dd => {
						for (const id of choices) {
							const s = PROVIDERS.find(p => p.id === id)
							if (s) dd.addOption(id, s.name)
						}
						dd.setValue(currentSpec.id)
						dd.onChange(v => {
							const next = PROVIDERS.find(p => p.id === v)
							if (next) {
								currentSpec = next
								loadDraft()
								// re-render body to swap fields — title/desc stay fixed
								body.empty()
								renderBody()
							}
						})
					})
			}

			// Fields
			for (const f of currentSpec.fields) {
				const setting = new Setting(body).setName(f.label)
				if (f.type === 'select' && f.options) {
					setting.addDropdown(dd => {
						for (const opt of f.options!) dd.addOption(opt.value, opt.label)
						dd.setValue(draft[f.key] || f.options![0].value)
						dd.onChange(v => { draft[f.key] = v })
					})
				} else {
					setting.addText(t => {
						t.setPlaceholder(f.placeholder).setValue(draft[f.key] || '').onChange(v => { draft[f.key] = v })
						if (f.type === 'password') {
							t.inputEl.type = 'password'
							// Toggle-visibility eye button
							const control = t.inputEl.parentElement
							if (control) {
								const eye = control.createEl('button', { cls: 'clickable-icon bragi-eye-btn' })
								setIcon(eye, 'eye-off')
								setTooltip(eye, 'Show')
								eye.addEventListener('click', (e) => {
									e.preventDefault()
									const hidden = t.inputEl.type === 'password'
									t.inputEl.type = hidden ? 'text' : 'password'
									setIcon(eye, hidden ? 'eye' : 'eye-off')
									setTooltip(eye, hidden ? 'Hide' : 'Show')
								})
							}
						}
						t.inputEl.classList.add('bragi-full-width')
					})
				}
			}
		}

		renderBody()

		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' })
		const useBack = !!this.opts.onBack || fromPicker
		const cancel = btnRow.createEl('button', { text: useBack ? 'Back' : 'Cancel' })
		cancel.addEventListener('click', () => {
			if (fromPicker) {
				// Return to the picker inside the same modal
				this.renderPicker()
				return
			}
			const back = this.opts.onBack
			this.close()
			back?.()
		})

		// Test button (only if the spec supports it)
		if (currentSpec.testConnection) {
			const test = btnRow.createEl('button', { text: 'Test' })
			test.addEventListener('click', () => {
				void (async () => {
					// Use trimmed draft values
					const trimmed: ProviderCredentialDraft = {}
					for (const f of currentSpec.fields) trimmed[f.key] = (draft[f.key] || '').trim()
					test.disabled = true
					test.setText('Testing…')
					try {
						const res = await currentSpec.testConnection!(trimmed)
						if (res.ok) new Notice(`${currentSpec.name}: ${res.message}`)
						else new Notice(`${currentSpec.name}: ${res.message}`, 6000)
					} catch (err: unknown) {
						const message = err instanceof Error ? err.message : String(err)
						new Notice(`${currentSpec.name}: test failed — ${message}`, 6000)
					} finally {
						test.disabled = false
						test.setText('Test')
					}
				})()
			})
		}

		const submitLabel = this.opts.submitLabel || (this.opts.onSubmitDraft ? 'Select models' : 'Save')
		const save = btnRow.createEl('button', { text: submitLabel, cls: 'mod-cta' })
		save.addEventListener('click', () => {
			void (async () => {
				const trimmed: ProviderCredentialDraft = {}
				for (const f of currentSpec.fields) {
					trimmed[f.key] = (draft[f.key] || '').trim()
				}
				const fakeSettings = settingsWithProviderCredentialDraft(this.plugin.settings, currentSpec.id, trimmed)
				if (!currentSpec.isConfigured(fakeSettings)) {
					new Notice('Fill in every field first')
					return
				}
				const savedId = currentSpec.id
				this.close()
				if (this.opts.onSubmitDraft) {
					this.opts.onSubmitDraft(savedId, trimmed)
					return
				}
				for (const f of currentSpec.fields) {
					this.plugin.settings.providers[f.key] = trimmed[f.key] || ''
				}
				await this.plugin.saveSettings()
				new Notice(`${currentSpec.name} saved`)
				this.opts.onSaved?.(savedId)
			})()
		})
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment -- Resume strict linting after the runtime-shaped data boundary. */

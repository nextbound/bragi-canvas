import { Modal, Notice, setTooltip } from 'obsidian'
import type BragiCanvas from '../main'
import { ALL_MODELS, getActiveProvider, type ModelConfig, type GenerationType } from '../models'
import {
	applyProviderCredentialDraft,
	disableModel,
	enableModelWithProvider,
	getConnectedConfiguredProviderIds,
	isProviderConnectedToModel,
	type ProviderCredentialDraft,
} from '../provider-model-prefs'
import { getProvider, getConfiguredProviderIds } from '../providers/registry'
import { AddProviderModal } from './add-provider-modal'

type TypeFilter = 'all' | GenerationType

const TYPE_LABELS: Record<TypeFilter, string> = {
	all: 'All',
	image: 'Image',
	video: 'Video',
	text: 'Text',
	audio: 'Audio',
}

export class AddModelModal extends Modal {
	private typeFilter: TypeFilter
	private query: string = ''

	constructor(private plugin: BragiCanvas, private onChanged: () => void, initialType: GenerationType | 'all' = 'all') {
		super(plugin.app)
		this.typeFilter = initialType
	}

	onOpen() {
		const { titleEl, modalEl } = this
		titleEl.setText('Models')
		modalEl.classList.add('bragi-modal', 'bragi-add-model-modal')
		this.render()
	}

	onClose() {
		this.contentEl.empty()
	}

	private render() {
		const { contentEl } = this
		contentEl.empty()

		// ─── Search row: [Type ▾]  [search input] ─────────────────────
		const searchRow = contentEl.createDiv({ cls: 'bragi-add-model-search-row' })

		const typeSelect = searchRow.createEl('select', { cls: 'dropdown bragi-add-model-type-select' })
		for (const t of ['all', 'image', 'video', 'text', 'audio'] as TypeFilter[]) {
			const opt = typeSelect.createEl('option', { value: t, text: TYPE_LABELS[t] })
			if (t === this.typeFilter) opt.selected = true
		}
		typeSelect.addEventListener('change', () => {
			this.typeFilter = typeSelect.value as TypeFilter
			this.render()
		})

		const searchInput = searchRow.createEl('input', {
			type: 'text',
			placeholder: 'Search models…',
			cls: 'bragi-add-model-search',
		})
		searchInput.value = this.query
		searchInput.addEventListener('input', () => {
			this.query = searchInput.value
			this.updateList(list)
		})

		// ─── Model list ───────────────────────────────────────────────
		const list = contentEl.createDiv({ cls: 'bragi-add-model-list' })
		this.updateList(list)

		// Focus the search input (overrides the default dropdown focus)
		window.setTimeout(() => searchInput.focus(), 0)
	}

	private updateList(list: HTMLElement) {
		list.empty()
		const configured = new Set(getConfiguredProviderIds(this.plugin.settings))
		const q = this.query.trim().toLowerCase()

		const matches = ALL_MODELS.filter(m => {
			if (this.typeFilter !== 'all' && m.type !== this.typeFilter) return false
			if (q && !m.name.toLowerCase().includes(q) && !m.id.toLowerCase().includes(q)) return false
			return true
		})

		if (matches.length === 0) {
			list.createEl('p', { text: 'No matches.', cls: 'bragi-empty-hint' })
			return
		}

		// Partition: not-yet-added first, already-added after
		const notAdded: ModelConfig[] = []
		const added: ModelConfig[] = []
		for (const m of matches) {
			if (this.plugin.settings.modelPrefs[m.id]?.enabled) added.push(m)
			else notAdded.push(m)
		}

		for (const m of notAdded) this.renderCard(list, m, configured, false)

		if (added.length > 0 && notAdded.length > 0) {
			list.createDiv({ cls: 'bragi-add-model-section-label', text: 'Already added' })
		} else if (added.length > 0) {
			list.createDiv({ cls: 'bragi-add-model-section-label', text: 'Already added' })
		}
		for (const m of added) this.renderCard(list, m, configured, true)
	}

	private renderCard(list: HTMLElement, model: ModelConfig, configured: Set<string>, isAdded: boolean) {
		const card = list.createDiv({ cls: `bragi-add-model-card ${isAdded ? 'is-added' : ''}` })

		// Left column — name + type + provider badges (all badges are visual only, not clickable)
		const body = card.createDiv({ cls: 'bragi-add-model-card-body' })
		const header = body.createDiv({ cls: 'bragi-add-model-card-header' })
		header.createDiv({ cls: 'bragi-add-model-card-name', text: model.name })
		header.createDiv({ cls: 'bragi-add-model-card-type', text: model.type })

		const badges = body.createDiv({ cls: 'bragi-add-model-badges' })
		const supportedIds = Object.keys(model.supportedProviders)
		const currentPref = this.plugin.settings.modelPrefs[model.id]
		const connectedConfigured = new Set(getConnectedConfiguredProviderIds(this.plugin.settings, model))
		const activeProvider = currentPref?.enabled
			? getActiveProvider(model, currentPref.selectedProvider, [...connectedConfigured])
			: null

		// Sort: configured first, unconfigured after
		const sorted = [...supportedIds].sort((a, b) => {
			const score = (providerId: string) => {
				if (providerId === activeProvider) return 3
				if (connectedConfigured.has(providerId)) return 2
				if (configured.has(providerId)) return 1
				return 0
			}
			return score(b) - score(a)
		})

		for (const pid of sorted) {
			const spec = getProvider(pid)
			if (!spec) continue
			const isConfiguredP = configured.has(pid)
			const isConnected = isProviderConnectedToModel(this.plugin.settings, pid, model.id)
			const isActive = isAdded && activeProvider === pid

			const badge = badges.createSpan({
				cls: `bragi-add-model-badge ${isConfiguredP ? 'is-configured' : 'is-unconfigured'} ${isConnected ? 'is-connected' : ''} ${isActive ? 'is-active' : ''}`,
				text: spec.name,
			})

			if (isAdded) {
				if (isConfiguredP) {
					if (isActive) {
						setTooltip(badge, 'Active provider')
					} else if (isConnected) {
						// Click connected inactive badge -> switch active provider.
						setTooltip(badge, `Switch to ${spec.name}`)
						badge.addEventListener('click', () => {
							this.plugin.settings.modelPrefs[model.id] = { enabled: true, selectedProvider: pid }
							void this.plugin.saveSettings().then(() => {
								new Notice(`${model.name} → ${spec.name}`)
								this.onChanged()
								this.render()
							})
						})
					} else {
						// Click configured but unconnected badge -> connect provider, keep active provider.
						setTooltip(badge, `Connect ${spec.name}`)
						badge.addEventListener('click', () => {
							enableModelWithProvider(this.plugin.settings, model.id, pid, { preserveActiveProvider: !!activeProvider })
							void this.plugin.saveSettings().then(() => {
								new Notice(`${spec.name} connected to ${model.name}`)
								this.onChanged()
								this.render()
							})
						})
					}
				} else {
					// Click unconfigured badge -> collect credentials, then connect provider without changing active provider.
					setTooltip(badge, `Add ${spec.name}`)
					badge.addEventListener('click', () => {
						this.openProviderFormForModel(model, pid, true, !!activeProvider)
					})
				}
			} else if (isConfiguredP) {
				setTooltip(badge, `Add with ${spec.name}`)
				badge.addEventListener('click', () => {
					this.enableModel(model, pid, false)
				})
			} else {
				setTooltip(badge, `Add ${spec.name}`)
				badge.addEventListener('click', () => {
					this.openProviderFormForModel(model, pid, false, false)
				})
			}
		}

		// Right column — action button
		const actions = card.createDiv({ cls: 'bragi-add-model-card-actions' })
		if (isAdded) {
			const removeBtn = actions.createEl('button', { cls: 'bragi-add-model-remove', text: 'Remove' })
			setTooltip(removeBtn, 'Remove from list')
			removeBtn.addEventListener('click', () => {
				disableModel(this.plugin.settings, model.id)
				void this.plugin.saveSettings().then(() => {
					new Notice(`${model.name} removed`)
					this.onChanged()
					this.render()
				})
			})
		} else {
			const connectedSupported = supportedIds.filter(pid => connectedConfigured.has(pid))
			const configuredSupported = supportedIds.filter(pid => configured.has(pid))
			const addBtn = actions.createEl('button', { cls: 'mod-cta', text: 'Add' })
			addBtn.addEventListener('click', () => {
				const providerId = connectedSupported[0] || configuredSupported[0]
				if (providerId) {
					this.enableModel(model, providerId, false)
				} else {
					this.openProviderChoiceForModel(model, supportedIds)
				}
			})
		}
	}

	private enableModel(model: ModelConfig, providerId: string, preserveActiveProvider: boolean): void {
		enableModelWithProvider(this.plugin.settings, model.id, providerId, { preserveActiveProvider })
		void this.plugin.saveSettings().then(() => {
			new Notice(`${model.name} added`)
			this.onChanged()
			this.render()
		})
	}

	private openProviderChoiceForModel(model: ModelConfig, providerIds: string[]): void {
		this.close()
		const submit = (providerId: string, draft: ProviderCredentialDraft) => {
			this.commitProviderDraftForModel(model, providerId, draft, false)
		}
		new AddProviderModal(this.plugin, {
			providerChoices: providerIds,
			initialProviderId: providerIds[0],
			submitLabel: 'Add model',
			onBack: () => new AddModelModal(this.plugin, this.onChanged, this.typeFilter).open(),
			onSubmitDraft: submit,
		}).open()
	}

	private openProviderFormForModel(
		model: ModelConfig,
		providerId: string,
		preserveActiveProvider: boolean,
		hasActiveProvider: boolean,
	): void {
		this.close()
		const submit = (savedId: string, draft: ProviderCredentialDraft) => {
			this.commitProviderDraftForModel(model, savedId, draft, preserveActiveProvider && hasActiveProvider)
		}
		new AddProviderModal(this.plugin, {
			initialProviderId: providerId,
			submitLabel: preserveActiveProvider ? 'Connect provider' : 'Add model',
			onBack: () => new AddModelModal(this.plugin, this.onChanged, this.typeFilter).open(),
			onSubmitDraft: submit,
		}).open()
	}

	private commitProviderDraftForModel(
		model: ModelConfig,
		providerId: string,
		draft: ProviderCredentialDraft,
		preserveActiveProvider: boolean,
	): void {
		applyProviderCredentialDraft(this.plugin.settings, providerId, draft)
		enableModelWithProvider(this.plugin.settings, model.id, providerId, { preserveActiveProvider })
		void this.plugin.saveSettings().then(() => {
			const providerName = getProvider(providerId)?.name || providerId
			new Notice(preserveActiveProvider
				? `${providerName} connected to ${model.name}`
				: `${model.name} added`)
			this.onChanged()
			new AddModelModal(this.plugin, this.onChanged, this.typeFilter).open()
		})
	}
}

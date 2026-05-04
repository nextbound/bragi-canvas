import { App, Modal, Notice, setTooltip } from 'obsidian'
import type BragiCanvas from '../main'
import { ALL_MODELS, type ModelConfig, type GenerationType } from '../models'
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
		setTimeout(() => searchInput.focus(), 0)
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
			list.createEl('div', { cls: 'bragi-add-model-section-label', text: 'Already added' })
		} else if (added.length > 0) {
			list.createEl('div', { cls: 'bragi-add-model-section-label', text: 'Already added' })
		}
		for (const m of added) this.renderCard(list, m, configured, true)
	}

	private renderCard(list: HTMLElement, model: ModelConfig, configured: Set<string>, isAdded: boolean) {
		const card = list.createDiv({ cls: `bragi-add-model-card ${isAdded ? 'is-added' : ''}` })

		// Left column — name + type + provider badges (all badges are visual only, not clickable)
		const body = card.createDiv({ cls: 'bragi-add-model-card-body' })
		const header = body.createDiv({ cls: 'bragi-add-model-card-header' })
		header.createEl('div', { cls: 'bragi-add-model-card-name', text: model.name })
		header.createEl('div', { cls: 'bragi-add-model-card-type', text: model.type })

		const badges = body.createDiv({ cls: 'bragi-add-model-badges' })
		const supportedIds = Object.keys(model.supportedProviders)
		const currentPref = this.plugin.settings.modelPrefs[model.id]

		// Sort: configured first, unconfigured after
		const sorted = [...supportedIds].sort((a, b) => {
			const aC = configured.has(a) ? 1 : 0
			const bC = configured.has(b) ? 1 : 0
			return bC - aC
		})

		for (const pid of sorted) {
			const spec = getProvider(pid)
			if (!spec) continue
			const isConfiguredP = configured.has(pid)
			const isActive = isAdded && currentPref?.selectedProvider === pid

			const badge = badges.createEl('span', {
				cls: `bragi-add-model-badge ${isConfiguredP ? 'is-configured' : 'is-unconfigured'} ${isActive ? 'is-active' : ''}`,
				text: spec.name,
			})

			if (isAdded) {
				if (isConfiguredP) {
					// Click already-configured inactive badge → switch active provider
					if (!isActive) {
						setTooltip(badge, `Switch to ${spec.name}`)
						badge.addEventListener('click', () => {
							this.plugin.settings.modelPrefs[model.id] = { enabled: true, selectedProvider: pid }
							this.plugin.saveSettings().then(() => {
								new Notice(`${model.name} → ${spec.name}`)
								this.onChanged()
								this.render()
							})
						})
					}
				} else {
					// Click unconfigured badge → open Add Provider flow
					setTooltip(badge, `Add ${spec.name}`)
					badge.addEventListener('click', () => {
						this.close()
						new AddProviderModal(this.plugin, {
							initialProviderId: pid,
							onBack: () => new AddModelModal(this.plugin, this.onChanged, this.typeFilter).open(),
							onSaved: () => new AddModelModal(this.plugin, this.onChanged, this.typeFilter).open(),
						}).open()
					})
				}
			}
		}

		// Right column — action button
		const actions = card.createDiv({ cls: 'bragi-add-model-card-actions' })
		if (isAdded) {
			const removeBtn = actions.createEl('button', { cls: 'bragi-add-model-remove', text: 'Remove' })
			setTooltip(removeBtn, 'Remove from list')
			removeBtn.addEventListener('click', () => {
				const pref = this.plugin.settings.modelPrefs[model.id]
				this.plugin.settings.modelPrefs[model.id] = { enabled: false, selectedProvider: pref?.selectedProvider || '' }
				this.plugin.saveSettings().then(() => {
					new Notice(`${model.name} removed`)
					this.onChanged()
					this.render()
				})
			})
		} else {
			const configuredSupported = supportedIds.filter(pid => configured.has(pid))
			const addBtn = actions.createEl('button', { cls: 'mod-cta', text: 'Add' })
			addBtn.addEventListener('click', () => {
				if (configuredSupported.length > 0) {
					// Use first configured provider as the default
					this.plugin.settings.modelPrefs[model.id] = { enabled: true, selectedProvider: configuredSupported[0] }
					this.plugin.saveSettings().then(() => {
						new Notice(`${model.name} added`)
						this.onChanged()
						this.render()
					})
				} else {
					// Need to configure a provider first — open the provider form with a dropdown of compatible providers
					this.close()
					new AddProviderModal(this.plugin, {
						providerChoices: supportedIds,
						initialProviderId: supportedIds[0],
						onBack: () => {
							new AddModelModal(this.plugin, this.onChanged, this.typeFilter).open()
						},
						onSaved: (savedId) => {
							this.plugin.settings.modelPrefs[model.id] = { enabled: true, selectedProvider: savedId }
							this.plugin.saveSettings().then(() => {
								new Notice(`${model.name} added`)
								this.onChanged()
								new AddModelModal(this.plugin, this.onChanged, this.typeFilter).open()
							})
						},
					}).open()
				}
			})
		}
	}
}

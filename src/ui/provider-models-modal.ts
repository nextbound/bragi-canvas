import { Modal, Notice, setIcon, setTooltip } from 'obsidian'
import type BragiCanvas from '../main'
import { ALL_MODELS, getActiveProvider, type GenerationType, type ModelConfig } from '../models'
import {
	applyProviderCredentialDraft,
	disableModel,
	enableModelWithProvider,
	getConnectedConfiguredProviderIds,
	getReplacementProvider,
	isProviderConnectedToModel,
	resolveApiModelId,
	type ProviderCredentialDraft,
} from '../provider-model-prefs'
import { getProvider } from '../providers/registry'

const TYPE_ORDER: GenerationType[] = ['image', 'video', 'text', 'audio']
const TYPE_LABELS: Record<GenerationType, string> = {
	image: 'Image',
	video: 'Video',
	text: 'Text',
	audio: 'Audio',
}

type ProviderModelsMode = 'connect' | 'manage'

export interface ProviderModelsModalOptions {
	mode: ProviderModelsMode
	providerId: string
	draft?: ProviderCredentialDraft
	onBack?: () => void
	onDone?: () => void
}

type ActiveDisconnectImpact = {
	disappearing: ModelConfig[]
	switching: Array<{ model: ModelConfig; to: string }>
}

function modelCountText(count: number): string {
	return `${count} model${count === 1 ? '' : 's'}`
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
	if (a.size !== b.size) return false
	for (const item of a) {
		if (!b.has(item)) return false
	}
	return true
}

export class ProviderModelsModal extends Modal {
	private selected = new Set<string>()
	private initialSelected = new Set<string>()
	private checkboxEls = new Map<string, HTMLInputElement>()
	private syncSelectionUi: (() => void) | null = null

	constructor(private plugin: BragiCanvas, private opts: ProviderModelsModalOptions) {
		super(plugin.app)
	}

	onOpen() {
		this.modalEl.classList.add('bragi-modal', 'bragi-provider-models-modal')
		this.render()
	}

	onClose() {
		this.contentEl.empty()
		this.selected.clear()
		this.initialSelected.clear()
		this.checkboxEls.clear()
		this.syncSelectionUi = null
	}

	private getCandidates(): ModelConfig[] {
		return ALL_MODELS.filter(model => model.supportedProviders[this.opts.providerId])
	}

	private seedSelection(candidates: ModelConfig[]): void {
		this.selected.clear()
		this.initialSelected.clear()

		for (const model of candidates) {
			const enabled = this.plugin.settings.modelPrefs[model.id]?.enabled === true
			const connected = enabled && isProviderConnectedToModel(this.plugin.settings, this.opts.providerId, model.id)

			if (this.opts.mode === 'connect') {
				if (enabled) this.selected.add(model.id)
				continue
			}

			if (connected) {
				this.selected.add(model.id)
				this.initialSelected.add(model.id)
			}
		}
	}

	private render() {
		const { contentEl, titleEl } = this
		const provider = getProvider(this.opts.providerId)
		const providerName = provider?.name || this.opts.providerId
		const candidates = this.getCandidates()
		this.seedSelection(candidates)

		titleEl.setText(this.opts.mode === 'connect'
			? `Select ${providerName} models`
			: `Manage ${providerName} models`)
		contentEl.empty()

		if (candidates.length === 0) {
			contentEl.createEl('p', {
				text: 'This provider does not support any catalog models yet.',
				cls: 'bragi-empty-hint',
			})
			const row = contentEl.createDiv({ cls: 'modal-button-container' })
			const close = row.createEl('button', { text: 'Close' })
			close.addEventListener('click', () => this.close())
			return
		}

		contentEl.createEl('p', {
			cls: 'setting-item-description bragi-provider-models-desc',
			text: this.opts.mode === 'connect'
				? 'Choose the models this provider should connect to. Existing enabled models are preselected and keep their current active provider.'
				: 'Choose which supported models are enabled in your model list and connected to this provider.',
		})

		const toolbar = contentEl.createDiv({ cls: 'bragi-provider-models-toolbar' })
		const selectAll = toolbar.createEl('button', { text: 'Select all', attr: { type: 'button' } })
		const clear = toolbar.createEl('button', { text: 'Clear', attr: { type: 'button' } })

		const list = contentEl.createDiv({ cls: 'bragi-provider-models-list' })
		for (const type of TYPE_ORDER) {
			const models = candidates.filter(model => model.type === type)
			if (models.length === 0) continue

			const group = list.createDiv({ cls: 'bragi-provider-models-group' })
			group.createDiv({ cls: 'bragi-provider-models-group-label', text: TYPE_LABELS[type] })
			for (const model of models) {
				this.renderModelRow(group, model)
			}
		}

		const row = contentEl.createDiv({ cls: 'modal-button-container' })
		if (this.opts.mode === 'connect' && this.opts.onBack) {
			const back = row.createEl('button', { text: 'Back' })
			back.addEventListener('click', () => {
				const onBack = this.opts.onBack
				this.close()
				onBack?.()
			})
		}
		const cancel = row.createEl('button', { text: 'Cancel' })
		cancel.addEventListener('click', () => this.close())

		const apply = row.createEl('button', {
			text: this.opts.mode === 'connect' ? 'Connect provider' : 'Apply',
			cls: 'mod-cta',
		})

		const sync = () => {
			for (const [modelId, checkbox] of this.checkboxEls) {
				checkbox.checked = this.selected.has(modelId)
			}
			const count = this.selected.size
			if (this.opts.mode === 'connect') {
				apply.disabled = count === 0
				apply.setText(count > 0 ? `Connect provider (${count})` : 'Connect provider')
			} else {
				apply.disabled = sameSet(this.selected, this.initialSelected)
				apply.setText('Apply')
			}
		}
		this.syncSelectionUi = sync

		selectAll.addEventListener('click', () => {
			this.selected = new Set(candidates.map(model => model.id))
			sync()
		})
		clear.addEventListener('click', () => {
			this.selected.clear()
			sync()
		})
		apply.addEventListener('click', () => {
			void this.requestApply(candidates)
		})
		sync()

		// Don't leave focus on "Select all" (it would show a focus ring as if pre-selected).
		window.setTimeout(() => {
			const active = this.contentEl.ownerDocument.activeElement
			if (active instanceof HTMLElement && this.contentEl.contains(active)) active.blur()
		}, 0)
	}

	private renderModelRow(parent: HTMLElement, model: ModelConfig) {
		const row = parent.createEl('label', { cls: 'bragi-provider-models-row' })
		const checkbox = row.createEl('input', { type: 'checkbox' })
		checkbox.addEventListener('change', () => {
			if (checkbox.checked) this.selected.add(model.id)
			else this.selected.delete(model.id)
			this.syncSelectionUi?.()
		})
		this.checkboxEls.set(model.id, checkbox)

		const info = row.createDiv({ cls: 'bragi-provider-models-info' })
		info.createDiv({ cls: 'bragi-provider-models-name', text: model.name })
		const idLine = info.createDiv({ cls: 'bragi-provider-models-id-line' })
		this.renderIdDisplay(idLine, model)
	}

	private catalogApiModelId(model: ModelConfig): string {
		return model.supportedProviders[this.opts.providerId]?.apiModelId || model.id
	}

	private isOverridden(model: ModelConfig): boolean {
		return !!this.plugin.settings.apiModelIdOverrides?.[this.opts.providerId]?.[model.id]
	}

	/** Whether the API model id is user-editable for this provider×model. */
	private isApiModelIdEditable(model: ModelConfig): boolean {
		const cfg = model.supportedProviders[this.opts.providerId]
		// Aggregated models route modes to multiple upstream ids internally; a single
		// editable id is meaningless and could corrupt routing, so it's always locked.
		if (!cfg || cfg.aggregated) return false
		return cfg.editableApiModelId === true
	}

	/** Display mode: effective api model id + (when editable) "Modified" badge + a pencil to edit. */
	private renderIdDisplay(idLine: HTMLElement, model: ModelConfig) {
		idLine.empty()
		const effective = resolveApiModelId(this.plugin.settings, this.opts.providerId, model)
		idLine.createSpan({ cls: 'bragi-provider-models-id', text: effective })

		// Locked id: static label only, no badge/pencil.
		if (!this.isApiModelIdEditable(model)) return

		if (this.isOverridden(model)) {
			idLine.createSpan({ cls: 'bragi-model-id-badge', text: 'Modified' })
		}
		const edit = idLine.createEl('button', { cls: 'clickable-icon bragi-model-id-edit-btn' })
		setIcon(edit, 'pencil')
		setTooltip(edit, 'Edit API model id')
		// The row is a <label>; stop the click from toggling the checkbox.
		edit.addEventListener('click', (e) => {
			e.preventDefault()
			e.stopPropagation()
			this.renderIdEditor(idLine, model)
		})
	}

	/** Edit mode: text input + save/cancel, plus reset-to-default when overridden. */
	private renderIdEditor(idLine: HTMLElement, model: ModelConfig) {
		idLine.empty()
		const effective = resolveApiModelId(this.plugin.settings, this.opts.providerId, model)
		const input = idLine.createEl('input', {
			type: 'text',
			cls: 'bragi-provider-models-id-input',
			value: effective,
		})
		input.placeholder = this.catalogApiModelId(model)
		// Clicks/keys inside the editor must not toggle the row's checkbox.
		const swallow = (e: Event) => e.stopPropagation()
		idLine.addEventListener('click', (e) => e.preventDefault())
		input.addEventListener('click', swallow)

		const save = idLine.createEl('button', { cls: 'clickable-icon' })
		setIcon(save, 'check')
		setTooltip(save, 'Save')
		const cancel = idLine.createEl('button', { cls: 'clickable-icon' })
		setIcon(cancel, 'x')
		setTooltip(cancel, 'Cancel')

		const commit = () => { void this.saveOverride(model, input.value); this.renderIdDisplay(idLine, model) }
		save.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); commit() })
		cancel.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this.renderIdDisplay(idLine, model) })
		input.addEventListener('keydown', (e) => {
			e.stopPropagation()
			if (e.key === 'Enter') { e.preventDefault(); commit() }
			else if (e.key === 'Escape') { e.preventDefault(); this.renderIdDisplay(idLine, model) }
		})

		if (this.isOverridden(model)) {
			const reset = idLine.createEl('button', { cls: 'clickable-icon' })
			setIcon(reset, 'rotate-ccw')
			setTooltip(reset, 'Reset to default')
			reset.addEventListener('click', (e) => {
				e.preventDefault()
				e.stopPropagation()
				void this.saveOverride(model, '')
				this.renderIdDisplay(idLine, model)
			})
		}

		input.focus()
		input.select()
	}

	/** Persist (or clear, when empty / equal to catalog default) the api model id override. */
	private async saveOverride(model: ModelConfig, rawValue: string): Promise<void> {
		const value = rawValue.trim()
		const providerId = this.opts.providerId
		const overrides = this.plugin.settings.apiModelIdOverrides || (this.plugin.settings.apiModelIdOverrides = {})
		const isDefault = !value || value === this.catalogApiModelId(model)

		if (isDefault) {
			const map = overrides[providerId]
			if (map) {
				delete map[model.id]
				if (Object.keys(map).length === 0) delete overrides[providerId]
			}
		} else {
			if (!overrides[providerId]) overrides[providerId] = {}
			overrides[providerId][model.id] = value
		}
		await this.plugin.saveSettings()
	}

	private computeActiveDisconnectImpact(candidates: ModelConfig[]): ActiveDisconnectImpact {
		const impact: ActiveDisconnectImpact = { disappearing: [], switching: [] }
		if (this.opts.mode !== 'manage') return impact

		for (const model of candidates) {
			if (!this.initialSelected.has(model.id) || this.selected.has(model.id)) continue
			const pref = this.plugin.settings.modelPrefs[model.id]
			if (pref?.enabled !== true) continue

			const connected = getConnectedConfiguredProviderIds(this.plugin.settings, model)
			const active = getActiveProvider(model, pref.selectedProvider, connected)
			if (active !== this.opts.providerId) continue

			const replacement = connected.find(providerId => providerId !== this.opts.providerId)
			if (replacement) impact.switching.push({ model, to: replacement })
			else impact.disappearing.push(model)
		}

		return impact
	}

	private async requestApply(candidates: ModelConfig[]): Promise<void> {
		const impact = this.computeActiveDisconnectImpact(candidates)
		if (impact.disappearing.length > 0 || impact.switching.length > 0) {
			new ProviderModelDisconnectConfirmModal(this.plugin, this.opts.providerId, impact, () => {
				void this.applyChanges(candidates)
			}).open()
			return
		}
		await this.applyChanges(candidates)
	}

	private async applyChanges(candidates: ModelConfig[]): Promise<void> {
		const selectedIds = new Set(this.selected)
		let connectedCount = 0

		if (this.opts.mode === 'connect' && this.opts.draft) {
			applyProviderCredentialDraft(this.plugin.settings, this.opts.providerId, this.opts.draft)
		}

		for (const model of candidates) {
			const checked = selectedIds.has(model.id)
			const wasChecked = this.initialSelected.has(model.id)
			const pref = this.plugin.settings.modelPrefs[model.id]

			if (checked) {
				const wasEnabled = pref?.enabled === true
				const currentActive = wasEnabled
					? getActiveProvider(model, pref?.selectedProvider, getConnectedConfiguredProviderIds(this.plugin.settings, model))
					: null
				if (enableModelWithProvider(this.plugin.settings, model.id, this.opts.providerId, { preserveActiveProvider: !!currentActive })) {
					connectedCount++
				}
				continue
			}

			if (!wasChecked) continue

			const connected = getConnectedConfiguredProviderIds(this.plugin.settings, model)
			const active = getActiveProvider(model, pref?.selectedProvider, connected)
			const replacement = active === this.opts.providerId
				? getReplacementProvider(this.plugin.settings, model, this.opts.providerId)
				: null

			if (active === this.opts.providerId && replacement) {
				this.plugin.settings.modelPrefs[model.id] = {
					enabled: true,
					selectedProvider: replacement,
				}
			} else if (active === this.opts.providerId) {
				disableModel(this.plugin.settings, model.id)
			}

			const providerPrefs = this.plugin.settings.providerModelPrefs?.[this.opts.providerId]
			if (providerPrefs) {
				delete providerPrefs[model.id]
				if (Object.keys(providerPrefs).length === 0) delete this.plugin.settings.providerModelPrefs[this.opts.providerId]
			}
		}

		await this.plugin.saveSettings()
		if (this.opts.mode === 'connect') {
			const providerName = getProvider(this.opts.providerId)?.name || this.opts.providerId
			new Notice(`${providerName} connected with ${modelCountText(connectedCount)}`)
		} else {
			new Notice('Provider models updated')
		}
		this.close()
		this.opts.onDone?.()
	}
}

class ProviderModelDisconnectConfirmModal extends Modal {
	constructor(
		private plugin: BragiCanvas,
		private providerId: string,
		private impact: ActiveDisconnectImpact,
		private onConfirm: () => void,
	) {
		super(plugin.app)
	}

	onOpen() {
		const { contentEl, titleEl, modalEl } = this
		const providerName = getProvider(this.providerId)?.name || this.providerId
		modalEl.classList.add('bragi-modal')
		titleEl.setText(`Update ${providerName} models?`)

		if (this.impact.switching.length > 0) {
			contentEl.createEl('p', {
				text: 'These models use this provider now. They will keep working by switching to another connected provider:',
			})
			const ul = contentEl.createEl('ul')
			for (const item of this.impact.switching) {
				const toName = getProvider(item.to)?.name || item.to
				ul.createEl('li', { text: `${item.model.name} -> ${toName}` })
			}
		}

		if (this.impact.disappearing.length > 0) {
			contentEl.createEl('p', {
				text: 'These models use this provider now and have no other connected provider, so they will disappear from the model list:',
				cls: 'mod-warning',
			})
			const ul = contentEl.createEl('ul')
			for (const model of this.impact.disappearing) {
				ul.createEl('li', { text: model.name })
			}
		}

		const row = contentEl.createDiv({ cls: 'modal-button-container' })
		const cancel = row.createEl('button', { text: 'Cancel' })
		cancel.addEventListener('click', () => this.close())
		const confirm = row.createEl('button', { text: 'Apply changes', cls: 'mod-cta' })
		confirm.addEventListener('click', () => {
			this.close()
			this.onConfirm()
		})
	}

	onClose() {
		this.contentEl.empty()
	}
}

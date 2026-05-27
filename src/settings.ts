/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import { App, Modal, Notice, PluginSettingTab, Setting } from 'obsidian'
import type BragiCanvas from './main'
import { getActiveProvider, getEnabledModels } from './models/index'
import type { GenerationType } from './models/types'
import { disableModel, getConnectedConfiguredProviderIds, type ProviderCredentialDraft } from './provider-model-prefs'
import { PROVIDERS } from './providers/registry'
import { AddProviderModal } from './ui/add-provider-modal'
import { AddModelModal } from './ui/add-model-modal'
import { ProviderModelsModal } from './ui/provider-models-modal'
import { removeProvider } from './ui/remove-provider-modal'
import { migrateSettings } from './settings-migrations'

/** Legacy map kept because `renderModelGroup` looks up display names by id. */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = (() => {
	const map: Record<string, string> = {}
	for (const spec of PROVIDERS) map[spec.id] = spec.name
	return map
})()

function autoSizeSelect(select: HTMLSelectElement): void {
	const measure = createSpan({ cls: 'bragi-select-measure' })
	select.classList.add('is-auto-sized')
	select.parentElement?.appendChild(measure)
	const update = () => {
		const text = select.options[select.selectedIndex]?.text || ''
		measure.textContent = text
		select.setCssProps({ '--bragi-select-width': `${measure.offsetWidth + 26}px` })
	}
	select.addEventListener('change', update)
	window.requestAnimationFrame(update)
}

function addSettingHeading(
	containerEl: HTMLElement,
	name: string,
	action?: { icon: string; tooltip: string; onClick: () => void },
): void {
	const setting = new Setting(containerEl).setName(name).setHeading()
	if (action) {
		setting.addExtraButton(btn => btn
			.setIcon(action.icon)
			.setTooltip(action.tooltip)
			.onClick(action.onClick))
	}
}

function addEmptySetting(containerEl: HTMLElement, text: string): void {
	const setting = new Setting(containerEl).setName(text)
	setting.settingEl.addClass('bragi-empty-setting')
}

export interface LastSelection {
	modelId?: string
	params?: Record<string, string | number>
	batchCount?: number
}

export interface ModelPref {
	enabled: boolean
	selectedProvider: string
}

export interface GeneratedAssetRecord {
	path: string
	canvasPath: string
	createdAt: number
}

export interface BragiSettings {
	settingsSchemaVersion: number
	outputDir: string
	/** Set to true once the user has been prompted about the legacy ss/ → _bragi/assets/ migration. */
	migrationPrompted: boolean
	/** Set to true once the 1.9.0 provider-prefs migration ran. */
	migrationProviders_1_9: boolean

	// Provider keys
	providers: {
		openai: string
		gemini: string
		anthropic: string
		bedrockAccessKeyId: string
		bedrockSecretAccessKey: string
		bedrockRegion: string
		bytedance: string
		byteplus: string
		byteplusAccessKey: string
		byteplusSecretKey: string
		byteplusProjectName: string
		klingAk: string
		klingSk: string
		fal: string
		minimax: string
		elevenlabs: string
		legnext: string
		tokenrouter: string
		apimart: string
		lumaToken: string
		xai: string
		dashscope: string
	}

	// Per-model preferences
	modelPrefs: Record<string, ModelPref>
	providerModelPrefs: Record<string, Record<string, boolean>>

	// Model display order per type
	modelOrder: {
		image: string[]
		video: string[]
		text: string[]
		audio: string[]
	}

	// Last selection memory
	lastImage?: LastSelection
	lastVideo?: LastSelection
	lastAudio?: LastSelection
	lastText?: LastSelection

	// Community-review-safe indexes. These replace whole-vault enumeration for
	// MCP canvas listing and generated asset cleanup.
	knownCanvases: string[]
	generatedAssets: GeneratedAssetRecord[]

	// MCP server
	mcpEnabled: boolean
	mcpPort: number
	mcpToken: string   // optional; when non-empty, all requests require Authorization: Bearer <token>

}

export const DEFAULT_SETTINGS: BragiSettings = {
	settingsSchemaVersion: 0,
	outputDir: 'assets',
	migrationPrompted: false,
	migrationProviders_1_9: false,
	providers: {
		openai: '',
		gemini: '',
		anthropic: '',
		bedrockAccessKeyId: '',
		bedrockSecretAccessKey: '',
		bedrockRegion: 'us-east-1',
		bytedance: '',
		byteplus: '',
		byteplusAccessKey: '',
		byteplusSecretKey: '',
		byteplusProjectName: 'default',
		klingAk: '',
		klingSk: '',
		fal: '',
		minimax: '',
		elevenlabs: '',
		legnext: '',
		tokenrouter: '',
		apimart: '',
		lumaToken: '',
		xai: '',
		dashscope: '',
	},
	modelPrefs: {},
	providerModelPrefs: {},
	modelOrder: {
		image: [],
		video: [],
		text: [],
		audio: [],
	},
	mcpEnabled: false,
	mcpPort: 17775,
	mcpToken: '',
	knownCanvases: [],
	generatedAssets: [],
}

export class BragiSettingTab extends PluginSettingTab {
	plugin: BragiCanvas

	constructor(app: App, plugin: BragiCanvas) {
		super(app, plugin)
		this.plugin = plugin
	}

	display(): void {
		const { containerEl } = this
		containerEl.empty()
		containerEl.classList.add('bragi-settings')

		addSettingHeading(containerEl, 'Bragi Canvas')

		// ── General ──
		addSettingHeading(containerEl, 'General')

		new Setting(containerEl)
			.setName('Clean up unused files')
			.setDesc('Delete bragi-generated files that are indexed for the active canvas but no longer used there')
			.addButton(btn => btn
				.setButtonText('Clean up')
				.onClick(() => {
					void this.cleanUpUnusedAssets()
				}))

		const importInput = containerEl.createEl('input', {
			type: 'file',
			cls: 'bragi-hidden',
		})
		importInput.accept = '.json,application/json'
		importInput.addEventListener('change', () => {
			const file = importInput.files?.[0]
			importInput.value = ''
			if (!file) return
			void this.handleSettingsImportFile(file)
		})

		new Setting(containerEl)
			.setName('Import settings')
			.setDesc('Choose a data.json file. If it looks valid, you can replace your current settings.')
			.addButton(btn => btn
				.setButtonText('Choose file')
				.onClick(() => importInput.click()))

		this.renderCloudStorageSection(containerEl)

		// ── MCP server ──
		addSettingHeading(containerEl, 'Mcp server')

		new Setting(containerEl)
			.setName('Enable mcp server')
			.setDesc('Allow clients to control canvas operations through the mcp protocol')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.mcpEnabled)
				.onChange((v) => {
					void (async () => {
						this.plugin.settings.mcpEnabled = v
						await this.plugin.saveSettings()
						if (v) this.plugin.startMcpServer()
						else this.plugin.stopMcpServer()
					})()
				}))

		new Setting(containerEl)
			.setName('Mcp port')
			.setDesc('Localhost port for mcp server (requires restart)')
			.addText(text => text
				.setValue(String(this.plugin.settings.mcpPort))
				.onChange((v) => {
					void (async () => {
						const port = parseInt(v, 10)
						if (!isNaN(port) && port > 0 && port < 65536) {
							this.plugin.settings.mcpPort = port
							await this.plugin.saveSettings()
						}
					})()
				}))

		new Setting(containerEl)
			.setName('Mcp access token')
			.setDesc('Optional. When set, clients must send "Authorization: Bearer <token>" on every request. Leave blank for open localhost access.')
			.addText(text => {
				text.inputEl.type = 'password'
				text.setPlaceholder('Leave blank to disable auth')
					.setValue(this.plugin.settings.mcpToken)
					.onChange((v) => {
						void (async () => {
							this.plugin.settings.mcpToken = v.trim()
							await this.plugin.saveSettings()
						})()
					})
		})

		// ── Providers ──
		this.renderProvidersSection(containerEl)

		// ── Models ──
		addSettingHeading(containerEl, 'Models')
		this.renderModelGroup(containerEl, 'Image Models', 'image')
		this.renderModelGroup(containerEl, 'Video Models', 'video')
		this.renderModelGroup(containerEl, 'Text Models', 'text')
		this.renderModelGroup(containerEl, 'Audio Models', 'audio')
	}

	private renderCloudStorageSection(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName('Temporary cloud')
			.setDesc('Briefly hosts your files so model apis can fetch them. Auto-deleted after 24h.')
			.addDropdown(dd => {
				dd.addOption('bragi', 'Bragi')
				dd.setValue('bragi')
				dd.setDisabled(true)
			})
			.addButton(btn => btn
				.setButtonText('Test')
				.onClick(() => {
					void (async () => {
						btn.setDisabled(true).setButtonText('Testing…')
						try {
							const { testBragiRelay, BUILTIN_BRAGI_RELAY } = await import('./providers/bragi-relay')
							const result = await testBragiRelay(BUILTIN_BRAGI_RELAY)
							if (result.ok) new Notice('Cloud storage works')
							else new Notice(`Test failed: ${result.error}`)
						} finally {
							btn.setDisabled(false).setButtonText('Test')
						}
					})()
				}))
	}

	private renderProvidersSection(containerEl: HTMLElement): void {
		const openProviderModelsForDraft = (providerId: string, draft: ProviderCredentialDraft) => {
			new ProviderModelsModal(this.plugin, {
				mode: 'connect',
				providerId,
				draft,
				onBack: () => {
					new AddProviderModal(this.plugin, {
						initialProviderId: providerId,
						initialDraftValues: draft,
						onSubmitDraft: openProviderModelsForDraft,
						submitLabel: 'Select models',
					}).open()
				},
				onDone: () => this.display(),
			}).open()
		}

		const openAddProvider = () => {
			new AddProviderModal(this.plugin, {
				onSubmitDraft: openProviderModelsForDraft,
				submitLabel: 'Select models',
			}).open()
		}

		const groupEl = containerEl.createDiv({ cls: 'setting-group bragi-settings-section bragi-providers-section' })
		addSettingHeading(groupEl, 'Providers', {
			icon: 'plus',
			tooltip: 'Add provider',
			onClick: openAddProvider,
		})

		const wrap = groupEl.createDiv({ cls: 'setting-items bragi-providers-list' })
		const configured = PROVIDERS.filter(p => p.isConfigured(this.plugin.settings))

		if (configured.length === 0) {
			addEmptySetting(wrap, 'No providers have been added. Click + to connect one.')
			return
		}

		for (const spec of configured) {
			const row = new Setting(wrap)
				.setName(spec.name)
				.setDesc(spec.description || '')
				.addExtraButton(btn => btn
					.setIcon('list-checks')
					.setTooltip('Manage models')
					.onClick(() => {
						new ProviderModelsModal(this.plugin, {
							mode: 'manage',
							providerId: spec.id,
							onDone: () => this.display(),
						}).open()
					}))
				.addExtraButton(btn => btn
					.setIcon('pencil')
					.setTooltip('Edit')
					.onClick(() => {
						new AddProviderModal(this.plugin, {
							initialProviderId: spec.id,
							onSaved: () => this.display(),
						}).open()
					}))
				.addExtraButton(btn => btn
					.setIcon('x')
					.setTooltip('Remove')
					.onClick(() => {
						removeProvider(this.plugin, spec.id, () => this.display())
					}))
			row.settingEl.addClass('bragi-provider-row')
		}
	}

	private async handleSettingsImportFile(file: File): Promise<void> {
		if (!file.name.toLowerCase().endsWith('.json')) {
			this.showImportFailedModal()
			return
		}

		let parsed: unknown
		try {
			parsed = JSON.parse(await file.text())
		} catch {
			this.showImportFailedModal()
			return
		}

		const result = migrateSettings(parsed, DEFAULT_SETTINGS, { requireRecognizable: true, strict: true })
		if (!result.valid) {
			this.showImportFailedModal()
			return
		}

		this.showImportConfirmModal(file.name, result.settings)
	}

	private showImportFailedModal(): void {
		const modal = new Modal(this.app)
		modal.modalEl.classList.add('bragi-modal')
		modal.titleEl.setText('Can\'t import this file')
		modal.contentEl.createEl('p', {
			text: 'This does not look like a settings file. Please choose data.json from a plugin folder.',
		})
		modal.contentEl.createEl('p', {
			text: 'No settings were changed.',
			cls: 'mod-muted',
		})

		const row = modal.contentEl.createDiv({ cls: 'modal-button-container' })
		const closeBtn = row.createEl('button', { text: 'Close' })
		closeBtn.addEventListener('click', () => modal.close())
		modal.open()
	}

	private showImportConfirmModal(fileName: string, importedSettings: BragiSettings): void {
		const modal = new Modal(this.app)
		modal.modalEl.classList.add('bragi-modal')
		modal.titleEl.setText('Import settings?')
		modal.contentEl.createEl('p', {
			text: `The file "${fileName}" looks OK.`,
		})
		modal.contentEl.createEl('p', {
			text: 'This will replace your current settings, including providers, model list, model order, and local server options.',
		})
		modal.contentEl.createEl('p', {
			text: 'This can\'t be undone. Only import a file from someone you trust because it can include API keys.',
			cls: 'mod-warning',
		})

		const row = modal.contentEl.createDiv({ cls: 'modal-button-container' })
		const cancelBtn = row.createEl('button', { text: 'Cancel' })
		cancelBtn.addEventListener('click', () => modal.close())

		const importBtn = row.createEl('button', { text: 'Import settings', cls: 'mod-destructive' })
		importBtn.classList.add('bragi-danger-button')
		importBtn.addEventListener('click', () => {
			void (async () => {
				const previousSettings = this.plugin.settings
				try {
					this.plugin.settings = importedSettings
					await this.plugin.saveSettings()
					this.plugin.stopMcpServer()
					if (this.plugin.settings.mcpEnabled) this.plugin.startMcpServer()
					modal.close()
					this.display()
					new Notice('Settings imported')
				} catch (err) {
					this.plugin.settings = previousSettings
					console.error('Bragi Canvas: settings import failed', err)
					new Notice('Import failed. No settings were changed.')
				}
			})()
		})

		modal.open()
	}

	private renderModelGroup(containerEl: HTMLElement, title: string, type: GenerationType): void {
		const groupEl = containerEl.createDiv({ cls: 'setting-group bragi-settings-section bragi-model-group' })
		addSettingHeading(groupEl, title, {
			icon: 'plus',
			tooltip: `Add ${type} model`,
			onClick: () => {
				new AddModelModal(this.plugin, () => this.display(), type).open()
			},
		})

		// Only show models the user explicitly enabled and that still have a connected provider.
		const enabledModels = getEnabledModels(
			type,
			this.plugin.settings.modelOrder[type],
			this.plugin.settings.modelPrefs,
			model => getConnectedConfiguredProviderIds(this.plugin.settings, model),
		)

		// Apply saved order
		const orderKey = type
		const savedOrder = this.plugin.settings.modelOrder[orderKey] || []
		let ordered = [...enabledModels]
		if (savedOrder.length > 0) {
			ordered = []
			for (const id of savedOrder) {
				const m = enabledModels.find(m => m.id === id)
				if (m) ordered.push(m)
			}
			for (const m of enabledModels) {
				if (!ordered.includes(m)) ordered.push(m)
			}
		}

		const listEl = groupEl.createDiv({ cls: 'setting-items bragi-model-list' })

		if (ordered.length === 0) {
			addEmptySetting(listEl, `No ${type} models have been added. Click + to add one.`)
			return
		}

		for (const model of ordered) {
			const pref = this.plugin.settings.modelPrefs[model.id]
			const usable = getConnectedConfiguredProviderIds(this.plugin.settings, model)
			const activeProvider = getActiveProvider(model, pref.selectedProvider, usable)

			const providerCountText = `${usable.length} provider${usable.length === 1 ? '' : 's'}`
			const setting = new Setting(listEl)
				.setName(model.name)
				.setDesc(`Available in ${providerCountText}`)
			const row = setting.settingEl
			row.addClass('bragi-model-row')

			// Drag handle
			const handle = createSpan({ cls: 'bragi-drag-handle', text: '⠿' })
			handle.setAttribute('draggable', 'true')
			setting.infoEl.prepend(handle)
			setting.nameEl.addClass('bragi-model-name')

			// Provider selector — only list providers explicitly connected to this model.
			const providerSelect = setting.controlEl.createEl('select', { cls: 'dropdown bragi-model-provider' })

			if (usable.length === 0) {
				const opt = providerSelect.createEl('option', { value: '', text: 'No provider configured' })
				opt.disabled = true
				providerSelect.disabled = true
			} else {
				for (const pName of usable) {
					const opt = providerSelect.createEl('option', { value: pName })
					opt.textContent = PROVIDER_DISPLAY_NAMES[pName] || pName
				}
				providerSelect.value = activeProvider || usable[0]
			}

			autoSizeSelect(providerSelect)
			providerSelect.addEventListener('change', () => {
				void (async () => {
					this.plugin.settings.modelPrefs[model.id] = {
						enabled: true,
						selectedProvider: providerSelect.value,
					}
					await this.plugin.saveSettings()
				})()
			})

			// Remove button (× — disables the model and clears provider connections)
			setting.addExtraButton(btn => {
				btn.extraSettingsEl.addClass('bragi-model-remove')
				btn.setIcon('x')
					.setTooltip('Remove from list')
					.onClick(() => {
						void (async () => {
							disableModel(this.plugin.settings, model.id)
							await this.plugin.saveSettings()
							this.display()
						})()
					})
			})

			// Drag and drop reordering
			handle.addEventListener('dragstart', (e) => {
				e.dataTransfer?.setData('text/plain', model.id)
				row.classList.add('is-dragging')
			})
			handle.addEventListener('dragend', () => {
				row.classList.remove('is-dragging')
			})
			row.addEventListener('dragover', (e) => {
				e.preventDefault()
				row.classList.add('drag-over')
			})
			row.addEventListener('dragleave', () => {
				row.classList.remove('drag-over')
			})
			row.addEventListener('drop', (e) => {
				e.preventDefault()
				row.classList.remove('drag-over')
				const draggedId = e.dataTransfer?.getData('text/plain')
				if (!draggedId || draggedId === model.id) return

				const currentOrder = ordered.map(m => m.id)
				const fromIdx = currentOrder.indexOf(draggedId)
				const toIdx = currentOrder.indexOf(model.id)
				if (fromIdx === -1 || toIdx === -1) return

				currentOrder.splice(fromIdx, 1)
				currentOrder.splice(toIdx, 0, draggedId)

				this.plugin.settings.modelOrder[orderKey] = currentOrder
				void (async () => {
					await this.plugin.saveSettings()
					this.display()
				})()
			})
		}
	}

	/** Delete indexed files in _bragi/assets/ that are no longer referenced by the active canvas. */
	private async cleanUpUnusedAssets(): Promise<void> {
		const canvas = this.plugin.getActiveCanvas()
		const canvasPath = this.plugin.getActiveCanvasPath()
		if (!canvas || !canvasPath) {
			new Notice('Open a canvas first')
			return
		}

		const adapter = this.app.vault.adapter
		const assetDir = '_bragi/assets'

		if (!await adapter.exists(assetDir)) {
			new Notice('No generated files yet — nothing to clean')
			return
		}

		const referenced = new Set<string>()
		for (const node of canvas.getData().nodes || []) {
			if (node.file) referenced.add(node.file)
			if (node.background) referenced.add(node.background)
		}

		const listing = await adapter.list(assetDir)
		const existingAssetFiles = new Set(listing.files)
		const indexedForCanvas = this.plugin.settings.generatedAssets
			.filter(record => record.canvasPath === canvasPath)
			.filter(record => existingAssetFiles.has(record.path))

		const indexedExistingPaths = new Set(indexedForCanvas.map(record => record.path))
		if (indexedExistingPaths.size !== this.plugin.settings.generatedAssets.filter(record => record.canvasPath === canvasPath).length) {
			this.plugin.settings.generatedAssets = this.plugin.settings.generatedAssets
				.filter(record => record.canvasPath !== canvasPath || existingAssetFiles.has(record.path))
			void this.plugin.saveSettings()
		}

		const toDelete = [...indexedExistingPaths].filter(path => !referenced.has(path))

		if (toDelete.length === 0) {
			if (indexedForCanvas.length === 0) {
				new Notice('No indexed generated files for this canvas yet')
			} else {
				new Notice('Everything indexed for this canvas is in use')
			}
			return
		}

		const sizes = await Promise.all(toDelete.map(async p => {
			try {
				const stat = await adapter.stat(p)
				return stat?.size || 0
			} catch { return 0 }
		}))
		const totalSize = sizes.reduce((a, b) => a + b, 0)

		const sizeMB = (totalSize / 1024 / 1024).toFixed(1)

		const confirmModal = new Modal(this.app)
		confirmModal.modalEl.classList.add('bragi-modal')
		confirmModal.titleEl.setText('Clean up unused files')
		confirmModal.contentEl.createEl('p', {
			text: `${toDelete.length} indexed file${toDelete.length > 1 ? 's' : ''} (${sizeMB} MB) aren't used by the active canvas.`,
		})

		const listEl = confirmModal.contentEl.createEl('details')
		listEl.createEl('summary', { text: 'Show files' })
		const ul = listEl.createEl('ul')
		for (const p of toDelete.slice(0, 50)) {
			ul.createEl('li', { text: p.split('/').pop() || p, cls: 'mod-muted' })
		}
		if (toDelete.length > 50) {
			ul.createEl('li', { text: `… and ${toDelete.length - 50} more` })
		}

		confirmModal.contentEl.createEl('p', {
			text: "This can't be undone.",
			cls: 'mod-warning',
		})

		const btnContainer = confirmModal.contentEl.createDiv({ cls: 'modal-button-container' })

		const cancelBtn = btnContainer.createEl('button', { text: 'Cancel' })
		cancelBtn.addEventListener('click', () => confirmModal.close())

		const deleteBtn = btnContainer.createEl('button', { text: `Delete ${toDelete.length}`, cls: 'mod-destructive' })
		deleteBtn.classList.add('bragi-danger-button')
		deleteBtn.addEventListener('click', () => {
			void (async () => {
				confirmModal.close()
				let deleted = 0
				for (const p of toDelete) {
					try {
						await adapter.remove(p)
						deleted++
					} catch {
						// Skip files that disappear or fail to delete.
					}
				}
				this.plugin.settings.generatedAssets = this.plugin.settings.generatedAssets
					.filter(record => !toDelete.includes(record.path))
				void this.plugin.saveSettings()
				new Notice(`Deleted ${deleted} file${deleted === 1 ? '' : 's'} — ${sizeMB} MB freed`)
			})()
		})

		confirmModal.open()
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

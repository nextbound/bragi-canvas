/* eslint-disable obsidianmd/ui/sentence-case -- Bragi preserves product names, acronyms, and exact CTA copy. */
import { App, Modal, Notice, PluginSettingTab, Setting, setIcon, setTooltip, requestUrl } from 'obsidian'
import type BragiCanvas from './main'
import { ALL_MODELS, getModelsByType, getActiveProvider } from './models/index'
import type { GenerationType } from './models/types'
import { PROVIDERS, getProvider, getConfiguredProviderIds } from './providers/registry'
import { AddProviderModal } from './ui/add-provider-modal'
import { AddModelModal } from './ui/add-model-modal'
import { removeProvider } from './ui/remove-provider-modal'

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
	requestAnimationFrame(update)
}

function createProviderDesc(hint: string, linkText: string, url: string): DocumentFragment {
	const frag = activeDocument.createFragment()
	frag.appendText(`Paste your API key (${hint}). `)
	const a = activeDocument.createEl('a')
	a.href = url
	a.textContent = linkText
	a.addEventListener('click', (e) => {
		e.preventDefault()
		window.open(url, '_blank')
	})
	frag.appendChild(a)
	return frag
}

function addSettingHeading(containerEl: HTMLElement, name: string): void {
	new Setting(containerEl).setName(name).setHeading()
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

export interface BragiSettings {
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
	}

	// Per-model preferences
	modelPrefs: Record<string, ModelPref>

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

	// MCP server
	mcpEnabled: boolean
	mcpPort: number
	mcpToken: string   // optional; when non-empty, all requests require Authorization: Bearer <token>

}

export const DEFAULT_SETTINGS: BragiSettings = {
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
	},
	modelPrefs: {},
	modelOrder: {
		image: [],
		video: [],
		text: [],
		audio: [],
	},
	mcpEnabled: true,
	mcpPort: 17775,
	mcpToken: '',
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

		addSettingHeading(containerEl, 'Bragi Canvas')

		// ── General ──
		addSettingHeading(containerEl, 'General')

		new Setting(containerEl)
			.setName('Clean up unused files')
			.setDesc('Delete generated files that aren\'t used by any canvas or note')
			.addButton(btn => btn
				.setButtonText('Clean up')
				.onClick(() => {
					void this.cleanUpUnusedAssets()
				}))

		this.renderCloudStorageSection(containerEl)

		// ── MCP Server ──
		addSettingHeading(containerEl, 'MCP Server')

		new Setting(containerEl)
			.setName('Enable MCP server')
			.setDesc('Expose canvas operations to Claude Code via MCP protocol')
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
			.setName('MCP port')
			.setDesc('Localhost port for MCP server (requires restart)')
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
			.setName('MCP access token')
			.setDesc('Optional. When set, clients must send "Authorization: Bearer <token>" on every request. Leave blank for open localhost access.')
			.addText(text => {
				text.inputEl.type = 'password'
				text.setPlaceholder('(leave blank to disable auth)')
					.setValue(this.plugin.settings.mcpToken)
					.onChange((v) => {
						void (async () => {
							this.plugin.settings.mcpToken = v.trim()
							await this.plugin.saveSettings()
						})()
					})
		})

		// ── Providers ──
		addSettingHeading(containerEl, 'Providers')
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
			.setDesc('Briefly hosts your files so model APIs can fetch them. Auto-deleted after 24h.')
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
		const wrap = containerEl.createDiv({ cls: 'bragi-providers-list' })
		const configured = PROVIDERS.filter(p => p.isConfigured(this.plugin.settings))

		if (configured.length === 0) {
			wrap.createEl('p', {
				text: 'No providers yet. Add one to unlock models.',
				cls: 'bragi-empty-hint',
			})
		}

		for (const spec of configured) {
			const row = wrap.createDiv({ cls: 'bragi-provider-row' })
			const info = row.createDiv({ cls: 'bragi-provider-info' })
			info.createDiv({ cls: 'bragi-provider-name', text: spec.name })
			if (spec.description) {
				info.createDiv({ cls: 'bragi-provider-desc', text: spec.description })
			}

			const actions = row.createDiv({ cls: 'bragi-provider-actions' })

			const editBtn = actions.createEl('button', { cls: 'bragi-icon-btn' })
			setIcon(editBtn, 'pencil')
			setTooltip(editBtn, 'Edit')
			editBtn.addEventListener('click', () => {
				new AddProviderModal(this.plugin, spec.id, () => this.display()).open()
			})

			const removeBtn = actions.createEl('button', { cls: 'bragi-icon-btn' })
			setIcon(removeBtn, 'x')
			setTooltip(removeBtn, 'Remove')
			removeBtn.addEventListener('click', () => {
				removeProvider(this.plugin, spec.id, () => this.display())
			})
		}

		const addBtn = containerEl.createEl('button', { cls: 'bragi-add-btn', text: '+ Add provider' })
		addBtn.addEventListener('click', () => {
			new AddProviderModal(this.plugin, undefined, () => this.display()).open()
		})
	}

	private renderModelGroup(containerEl: HTMLElement, title: string, type: GenerationType): void {
		const groupEl = containerEl.createDiv({ cls: 'bragi-model-group' })
		addSettingHeading(groupEl, title)

		const configured = getConfiguredProviderIds(this.plugin.settings)
		const allModels = getModelsByType(type)

		// Only show enabled models (users explicitly added them via Add Model flow).
		const enabledModels = allModels.filter(m => this.plugin.settings.modelPrefs[m.id]?.enabled)

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

		const listEl = groupEl.createDiv({ cls: 'bragi-model-list' })

		if (ordered.length === 0) {
			listEl.createEl('p', { text: `No ${type} models added yet.`, cls: 'bragi-empty-hint' })
		}

		for (const model of ordered) {
			const pref = this.plugin.settings.modelPrefs[model.id]
			const activeProvider = getActiveProvider(model, pref.selectedProvider, configured)

			const row = listEl.createDiv({ cls: 'bragi-model-row' })

			// Drag handle
			const handle = row.createSpan({ cls: 'bragi-drag-handle', text: '⠿' })
			handle.setAttribute('draggable', 'true')

			// Model name
			row.createSpan({ cls: 'bragi-model-name', text: model.name })

			// Provider selector — only list supported+configured providers
			const providerSelect = row.createEl('select', { cls: 'dropdown bragi-model-provider' })
			const supportedProviders = Object.keys(model.supportedProviders)
			const usable = supportedProviders.filter(p => configured.includes(p))

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

			// Remove button (× — disables the model, doesn't touch providers)
			const removeBtn = row.createEl('button', { cls: 'bragi-icon-btn bragi-model-remove' })
			setIcon(removeBtn, 'x')
			setTooltip(removeBtn, 'Remove from list')
			removeBtn.addEventListener('click', () => {
				void (async () => {
					this.plugin.settings.modelPrefs[model.id] = { enabled: false, selectedProvider: pref.selectedProvider || '' }
					await this.plugin.saveSettings()
					this.display()
				})()
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

		const addBtn = groupEl.createEl('button', { cls: 'bragi-add-btn', text: `+ Add ${type} model` })
		addBtn.addEventListener('click', () => {
			new AddModelModal(this.plugin, () => this.display(), type).open()
		})
	}

	/**
	 * Delete files in _bragi/assets/ that are not referenced by any canvas or note.
	 * References are collected from:
	 *   - .canvas files: parsed JSON, check nodes[].file and nodes[].background
	 *   - .md files: text search (cheap, catches ![[...]] and ![](...))
	 */
	private async cleanUpUnusedAssets(): Promise<void> {
		const vault = this.app.vault
		const adapter = vault.adapter
		const assetDir = '_bragi/assets'

		if (!await adapter.exists(assetDir)) {
			new Notice('No generated files yet — nothing to clean')
			return
		}

		// 1. Collect referenced vault paths
		const referenced = new Set<string>()
		const allFiles = vault.getFiles()
		let mdContent = ''
		for (const file of allFiles) {
			if (file.extension === 'canvas') {
				try {
					const text = await vault.read(file)
					const data = JSON.parse(text)
					for (const n of (data.nodes || [])) {
						if (n.file) referenced.add(n.file)
						if (n.background) referenced.add(n.background)
					}
				} catch { /* unparseable, skip */ }
			} else if (file.extension === 'md') {
				try {
					mdContent += await vault.read(file) + '\n'
				} catch {
					// Ignore unreadable notes during cleanup scanning.
				}
			}
		}

		// 2. List files in _bragi/assets/
		const listing = await adapter.list(assetDir)
		const assetFiles = listing.files  // full paths

		// 3. Collect unreferenced
		const toDelete: string[] = []
		for (const p of assetFiles) {
			if (referenced.has(p)) continue
			const name = p.split('/').pop() || p
			if (mdContent.includes(name) || mdContent.includes(p)) continue
			toDelete.push(p)
		}

		if (toDelete.length === 0) {
			new Notice('Everything is in use — nothing to clean')
			return
		}

		// 4. Show confirmation dialog
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
			text: `${toDelete.length} file${toDelete.length > 1 ? 's' : ''} (${sizeMB} MB) aren't used by any canvas or note.`,
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
						await vault.adapter.remove(p)
						deleted++
					} catch {
						// Skip files that disappear or fail to delete.
					}
				}
				new Notice(`Deleted ${deleted} file${deleted === 1 ? '' : 's'} — ${sizeMB} MB freed`)
			})()
		})

		confirmModal.open()
	}
}

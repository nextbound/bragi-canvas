/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import { App, Modal, Notice, PluginSettingTab, Setting, setIcon, setTooltip } from 'obsidian'
import type BragiCanvas from './main'
import { getModelsByType, getActiveProvider } from './models/index'
import type { GenerationType } from './models/types'
import { PROVIDERS, getConfiguredProviderIds } from './providers/registry'
import { AddProviderModal } from './ui/add-provider-modal'
import { AddModelModal } from './ui/add-model-modal'
import { removeProvider } from './ui/remove-provider-modal'

type UnknownRecord = Record<string, unknown>

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
			dashscope: string
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
			dashscope: '',
		},
	modelPrefs: {},
	modelOrder: {
		image: [],
		video: [],
		text: [],
		audio: [],
	},
	mcpEnabled: false,
	mcpPort: 17775,
	mcpToken: '',
}

type ImportValidationResult =
	| { ok: true; settings: BragiSettings }
	| { ok: false }

function isRecord(value: unknown): value is UnknownRecord {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cloneDefaultSettings(): BragiSettings {
	return {
		...DEFAULT_SETTINGS,
		providers: { ...DEFAULT_SETTINGS.providers },
		modelPrefs: {},
		modelOrder: {
			image: [],
			video: [],
			text: [],
			audio: [],
		},
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

function readOptionalPort(source: UnknownRecord, key: string, target: UnknownRecord, errors: string[]): void {
	if (!(key in source)) return
	const value = source[key]
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
		errors.push(key)
		return
	}
	target[key] = value
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

const DASHSCOPE_PROVIDER_ID = 'dashscope'
const LEGACY_DASHSCOPE_PROVIDER_ID = ['bai', 'lian'].join('')
const LEGACY_DASHSCOPE_MODEL_PREFIX = `${LEGACY_DASHSCOPE_PROVIDER_ID}-`
const DASHSCOPE_MODEL_PREFIX = 'dashscope-'

function normalizeDashScopeProviderId(provider: string): string {
	return provider === LEGACY_DASHSCOPE_PROVIDER_ID ? DASHSCOPE_PROVIDER_ID : provider
}

function normalizeDashScopeModelId(modelId: string | undefined): string | undefined {
	if (!modelId) return modelId
	return modelId.startsWith(LEGACY_DASHSCOPE_MODEL_PREFIX)
		? `${DASHSCOPE_MODEL_PREFIX}${modelId.slice(LEGACY_DASHSCOPE_MODEL_PREFIX.length)}`
		: modelId
}

export function migrateDashScopeSettings(settings: BragiSettings, raw?: unknown): BragiSettings {
	const rawProviders = isRecord(raw) && isRecord(raw.providers) ? raw.providers : null
	const legacyKey = rawProviders?.[LEGACY_DASHSCOPE_PROVIDER_ID]
	if (!settings.providers.dashscope && typeof legacyKey === 'string') {
		settings.providers.dashscope = legacyKey
	}
	delete (settings.providers as UnknownRecord)[LEGACY_DASHSCOPE_PROVIDER_ID]

	const modelPrefs: Record<string, ModelPref> = {}
	for (const [modelId, pref] of Object.entries(settings.modelPrefs)) {
		modelPrefs[normalizeDashScopeModelId(modelId) || modelId] = {
			...pref,
			selectedProvider: normalizeDashScopeProviderId(pref.selectedProvider || ''),
		}
	}
	settings.modelPrefs = modelPrefs

	for (const type of ['image', 'video', 'text', 'audio'] as const) {
		settings.modelOrder[type] = settings.modelOrder[type].map(id => normalizeDashScopeModelId(id) || id)
	}

	for (const selection of [settings.lastImage, settings.lastVideo, settings.lastAudio, settings.lastText]) {
		if (selection?.modelId) selection.modelId = normalizeDashScopeModelId(selection.modelId)
	}

	return settings
}

function validateImportedSettings(raw: unknown): ImportValidationResult {
	if (!isRecord(raw)) return { ok: false }

	const recognizableKeys = [
		'outputDir',
		'providers',
		'modelPrefs',
		'modelOrder',
		'mcpEnabled',
		'mcpPort',
		'mcpToken',
	]
	if (!recognizableKeys.some(key => key in raw)) return { ok: false }

	const errors: string[] = []
	const settings = cloneDefaultSettings()
	const target = settings as unknown as UnknownRecord

	readOptionalString(raw, 'outputDir', target, errors)
	readOptionalBoolean(raw, 'migrationPrompted', target, errors)
	readOptionalBoolean(raw, 'migrationProviders_1_9', target, errors)
	readOptionalBoolean(raw, 'mcpEnabled', target, errors)
	readOptionalPort(raw, 'mcpPort', target, errors)
	readOptionalString(raw, 'mcpToken', target, errors)

	if ('providers' in raw) {
		if (!isRecord(raw.providers)) {
			errors.push('providers')
		} else {
			const providerKeys = Object.keys(DEFAULT_SETTINGS.providers) as Array<keyof BragiSettings['providers']>
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

	if ('modelPrefs' in raw) {
		if (!isRecord(raw.modelPrefs)) {
			errors.push('modelPrefs')
		} else {
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
	}

	if ('modelOrder' in raw) {
		if (!isRecord(raw.modelOrder)) {
			errors.push('modelOrder')
		} else {
			for (const type of ['image', 'video', 'text', 'audio'] as const) {
				const value = raw.modelOrder[type]
				if (value === undefined) continue
				if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
					errors.push(`modelOrder.${type}`)
					continue
				}
				settings.modelOrder[type] = [...value]
			}
		}
	}

	const lastImage = readLastSelection(raw, 'lastImage', errors)
	const lastVideo = readLastSelection(raw, 'lastVideo', errors)
	const lastAudio = readLastSelection(raw, 'lastAudio', errors)
	const lastText = readLastSelection(raw, 'lastText', errors)
	if (lastImage) settings.lastImage = lastImage
	if (lastVideo) settings.lastVideo = lastVideo
	if (lastAudio) settings.lastAudio = lastAudio
	if (lastText) settings.lastText = lastText

	migrateDashScopeSettings(settings, raw)
	if (errors.length > 0) return { ok: false }
	return { ok: true, settings }
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

		const addBtn = containerEl.createEl('button', { cls: 'bragi-add-btn', text: '+ add provider' })
		addBtn.addEventListener('click', () => {
			new AddProviderModal(this.plugin, undefined, () => this.display()).open()
		})
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

		const result = validateImportedSettings(parsed)
		if (!result.ok) {
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

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

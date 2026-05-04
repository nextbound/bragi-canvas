import { Notice, App } from 'obsidian'
import type { ModelConfig, GenerationType, Mode } from './models/types'
import { getEnabledModels, getConfiguredProviders, getActiveProvider } from './models/index'
import { getUpstreamInputs } from './edge-parser'
import type { BragiSettings } from './settings'
import type { Canvas, CanvasNode } from './types/canvas-internal'

export interface PanelResult {
	prompt: string
	model: ModelConfig
	activeProvider: string
	apiModelId: string
	mode: Mode | null
	params: Record<string, string | number>
	batchCount: number
}

const MODE_LABELS: Record<string, string> = {
	'text-to-image': 'Text → Image',
	'image-ref-to-image': 'Ref Image → Image',
	'text-to-video': 'Text → Video',
	'first-frame': 'First Frame',
	'image-ref': 'Ref Image',
	'first-last-frame': 'First + Last Frame',
	'multi-image-ref': 'Multi Image Ref',
	'video-extend': 'Extend Video',
	'video-edit': 'Edit Video',
	'text-to-text': 'Text → Text',
	'tts': 'Text to Speech',
	'music': 'Music',
	'sound-effect': 'Sound Effect',
}

/**
 * Infer the best default mode based on upstream inputs and model's supported modes.
 * Falls through priorities — if the model doesn't support a mode, skip it.
 */
function inferMode(modes: Mode[], imageCount: number, videoCount: number): Mode {
	// Video upstream → extend
	if (videoCount > 0 && modes.includes('video-extend')) return 'video-extend'

	// 2+ images → prefer first-last-frame, then multi-ref, then image-ref
	if (imageCount >= 2) {
		if (modes.includes('first-last-frame')) return 'first-last-frame'
		if (modes.includes('multi-image-ref')) return 'multi-image-ref'
		if (modes.includes('image-ref')) return 'image-ref'
	}

	// 1 image → prefer first-frame, then image-ref
	if (imageCount === 1) {
		if (modes.includes('first-frame')) return 'first-frame'
		if (modes.includes('image-ref')) return 'image-ref'
	}

	// No special inputs → text-to-video/image/text
	if (modes.includes('text-to-video')) return 'text-to-video'
	if (modes.includes('text-to-image')) return 'text-to-image'
	if (modes.includes('text-to-text')) return 'text-to-text'

	return modes[0]
}

let activeBar: HTMLElement | null = null
let dismissHandler: (() => void) | null = null
let positionRAF: number | null = null

/** Auto-size a <select> to fit only the currently selected option text */
function autoSizeSelect(select: HTMLSelectElement): void {
	const measure = document.createElement('span')
	measure.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font:inherit;padding:0;'
	select.parentElement?.appendChild(measure)
	const update = () => {
		const text = select.options[select.selectedIndex]?.text || ''
		measure.textContent = text
		// 20px right padding for chevron
		select.style.width = `${measure.offsetWidth + 26}px`
	}
	select.addEventListener('change', update)
	// Initial size
	requestAnimationFrame(update)
}

export function showGenerateBar(
	node: CanvasNode,
	type: GenerationType,
	settings: BragiSettings,
	app: App,
	onSubmit: (result: PanelResult) => void,
	onSaveSettings?: () => void
): void {
	hideGenerateBar()

	const configuredProviders = getConfiguredProviders(settings.providers as any)

	function getModelsForType(t: GenerationType) {
		const orderKey = t as keyof typeof settings.modelOrder
		return getEnabledModels(t, settings.modelOrder[orderKey], settings.modelPrefs, configuredProviders)
	}

	const allEnabled = [...getModelsForType('image'), ...getModelsForType('video'), ...getModelsForType('text')]
	if (allEnabled.length === 0) {
		new Notice('Bragi Canvas: No models available. Configure API keys in Settings.')
		return
	}

	// State
	let currentType: GenerationType = type
	let models = getModelsForType(currentType)
	let selectedModel: ModelConfig | null = models[0] || null
	let paramValues: Record<string, string | number> = {}

	// ── Create all DOM elements first ──

	const bar = document.createElement('div')
	bar.className = 'bragi-generate-bar'
	activeBar = bar
	bar.addEventListener('pointerdown', (e) => e.stopPropagation())
	bar.addEventListener('click', (e) => e.stopPropagation())

	// Left group: model + mode selectors
	const leftGroup = document.createElement('div')
	leftGroup.className = 'bragi-bar-left'
	bar.appendChild(leftGroup)

	// Model selector
	const modelSelect = document.createElement('select')
	modelSelect.className = 'bragi-bar-select'
	leftGroup.appendChild(modelSelect)

	// Mode selector (for video models with multiple modes)
	const modeSelect = document.createElement('select')
	modeSelect.className = 'bragi-bar-select'
	leftGroup.appendChild(modeSelect)

	// Right group: params + batch + run
	const rightGroup = document.createElement('div')
	rightGroup.className = 'bragi-bar-right'
	bar.appendChild(rightGroup)

	// Params container
	const paramsEl = document.createElement('div')
	paramsEl.className = 'bragi-bar-params'
	rightGroup.appendChild(paramsEl)

	// Batch count selector
	const batchSelect = document.createElement('select')
	batchSelect.className = 'bragi-bar-select'
	batchSelect.title = 'Count'
	for (const n of [1, 2, 3, 4]) {
		const opt = document.createElement('option')
		opt.value = String(n)
		opt.textContent = `x${n}`
		batchSelect.appendChild(opt)
	}
	batchSelect.value = '1'
	rightGroup.appendChild(batchSelect)

	// Run button
	const runBtn = document.createElement('button')
	runBtn.className = 'bragi-bar-run'
	runBtn.textContent = 'Run'
	rightGroup.appendChild(runBtn)

	// ── Read upstream for mode inference ──

	let upstreamImageCount = 0
	let upstreamVideoCount = 0
	const canvas = node.canvas
	if (canvas) {
		const upstream = getUpstreamInputs(canvas, node)
		upstreamImageCount = [...new Set(upstream.images)].length
		upstreamVideoCount = upstream.videos.length
	}

	let selectedMode: Mode | null = null

	// ── Define functions (all DOM elements exist now) ──

	function rebuildModeList() {
		modeSelect.innerHTML = ''
		if (!selectedModel || selectedModel.modes.length <= 1) {
			modeSelect.style.display = 'none'
			selectedMode = selectedModel?.modes[0] || null
			return
		}

		modeSelect.style.display = ''
		const inferred = inferMode(selectedModel.modes, upstreamImageCount, upstreamVideoCount)

		for (const mode of selectedModel.modes) {
			const opt = document.createElement('option')
			opt.value = mode
			opt.textContent = MODE_LABELS[mode] || mode
			modeSelect.appendChild(opt)
		}

		modeSelect.value = inferred
		selectedMode = inferred
	}

	function initDefaults() {
		const prev = { ...paramValues }
		paramValues = {}
		if (!selectedModel) return
		for (const p of selectedModel.params) {
			// Keep current value if same param exists and value is valid in new model
			if (prev[p.id] !== undefined && p.options?.some(o => o.value === String(prev[p.id]))) {
				paramValues[p.id] = prev[p.id]
			} else {
				paramValues[p.id] = p.default
			}
		}
	}

	function rebuildParams() {
		paramsEl.innerHTML = ''
		if (!selectedModel) return
		for (const param of selectedModel.params) {
			if (param.type === 'select' && param.options) {
				const select = document.createElement('select')
				select.className = 'bragi-bar-select'
				select.title = param.label
				for (const opt of param.options) {
					const optEl = document.createElement('option')
					optEl.value = opt.value
					optEl.textContent = opt.label
					select.appendChild(optEl)
				}
				select.value = String(paramValues[param.id] ?? param.default)
				select.addEventListener('change', () => {
					paramValues[param.id] = select.value
					updateRunState()
				})
				paramsEl.appendChild(select)
				autoSizeSelect(select)
			} else if (param.type === 'range') {
				const wrapper = document.createElement('div')
				wrapper.className = 'bragi-bar-range'

				const range = document.createElement('input')
				range.type = 'range'
				range.min = String(param.min ?? 0)
				range.max = String(param.max ?? 100)
				range.step = String(param.step ?? 1)
				range.value = String(paramValues[param.id] ?? param.default)
				range.title = param.label

				const valueLabel = document.createElement('span')
				valueLabel.className = 'bragi-bar-range-value'
				valueLabel.textContent = `${range.value}${param.unit || ''}`

				range.addEventListener('input', () => {
					paramValues[param.id] = parseInt(range.value)
					valueLabel.textContent = `${range.value}${param.unit || ''}`
				})

				wrapper.appendChild(range)
				wrapper.appendChild(valueLabel)
				paramsEl.appendChild(wrapper)
			}
		}
	}

	/**
	 * Check if a model can handle the current upstream inputs.
	 */
	function modelSupportsInputs(m: ModelConfig): boolean {
		// Text and image models — always compatible for now
		if (m.type !== 'video') return true
		// No special inputs — all video models support text-to-video
		if (upstreamImageCount === 0 && upstreamVideoCount === 0) return true
		// Has video input — needs video-extend
		if (upstreamVideoCount > 0) return m.modes.includes('video-extend')
		// Has 2+ images — needs first-last-frame, multi-image-ref, or image-ref
		if (upstreamImageCount >= 2) {
			return m.modes.includes('first-last-frame') || m.modes.includes('multi-image-ref') || m.modes.includes('image-ref')
		}
		// Has 1 image — needs first-frame or image-ref
		if (upstreamImageCount === 1) {
			return m.modes.includes('first-frame') || m.modes.includes('image-ref')
		}
		return true
	}

	function rebuildModelList() {
		modelSelect.innerHTML = ''
		models = getModelsForType(currentType)

		if (models.length === 0) {
			const opt = document.createElement('option')
			opt.textContent = 'No models'
			opt.disabled = true
			modelSelect.appendChild(opt)
			selectedModel = null
		} else {
			let firstCompatible: ModelConfig | null = null
			for (const m of models) {
				const opt = document.createElement('option')
				opt.value = m.id
				const compatible = modelSupportsInputs(m)
				if (!compatible) {
					opt.textContent = `${m.name} (not supported)`
					opt.disabled = true
				} else {
					opt.textContent = m.name
					if (!firstCompatible) firstCompatible = m
				}
				modelSelect.appendChild(opt)
			}
			// Priority: node metadata > global memory > first compatible
			const nodeData = node.getData() as any
			const nodeLastGen = (nodeData.bragiLastGen || nodeData.ovidLastGen)?.[currentType]
			const globalLastKey = currentType === 'image' ? 'lastImage' : currentType === 'video' ? 'lastVideo' : 'lastText'
			const globalLast = (settings as any)[globalLastKey] as any

			// Try node-level first, then global
			const last = nodeLastGen || globalLast
			const lastModel = last?.modelId ? models.find(m => m.id === last.modelId && modelSupportsInputs(m)) : null

			selectedModel = lastModel || firstCompatible || models[0]
			modelSelect.value = selectedModel.id
			savedParams = (lastModel && last?.params) ? last.params : null
		}

		initDefaults()
		rebuildModeList()

		// Restore saved params AFTER initDefaults (which resets to defaults)
		if (savedParams) {
			paramValues = { ...paramValues, ...savedParams }
		}

		rebuildParams()

		// Apply restored values to the param UI
		if (savedParams) {
			paramsEl.querySelectorAll('select').forEach((select: HTMLSelectElement) => {
				const paramId = select.title
				const model = selectedModel
				if (model) {
					const param = model.params.find(p => p.label === paramId)
					if (param && savedParams[param.id] !== undefined) {
						select.value = String(savedParams[param.id])
					}
				}
			})
		}
	}

	let savedParams: Record<string, any> | null = null

	// ── Run button state ──

	function updateRunState() {
		let disabled = false
		let title = ''

		// MiniMax Music "With Lyrics" needs upstream text node
		if (selectedModel?.id === 'minimax-music' && paramValues.instrumental === 'false') {
			if (upstreamImageCount === 0 && upstreamVideoCount === 0) {
				// Check if there are upstream text prompts (we stored count earlier)
				// Actually we need to check upstream text — use the canvas
				const canvas = node.canvas
				if (canvas) {
					const upstream = getUpstreamInputs(canvas, node)
					if (upstream.prompts.length === 0) {
						disabled = true
						title = 'Connect a lyrics text node'
					}
				}
			}
		}

		runBtn.disabled = disabled
		runBtn.title = title
		runBtn.style.opacity = disabled ? '0.4' : '1'
		runBtn.style.cursor = disabled ? 'not-allowed' : 'pointer'
	}

	// ── Wire up events ──

	modelSelect.addEventListener('change', () => {
		selectedModel = models.find(m => m.id === modelSelect.value) || models[0]
		initDefaults()
		rebuildModeList()
		rebuildParams()
		updateRunState()
	})

	modeSelect.addEventListener('change', () => {
		selectedMode = (modeSelect.value as Mode) || null
		updateRunState()
	})

	runBtn.addEventListener('click', async (e) => {
		e.stopPropagation()
		e.preventDefault()

		let prompt = ''
		const nodeData = node.getData()
		if (nodeData.type === 'text') {
			prompt = node.text?.trim() || ''
		} else if (nodeData.type === 'file' && (nodeData as any).file?.endsWith('.md')) {
			const filePath = (nodeData as any).file
			const file = app.vault.getAbstractFileByPath(filePath)
			if (file) {
				prompt = (await app.vault.read(file as any)).trim()
			}
		}

		if (!prompt) {
			new Notice('Bragi Canvas: No prompt found in this node')
			return
		}
		if (!selectedModel) {
			new Notice('Bragi Canvas: No model selected')
			return
		}
		hideGenerateBar()
		const batchCount = parseInt(batchSelect.value) || 1

		// Save to global memory
		const lastKey = currentType === 'image' ? 'lastImage' : currentType === 'video' ? 'lastVideo' : 'lastText'
		;(settings as any)[lastKey] = {
			modelId: selectedModel.id,
			params: { ...paramValues },
			batchCount,
		}
		onSaveSettings?.()

		// Save to node metadata (persists in canvas JSON)
		const currentNodeData = node.getData() as any
		const bragiLastGen = currentNodeData.bragiLastGen || currentNodeData.ovidLastGen || {}
		bragiLastGen[currentType] = {
			modelId: selectedModel.id,
			params: { ...paramValues },
			batchCount,
		}
		// Write new key, drop the legacy one so it doesn't silently drift
		const { ovidLastGen: _legacy, ...rest } = currentNodeData
		node.setData({ ...rest, bragiLastGen })

		// Resolve active provider and API model ID
		const pref = settings.modelPrefs[selectedModel.id]
		const provider = getActiveProvider(selectedModel, pref?.selectedProvider, configuredProviders) || Object.keys(selectedModel.supportedProviders)[0]
		const apiModelId = selectedModel.supportedProviders[provider]?.apiModelId || selectedModel.id

		onSubmit({ prompt, model: selectedModel, activeProvider: provider, apiModelId, mode: selectedMode, params: paramValues, batchCount })
	})

	// ── Initialize ──

	rebuildModelList()

	// Restore last batch count (node metadata > global)
	const initNodeData = node.getData() as any
	const initNodeLast = (initNodeData.bragiLastGen || initNodeData.ovidLastGen)?.[currentType]
	const initGlobalKey = currentType === 'image' ? 'lastImage' : currentType === 'video' ? 'lastVideo' : 'lastText'
	const initGlobalLast = (settings as any)[initGlobalKey] as any
	const initLast = initNodeLast || initGlobalLast
	if (initLast?.batchCount) {
		batchSelect.value = String(initLast.batchCount)
	}

	updateRunState()

	// Auto-size all selects to fit selected text
	autoSizeSelect(modelSelect)
	autoSizeSelect(modeSelect)
	autoSizeSelect(batchSelect)

	// ── Attach to DOM ──

	const nodeCanvas = node.canvas
	let barParent: HTMLElement | null = null

	const menu = (nodeCanvas as any).menu
	if (menu?.menuEl?.parentElement) {
		barParent = menu.menuEl.parentElement
	}
	if (!barParent && nodeCanvas.wrapperEl?.parentElement) {
		barParent = nodeCanvas.wrapperEl.parentElement
	}
	if (!barParent) {
		barParent = document.body
		bar.style.zIndex = '10000'
	}

	barParent.appendChild(bar)

	// ── Position tracking ──

	const nodeEl = node.nodeEl || node.containerEl
	function updatePosition() {
		if (!activeBar || !nodeEl) return
		const nodeRect = nodeEl.getBoundingClientRect()
		const parentRect = bar.offsetParent?.getBoundingClientRect()
		if (!parentRect) return

		const left = nodeRect.left - parentRect.left + nodeRect.width / 2 - bar.offsetWidth / 2
		const top = nodeRect.bottom - parentRect.top + 8

		bar.style.left = `${left}px`
		bar.style.top = `${top}px`

		positionRAF = requestAnimationFrame(updatePosition)
	}
	positionRAF = requestAnimationFrame(updatePosition)

	// ── Auto-dismiss ──

	setTimeout(() => {
		const wrapper = nodeCanvas?.wrapperEl
		if (wrapper) {
			const handler = (e: Event) => {
				if (bar.contains(e.target as Node)) return
				if (nodeEl?.contains(e.target as Node)) return
				hideGenerateBar()
			}
			wrapper.addEventListener('pointerdown', handler, { capture: true })
			dismissHandler = () => wrapper.removeEventListener('pointerdown', handler, { capture: true })
		}
	}, 100)
}

export function showBatchGenerateBar(
	nodes: CanvasNode[],
	type: GenerationType,
	settings: BragiSettings,
	app: App,
	onSubmit: (nodes: CanvasNode[], result: PanelResult) => void,
	onSaveSettings?: () => void,
): void {
	hideGenerateBar()

	const configuredProviders = getConfiguredProviders(settings.providers as any)

	function getModelsForType(t: GenerationType) {
		const orderKey = t as keyof typeof settings.modelOrder
		return getEnabledModels(t, settings.modelOrder[orderKey], settings.modelPrefs, configuredProviders)
	}

	const allEnabled = [...getModelsForType('image'), ...getModelsForType('video'), ...getModelsForType('text')]
	if (allEnabled.length === 0) {
		new Notice('Bragi Canvas: No models available. Configure API keys in Settings.')
		return
	}

	let currentType: GenerationType = type
	let models = getModelsForType(currentType)
	let selectedModel: ModelConfig | null = models[0] || null
	let paramValues: Record<string, string | number> = {}

	const bar = document.createElement('div')
	bar.className = 'bragi-generate-bar'
	activeBar = bar
	bar.addEventListener('pointerdown', (e) => e.stopPropagation())
	bar.addEventListener('click', (e) => e.stopPropagation())

	const leftGroup = document.createElement('div')
	leftGroup.className = 'bragi-bar-left'
	bar.appendChild(leftGroup)

	const modelSelect = document.createElement('select')
	modelSelect.className = 'bragi-bar-select'
	leftGroup.appendChild(modelSelect)

	const modeSelect = document.createElement('select')
	modeSelect.className = 'bragi-bar-select'
	leftGroup.appendChild(modeSelect)

	const rightGroup = document.createElement('div')
	rightGroup.className = 'bragi-bar-right'
	bar.appendChild(rightGroup)

	const paramsEl = document.createElement('div')
	paramsEl.className = 'bragi-bar-params'
	rightGroup.appendChild(paramsEl)

	const batchSelect = document.createElement('select')
	batchSelect.className = 'bragi-bar-select'
	batchSelect.title = 'Count'
	for (const n of [1, 2, 3, 4]) {
		const opt = document.createElement('option')
		opt.value = String(n)
		opt.textContent = `x${n}`
		batchSelect.appendChild(opt)
	}
	batchSelect.value = '1'
	rightGroup.appendChild(batchSelect)

	const runBtn = document.createElement('button')
	runBtn.className = 'bragi-bar-run'
	runBtn.textContent = `Run (${nodes.length})`
	rightGroup.appendChild(runBtn)

	let selectedMode: Mode | null = null

	function rebuildModeList() {
		modeSelect.innerHTML = ''
		if (!selectedModel || selectedModel.modes.length <= 1) {
			modeSelect.style.display = 'none'
			selectedMode = selectedModel?.modes[0] || null
			return
		}
		modeSelect.style.display = ''
		for (const mode of selectedModel.modes) {
			const opt = document.createElement('option')
			opt.value = mode
			opt.textContent = MODE_LABELS[mode] || mode
			modeSelect.appendChild(opt)
		}
		selectedMode = selectedModel.modes[0]
		modeSelect.value = selectedMode
	}

	function initDefaults() {
		paramValues = {}
		if (!selectedModel) return
		for (const p of selectedModel.params) {
			paramValues[p.id] = p.default
		}
	}

	function rebuildParams() {
		paramsEl.innerHTML = ''
		if (!selectedModel) return
		for (const param of selectedModel.params) {
			if (param.type === 'select' && param.options) {
				const select = document.createElement('select')
				select.className = 'bragi-bar-select'
				select.title = param.label
				for (const opt of param.options) {
					const optEl = document.createElement('option')
					optEl.value = opt.value
					optEl.textContent = opt.label
					select.appendChild(optEl)
				}
				select.value = String(paramValues[param.id] ?? param.default)
				select.addEventListener('change', () => { paramValues[param.id] = select.value })
				paramsEl.appendChild(select)
				autoSizeSelect(select)
			} else if (param.type === 'range') {
				const wrapper = document.createElement('div')
				wrapper.className = 'bragi-bar-range'
				const range = document.createElement('input')
				range.type = 'range'
				range.min = String(param.min ?? 0)
				range.max = String(param.max ?? 100)
				range.step = String(param.step ?? 1)
				range.value = String(paramValues[param.id] ?? param.default)
				range.title = param.label
				const valueLabel = document.createElement('span')
				valueLabel.className = 'bragi-bar-range-value'
				valueLabel.textContent = `${range.value}${param.unit || ''}`
				range.addEventListener('input', () => {
					paramValues[param.id] = parseInt(range.value)
					valueLabel.textContent = `${range.value}${param.unit || ''}`
				})
				wrapper.appendChild(range)
				wrapper.appendChild(valueLabel)
				paramsEl.appendChild(wrapper)
			}
		}
	}

	function rebuildModelList() {
		modelSelect.innerHTML = ''
		models = getModelsForType(currentType)
		if (models.length === 0) {
			const opt = document.createElement('option')
			opt.textContent = 'No models'
			opt.disabled = true
			modelSelect.appendChild(opt)
			selectedModel = null
		} else {
			for (const m of models) {
				const opt = document.createElement('option')
				opt.value = m.id
				opt.textContent = m.name
				modelSelect.appendChild(opt)
			}
			const globalLastKey = currentType === 'image' ? 'lastImage' : currentType === 'video' ? 'lastVideo' : 'lastText'
			const globalLast = (settings as any)[globalLastKey] as any
			const lastModel = globalLast?.modelId ? models.find(m => m.id === globalLast.modelId) : null
			selectedModel = lastModel || models[0]
			modelSelect.value = selectedModel.id
		}
		initDefaults()
		rebuildModeList()
		rebuildParams()
	}

	modelSelect.addEventListener('change', () => {
		selectedModel = models.find(m => m.id === modelSelect.value) || models[0]
		initDefaults()
		rebuildModeList()
		rebuildParams()
	})

	modeSelect.addEventListener('change', () => {
		selectedMode = (modeSelect.value as Mode) || null
	})

	runBtn.addEventListener('click', (e) => {
		e.stopPropagation()
		e.preventDefault()
		if (!selectedModel) {
			new Notice('Bragi Canvas: No model selected')
			return
		}
		hideGenerateBar()

		const batchCount = parseInt(batchSelect.value) || 1
		const lastKey = currentType === 'image' ? 'lastImage' : currentType === 'video' ? 'lastVideo' : 'lastText'
		;(settings as any)[lastKey] = {
			modelId: selectedModel.id,
			params: { ...paramValues },
			batchCount,
		}
		onSaveSettings?.()

		const pref = settings.modelPrefs[selectedModel.id]
		const provider = getActiveProvider(selectedModel, pref?.selectedProvider, configuredProviders) || Object.keys(selectedModel.supportedProviders)[0]
		const apiModelId = selectedModel.supportedProviders[provider]?.apiModelId || selectedModel.id

		onSubmit(nodes, {
			prompt: '',
			model: selectedModel,
			activeProvider: provider,
			apiModelId,
			mode: selectedMode,
			params: paramValues,
			batchCount,
		})
	})

	rebuildModelList()

	const globalLastKey = currentType === 'image' ? 'lastImage' : currentType === 'video' ? 'lastVideo' : 'lastText'
	const globalLast = (settings as any)[globalLastKey] as any
	if (globalLast?.batchCount) batchSelect.value = String(globalLast.batchCount)

	autoSizeSelect(modelSelect)
	autoSizeSelect(modeSelect)
	autoSizeSelect(batchSelect)

	// Attach to DOM — use the first node's canvas
	const nodeCanvas = nodes[0].canvas
	let barParent: HTMLElement | null = null
	const menu = (nodeCanvas as any)?.menu
	if (menu?.menuEl?.parentElement) barParent = menu.menuEl.parentElement
	if (!barParent && nodeCanvas?.wrapperEl?.parentElement) barParent = nodeCanvas.wrapperEl.parentElement
	if (!barParent) { barParent = document.body; bar.style.zIndex = '10000' }
	barParent.appendChild(bar)

	// Position: bounding box of all selected nodes, center-bottom
	function updatePosition() {
		if (!activeBar) return
		let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
		for (const n of nodes) {
			const el = (n as any).nodeEl || (n as any).containerEl
			if (!el) continue
			const r = el.getBoundingClientRect()
			if (r.left < minX) minX = r.left
			if (r.top < minY) minY = r.top
			if (r.right > maxX) maxX = r.right
			if (r.bottom > maxY) maxY = r.bottom
		}
		const parentRect = bar.offsetParent?.getBoundingClientRect()
		if (!parentRect) return
		const left = (minX + maxX) / 2 - parentRect.left - bar.offsetWidth / 2
		const top = maxY - parentRect.top + 8
		bar.style.left = `${left}px`
		bar.style.top = `${top}px`
		positionRAF = requestAnimationFrame(updatePosition)
	}
	positionRAF = requestAnimationFrame(updatePosition)

	// Auto-dismiss
	setTimeout(() => {
		const wrapper = nodeCanvas?.wrapperEl
		if (wrapper) {
			const handler = (e: Event) => {
				if (bar.contains(e.target as Node)) return
				hideGenerateBar()
			}
			wrapper.addEventListener('pointerdown', handler, { capture: true })
			dismissHandler = () => wrapper.removeEventListener('pointerdown', handler, { capture: true })
		}
	}, 100)
}

export function hideGenerateBar(): void {
	if (positionRAF !== null) {
		cancelAnimationFrame(positionRAF)
		positionRAF = null
	}
	if (activeBar) {
		activeBar.remove()
		activeBar = null
	}
	if (dismissHandler) {
		dismissHandler()
		dismissHandler = null
	}
}

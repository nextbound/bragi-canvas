/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import { Notice, App } from 'obsidian'
import type { ModelConfig, GenerationType, Mode, ModelParam, VoiceSourceMode } from './models/types'
import { getEnabledModels, getActiveProvider } from './models/index'
import { getTextInputCapability, textInputKindSupported } from './models/text-input-capabilities'
import { getConnectedConfiguredProviderIds, resolveApiModelId } from './provider-model-prefs'
import { getUpstreamInputs } from './edge-parser'
import { getOrderedAudios } from './audio-refs'
import { getOrderedTextRefs } from './text-refs'
import type { BragiSettings } from './settings'
import type { CanvasNode } from './types/canvas-internal'
import { getNodeElement, getSelectionBounds, positionNodeToolbar } from './node-toolbar-position'
import { VoicePickerModal } from './ui/voice-picker-modal'

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
	'video-ref': 'Reference video',
	'video-extend': 'Extend Video',
	'video-edit': 'Edit Video',
	'text-to-text': 'Text → Text',
	'tts': 'Text to Speech',
	'music': 'Music',
	'sound-effect': 'Sound Effect',
}

type LastSelectionKey = 'lastImage' | 'lastVideo' | 'lastAudio' | 'lastText'
type VoiceMode = VoiceSourceMode
type AudioIntent = 'speech' | 'music'

function lastSelectionKey(type: GenerationType): LastSelectionKey {
	if (type === 'image') return 'lastImage'
	if (type === 'video') return 'lastVideo'
	if (type === 'audio') return 'lastAudio'
	return 'lastText'
}

function allConfiguredModels(getModelsForType: (type: GenerationType) => ModelConfig[]): ModelConfig[] {
	return [
		...getModelsForType('image'),
		...getModelsForType('video'),
		...getModelsForType('text'),
		...getModelsForType('audio'),
	]
}

function voiceDisplayLabel(
	params: Record<string, string | number>,
	options: Array<{ label: string; value: string }> | undefined,
	fallback: string | number,
): string {
	const value = String(params.voice ?? fallback ?? '')
	const savedLabel = typeof params.voiceLabel === 'string' ? params.voiceLabel : ''
	return savedLabel || options?.find(o => o.value === value)?.label || value || 'Choose'
}

function rangeParamValueLabel(param: ModelParam, value: string | number): string {
	return `${value}${param.unit || ''}`
}

function renderRangeParamDropdown(
	paramsEl: HTMLElement,
	param: ModelParam,
	paramValues: Record<string, string | number>,
): void {
	const details = createEl('details')
	details.className = 'bragi-bar-range-menu'

	const summary = createEl('summary')
	summary.className = 'bragi-bar-range-btn'
	summary.title = param.label

	const popover = createDiv()
	popover.className = 'bragi-bar-range-popover'

	const sliderRow = createDiv()
	sliderRow.className = 'bragi-bar-range-row'

	const range = createEl('input')
	range.type = 'range'
	range.min = String(param.min ?? 0)
	range.max = String(param.max ?? 100)
	range.step = String(param.step ?? 1)
	range.value = String(paramValues[param.id] ?? param.default)
	range.title = param.label

	const valueLabel = createSpan()
	valueLabel.className = 'bragi-bar-range-value'

	const updateLabel = () => {
		const value = rangeParamValueLabel(param, range.value)
		summary.textContent = `${param.label} (${value})`
		valueLabel.textContent = value
	}

	range.addEventListener('input', () => {
		paramValues[param.id] = parseFloat(range.value)
		updateLabel()
	})

	details.addEventListener('toggle', () => {
		if (!details.open) return
		paramsEl.querySelectorAll('details.bragi-bar-range-menu[open]').forEach((el) => {
			if (el !== details) (el as HTMLDetailsElement).open = false
		})
	})

	updateLabel()
	sliderRow.appendChild(range)
	sliderRow.appendChild(valueLabel)
	popover.appendChild(sliderRow)
	details.appendChild(summary)
	details.appendChild(popover)
	paramsEl.appendChild(details)
}

function resolveProvider(
	model: ModelConfig,
	settings: BragiSettings,
): { provider: string; apiModelId: string } {
	const pref = settings.modelPrefs[model.id]
	const provider = getActiveProvider(model, pref?.selectedProvider, getConnectedConfiguredProviderIds(settings, model)) || Object.keys(model.supportedProviders)[0]
	const apiModelId = resolveApiModelId(settings, provider, model)
	return { provider, apiModelId }
}

function catalogProviderFor(_model: ModelConfig, activeProvider: string): string {
	return activeProvider
}

function voiceConfigFor(model: ModelConfig | null): { builtin: boolean; clone: boolean; design: boolean } {
	return {
		builtin: model?.voiceConfig?.builtin ?? true,
		clone: model?.voiceConfig?.clone ?? false,
		design: model?.voiceConfig?.design ?? false,
	}
}

function audioOrdinal(index: number): string {
	return `Audio ${index + 1}`
}

function textOrdinal(index: number): string {
	return `Text ${index + 1}`
}

function selectedVoiceMode(params: Record<string, string | number>): VoiceMode {
	if (params.voiceMode === 'reference') return 'reference'
	if (params.voiceMode === 'design') return 'design'
	return 'builtin'
}

function audioIntentForModel(model: ModelConfig): AudioIntent {
	return model.modes.includes('tts') ? 'speech' : 'music'
}

function supportsAudioIntent(model: ModelConfig, intent: AudioIntent): boolean {
	if (model.type !== 'audio') return false
	if (intent === 'speech') return model.modes.includes('tts')
	return model.modes.includes('music') || model.modes.includes('sound-effect')
}

function supportsVoiceSource(model: ModelConfig, source: VoiceMode): boolean {
	const config = voiceConfigFor(model)
	if (!model.modes.includes('tts')) return false
	if (source === 'reference') return config.clone
	if (source === 'design') return config.design
	return config.builtin
}

/**
 * Infer the best default mode based on upstream inputs and model's supported modes.
 * Falls through priorities — if the model doesn't support a mode, skip it.
 */
function inferMode(modes: Mode[], imageCount: number, videoCount: number): Mode {
	// Video upstream → reference or extend
	if (videoCount > 0 && modes.includes('video-ref')) return 'video-ref'
	if (videoCount > 0 && modes.includes('video-extend')) return 'video-extend'
	if (videoCount > 0 && modes.includes('video-edit')) return 'video-edit'

	// 2+ images → prefer first-last-frame, then multi-ref, then image-ref
	if (imageCount >= 2) {
		if (modes.includes('first-last-frame')) return 'first-last-frame'
		if (modes.includes('multi-image-ref')) return 'multi-image-ref'
		if (modes.includes('image-ref')) return 'image-ref'
		if (modes.includes('image-ref-to-image')) return 'image-ref-to-image'
	}

	// 1 image → prefer first-frame, then image-ref (video), then image-ref-to-image (image)
	if (imageCount === 1) {
		if (modes.includes('first-frame')) return 'first-frame'
		if (modes.includes('image-ref')) return 'image-ref'
		if (modes.includes('image-ref-to-image')) return 'image-ref-to-image'
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

/**
 * Auto-size a <select> to fit only the currently selected option text.
 * Returns an `update()` — call it after programmatically changing options/value,
 * since assigning .value or innerHTML doesn't fire a `change` event.
 */
function autoSizeSelect(select: HTMLSelectElement): () => void {
	const measure = createSpan({ cls: 'bragi-select-measure' })
	select.classList.add('is-auto-sized')
	const update = () => {
		// Defer the first call until the select is attached to the DOM — otherwise
		// measure.offsetWidth is always 0 and the control collapses to ~26px.
		const parent = select.parentElement
		if (!parent) return
		if (measure.parentElement !== parent) parent.appendChild(measure)
		const text = select.options[select.selectedIndex]?.text || ''
		measure.textContent = text
		select.setCssProps({ '--bragi-select-width': `${measure.offsetWidth + 26}px` })
	}
	select.addEventListener('change', update)
	window.requestAnimationFrame(update)
	return update
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

	function getModelsForType(t: GenerationType) {
		const orderKey = t
		return getEnabledModels(t, settings.modelOrder[orderKey], settings.modelPrefs, model => getConnectedConfiguredProviderIds(settings, model))
	}

	const allEnabled = allConfiguredModels(getModelsForType)
	if (allEnabled.length === 0) {
		new Notice('Bragi canvas: no models available. Add models in settings.')
		return
	}

	// State
	let currentType: GenerationType = type
	let models = getModelsForType(currentType)
	let selectedModel: ModelConfig | null = models[0] || null
	let paramValues: Record<string, string | number> = {}

	// ── Create all DOM elements first ──

	const bar = createDiv()
	bar.className = 'bragi-generate-bar'
	activeBar = bar
	bar.addEventListener('pointerdown', (e) => e.stopPropagation())
	bar.addEventListener('click', (e) => e.stopPropagation())

	// Left group: model + mode selectors
	const leftGroup = createDiv()
	leftGroup.className = 'bragi-bar-left'
	bar.appendChild(leftGroup)

	const audioIntentSelect = createEl('select')
	audioIntentSelect.className = 'bragi-bar-select'
	audioIntentSelect.title = 'Audio'
	leftGroup.appendChild(audioIntentSelect)

	const audioVoiceSourceSelect = createEl('select')
	audioVoiceSourceSelect.className = 'bragi-bar-select'
	audioVoiceSourceSelect.title = 'Voice source'
	leftGroup.appendChild(audioVoiceSourceSelect)

	// Model selector
	const modelSelect = createEl('select')
	modelSelect.className = 'bragi-bar-select'
	leftGroup.appendChild(modelSelect)

	// Mode selector (for video models with multiple modes)
	const modeSelect = createEl('select')
	modeSelect.className = 'bragi-bar-select'
	leftGroup.appendChild(modeSelect)

	// Right group: params + batch + run
	const rightGroup = createDiv()
	rightGroup.className = 'bragi-bar-right'
	bar.appendChild(rightGroup)

	// Params container
	const paramsEl = createDiv()
	paramsEl.className = 'bragi-bar-params'
	rightGroup.appendChild(paramsEl)

	// Batch count selector
	const batchSelect = createEl('select')
	batchSelect.className = 'bragi-bar-select'
	batchSelect.title = 'Count'
	for (const n of [1, 2, 3, 4]) {
		const opt = createEl('option')
		opt.value = String(n)
		opt.textContent = `x${n}`
		batchSelect.appendChild(opt)
	}
	batchSelect.value = '1'
	rightGroup.appendChild(batchSelect)

	// Run button
	const runBtn = createEl('button')
	runBtn.className = 'bragi-bar-run'
	runBtn.textContent = 'Run'
	rightGroup.appendChild(runBtn)

	const upstreamMediaHint = createSpan()
	upstreamMediaHint.className = 'bragi-bar-upstream-hint bragi-bar-upstream-hint-hidden'
	leftGroup.appendChild(upstreamMediaHint)

	// ── Read upstream for mode inference ──

	let upstreamImageCount = 0
	let upstreamVideoCount = 0
	let upstreamPdfCount = 0
	let upstreamAudioCount = 0
	let orderedAudios: string[] = []
	let orderedTextRefCount = 0
	const canvas = node.canvas
	if (canvas) {
		const upstream = getUpstreamInputs(canvas, node)
		upstreamImageCount = [...new Set(upstream.images)].length
		upstreamVideoCount = upstream.videos.length
		upstreamPdfCount = upstream.pdfs.length
		upstreamAudioCount = upstream.audios.length
		orderedAudios = getOrderedAudios(canvas, node)
		orderedTextRefCount = getOrderedTextRefs(canvas, node).length
	}

	let selectedMode: Mode | null = null
	let audioIntent: AudioIntent = 'speech'
	let audioVoiceSource: VoiceMode = orderedAudios.length > 0 ? 'reference' : 'builtin'
	let audioControlsInitialized = false

	// ── Define functions (all DOM elements exist now) ──

	function lastSelectionForCurrentType(): Record<string, unknown> | null {
		const nodeData = node.getData() as unknown
		const nodeLastGen = (nodeData.bragiLastGen || nodeData.ovidLastGen)?.[currentType]
		const globalLastKey = lastSelectionKey(currentType)
		const globalLast = (settings as unknown)[globalLastKey]
		return nodeLastGen || globalLast || null
	}

	function audioModelsFor(intent: AudioIntent, source: VoiceMode): ModelConfig[] {
		const audioModels = getModelsForType('audio')
		if (intent === 'music') return audioModels.filter(model => supportsAudioIntent(model, 'music'))
		return audioModels.filter(model => supportsAudioIntent(model, 'speech') && supportsVoiceSource(model, source))
	}

	function filteredModelsForCurrentSelection(): ModelConfig[] {
		if (currentType !== 'audio') return getModelsForType(currentType)
		return audioModelsFor(audioIntent, audioVoiceSource)
	}

	function normalizeAudioControls() {
		if (currentType !== 'audio') return
		const speechBuiltin = audioModelsFor('speech', 'builtin')
		const speechReference = orderedAudios.length > 0 ? audioModelsFor('speech', 'reference') : []
		const speechDesign = orderedTextRefCount > 0 ? audioModelsFor('speech', 'design') : []
		const musicModels = audioModelsFor('music', audioVoiceSource)

		if (audioIntent === 'music') {
			if (musicModels.length === 0 && (speechBuiltin.length > 0 || speechReference.length > 0 || speechDesign.length > 0)) {
				audioIntent = 'speech'
				audioVoiceSource = speechReference.length > 0 ? 'reference' : speechBuiltin.length > 0 ? 'builtin' : 'design'
			}
			return
		}

		if (audioVoiceSource === 'reference' && speechReference.length === 0) {
			audioVoiceSource = speechBuiltin.length > 0 ? 'builtin' : speechDesign.length > 0 ? 'design' : 'reference'
		}
		if (audioVoiceSource === 'design' && speechDesign.length === 0) {
			audioVoiceSource = speechBuiltin.length > 0 ? 'builtin' : speechReference.length > 0 ? 'reference' : 'design'
		}
		if (audioVoiceSource === 'builtin' && speechBuiltin.length === 0) {
			audioVoiceSource = speechReference.length > 0 ? 'reference' : speechDesign.length > 0 ? 'design' : 'builtin'
		}
		if (audioModelsFor('speech', audioVoiceSource).length === 0 && musicModels.length > 0) {
			audioIntent = 'music'
		}
	}

	function hydrateAudioControlsFromLastSelection() {
		if (currentType !== 'audio' || audioControlsInitialized) return
		const last = lastSelectionForCurrentType()
		const lastModel = last?.modelId
			? getModelsForType('audio').find(model => model.id === last.modelId)
			: null
		if (lastModel && audioIntentForModel(lastModel) === 'music') {
			audioIntent = 'music'
		} else {
			audioIntent = 'speech'
			audioVoiceSource = orderedAudios.length > 0 ? 'reference' : 'builtin'
		}
		normalizeAudioControls()
		audioControlsInitialized = true
	}

	function rebuildAudioSelectors() {
		if (currentType !== 'audio') {
			audioIntentSelect.classList.add('bragi-hidden')
			audioVoiceSourceSelect.classList.add('bragi-hidden')
			return
		}

		normalizeAudioControls()

		audioIntentSelect.classList.remove('bragi-hidden')
		audioIntentSelect.innerHTML = ''
		for (const [value, label] of [['speech', 'Speech'], ['music', 'Music']] as Array<[AudioIntent, string]>) {
			const opt = createEl('option')
			opt.value = value
			opt.textContent = label
			opt.disabled = value === 'speech'
				? audioModelsFor('speech', 'builtin').length === 0
					&& (orderedAudios.length === 0 || audioModelsFor('speech', 'reference').length === 0)
					&& (orderedTextRefCount === 0 || audioModelsFor('speech', 'design').length === 0)
				: audioModelsFor('music', audioVoiceSource).length === 0
			audioIntentSelect.appendChild(opt)
		}
		audioIntentSelect.value = audioIntent
		resizeAudioIntent()

		if (audioIntent !== 'speech') {
			audioVoiceSourceSelect.classList.add('bragi-hidden')
			return
		}

		audioVoiceSourceSelect.classList.remove('bragi-hidden')
		audioVoiceSourceSelect.innerHTML = ''
		const builtin = createEl('option')
		builtin.value = 'builtin'
		builtin.textContent = 'Built-in'
		builtin.disabled = audioModelsFor('speech', 'builtin').length === 0
		audioVoiceSourceSelect.appendChild(builtin)

		const custom = createEl('option')
		custom.value = 'reference'
		custom.textContent = 'Voice ref'
		custom.disabled = orderedAudios.length === 0 || audioModelsFor('speech', 'reference').length === 0
		audioVoiceSourceSelect.appendChild(custom)

		const design = createEl('option')
		design.value = 'design'
		design.textContent = 'Design'
		design.disabled = orderedTextRefCount === 0 || audioModelsFor('speech', 'design').length === 0
		audioVoiceSourceSelect.appendChild(design)

		audioVoiceSourceSelect.value = audioVoiceSource
		resizeAudioVoiceSource()
	}

	function rebuildModeList() {
		modeSelect.innerHTML = ''
		if (!selectedModel || selectedModel.modes.length <= 1) {
			modeSelect.classList.add('bragi-hidden')
			selectedMode = selectedModel?.modes[0] || null
			return
		}

		modeSelect.classList.remove('bragi-hidden')
		const inferred = inferMode(selectedModel.modes, upstreamImageCount, upstreamVideoCount)

		for (const mode of selectedModel.modes) {
			const opt = createEl('option')
			opt.value = mode
			opt.textContent = MODE_LABELS[mode] || mode
			modeSelect.appendChild(opt)
		}

		modeSelect.value = inferred
		selectedMode = inferred
		resizeMode()
	}

	function initDefaults(preserveDynamicVoice = true) {
		const prev = { ...paramValues }
		paramValues = {}
		if (!selectedModel) return
		for (const p of selectedModel.params) {
			// Keep current value if same param exists and value is valid in new model
			const canKeepDynamicVoice = preserveDynamicVoice && p.id === 'voice' && (p.options?.length || 0) === 0
			if (prev[p.id] !== undefined && (canKeepDynamicVoice || p.options?.some(o => o.value === String(prev[p.id])))) {
				paramValues[p.id] = prev[p.id]
			} else {
				paramValues[p.id] = p.default
			}
		}
		if (preserveDynamicVoice && typeof prev.voiceLabel === 'string') paramValues.voiceLabel = prev.voiceLabel
		applyInitialVoiceModeDefaults()
	}

	function applyInitialVoiceModeDefaults() {
		const config = voiceConfigFor(selectedModel)
		if (!selectedModel || selectedModel.type !== 'audio' || (!config.clone && !config.design)) {
			delete paramValues.voiceMode
			delete paramValues.voiceRefAudioIndex
			delete paramValues.voiceDesignTextIndex
			return
		}
		paramValues.voiceMode = currentType === 'audio' && audioIntent === 'speech'
			? audioVoiceSource
			: orderedAudios.length > 0 ? 'reference' : orderedTextRefCount > 0 && config.design ? 'design' : (config.builtin ? 'builtin' : 'reference')
		const rawIndex = typeof paramValues.voiceRefAudioIndex === 'number'
			? paramValues.voiceRefAudioIndex
			: parseInt(String(paramValues.voiceRefAudioIndex ?? '0'), 10)
		const maxIndex = Math.max(0, orderedAudios.length - 1)
		paramValues.voiceRefAudioIndex = Number.isFinite(rawIndex) ? Math.min(Math.max(rawIndex, 0), maxIndex) : 0
		const rawDesignIndex = typeof paramValues.voiceDesignTextIndex === 'number'
			? paramValues.voiceDesignTextIndex
			: parseInt(String(paramValues.voiceDesignTextIndex ?? '0'), 10)
		const maxDesignIndex = Math.max(0, orderedTextRefCount - 1)
		paramValues.voiceDesignTextIndex = Number.isFinite(rawDesignIndex) ? Math.min(Math.max(rawDesignIndex, 0), maxDesignIndex) : 0
	}

	function renderVoiceModeControl(config: { builtin: boolean; clone: boolean; design: boolean }) {
		const select = createEl('select')
		select.className = 'bragi-bar-select'
		select.title = 'Voice mode'

		const builtin = createEl('option')
		builtin.value = 'builtin'
		builtin.textContent = 'Built-in'
		builtin.disabled = !config.builtin
		select.appendChild(builtin)

		const custom = createEl('option')
		custom.value = 'reference'
		custom.textContent = 'Voice ref'
		custom.disabled = !config.clone || orderedAudios.length === 0
		select.appendChild(custom)

		const design = createEl('option')
		design.value = 'design'
		design.textContent = 'Design'
		design.disabled = !config.design || orderedTextRefCount === 0
		select.appendChild(design)

		select.value = String(paramValues.voiceMode || (config.builtin ? 'builtin' : config.clone ? 'reference' : 'design'))
		select.disabled = (!config.builtin && orderedAudios.length === 0 && (!config.design || orderedTextRefCount === 0))
		select.addEventListener('change', () => {
			paramValues.voiceMode = select.value
			rebuildParams()
			updateRunState()
		})
		paramsEl.appendChild(select)
		autoSizeSelect(select)
	}

	function renderVoiceReferenceSelect() {
		const select = createEl('select')
		select.className = 'bragi-bar-select'
		select.title = 'Voice reference'
		if (orderedAudios.length === 0) {
			const opt = createEl('option')
			opt.value = '0'
			opt.textContent = 'Connect audio'
			select.appendChild(opt)
			select.disabled = true
			paramValues.voiceRefAudioIndex = 0
		} else {
			for (let i = 0; i < orderedAudios.length; i++) {
				const opt = createEl('option')
				opt.value = String(i)
				opt.textContent = audioOrdinal(i)
				select.appendChild(opt)
			}
			const current = Math.min(
				Math.max(parseInt(String(paramValues.voiceRefAudioIndex ?? '0'), 10) || 0, 0),
				orderedAudios.length - 1,
			)
			paramValues.voiceRefAudioIndex = current
			select.value = String(current)
			select.addEventListener('change', () => {
				paramValues.voiceRefAudioIndex = parseInt(select.value, 10) || 0
				updateRunState()
			})
		}
		paramsEl.appendChild(select)
		autoSizeSelect(select)
	}

	function renderVoiceDesignPromptSelect() {
		const select = createEl('select')
		select.className = 'bragi-bar-select'
		select.title = 'Voice design prompt'
		if (orderedTextRefCount === 0) {
			const opt = createEl('option')
			opt.value = '0'
			opt.textContent = 'Connect text'
			select.appendChild(opt)
			select.disabled = true
			paramValues.voiceDesignTextIndex = 0
		} else {
			for (let i = 0; i < orderedTextRefCount; i++) {
				const opt = createEl('option')
				opt.value = String(i)
				opt.textContent = textOrdinal(i)
				select.appendChild(opt)
			}
			const current = Math.min(
				Math.max(parseInt(String(paramValues.voiceDesignTextIndex ?? '0'), 10) || 0, 0),
				orderedTextRefCount - 1,
			)
			paramValues.voiceDesignTextIndex = current
			select.value = String(current)
			select.addEventListener('change', () => {
				paramValues.voiceDesignTextIndex = parseInt(select.value, 10) || 0
				updateRunState()
			})
		}
		paramsEl.appendChild(select)
		autoSizeSelect(select)
	}

	function rebuildParams() {
		paramsEl.innerHTML = ''
		if (!selectedModel) return
		for (const param of selectedModel.params) {
			if (param.type === 'select' && param.options) {
				// Pick mode-specific options if declared; otherwise the base list.
				const effectiveOptions = (selectedMode && param.optionsByMode?.[selectedMode]) || param.options

				// If current value isn't valid in the new option set, snap back to default.
				const currentValue = String(paramValues[param.id] ?? param.default)
				const valid = effectiveOptions.some(o => o.value === currentValue)
				if (!valid && param.id !== 'voice') paramValues[param.id] = param.default

				if (param.id === 'voice') {
					const config = voiceConfigFor(selectedModel)
					if (config.clone || config.design) {
						applyInitialVoiceModeDefaults()
						if (currentType === 'audio' && audioIntent === 'speech') {
							if (audioVoiceSource === 'reference') {
								renderVoiceReferenceSelect()
								continue
							}
							if (audioVoiceSource === 'design') {
								renderVoiceDesignPromptSelect()
								continue
							}
						} else {
							renderVoiceModeControl(config)
						}
						if (selectedVoiceMode(paramValues) === 'reference') {
							renderVoiceReferenceSelect()
							continue
						}
						if (selectedVoiceMode(paramValues) === 'design') {
							renderVoiceDesignPromptSelect()
							continue
						}
					}
					const button = createEl('button')
					button.className = 'bragi-bar-voice-btn'
					button.title = param.label
					button.disabled = (config.clone || config.design) && !config.builtin
					const updateLabel = () => {
						button.textContent = voiceDisplayLabel(paramValues, effectiveOptions, param.default)
					}
					updateLabel()
					button.addEventListener('click', () => {
						if (!selectedModel) return
						const { provider, apiModelId } = resolveProvider(selectedModel, settings)
						const catalogProvider = catalogProviderFor(selectedModel, provider)
						new VoicePickerModal(app, {
							settings,
							model: selectedModel,
							activeProvider: provider,
							catalogProvider,
							apiModelId,
							currentVoice: String(paramValues[param.id] ?? ''),
							currentVoiceLabel: typeof paramValues.voiceLabel === 'string' ? paramValues.voiceLabel : '',
							staticOptions: effectiveOptions,
							voiceSource: 'builtin',
							onSelect: (voice) => {
								paramValues[param.id] = voice.id
								paramValues.voiceLabel = voice.name || voice.id
								updateLabel()
								updateRunState()
							},
						}).open()
					})
					paramsEl.appendChild(button)
					continue
				}

				const select = createEl('select')
				select.className = 'bragi-bar-select'
				select.title = param.label
				for (const opt of effectiveOptions) {
					const optEl = createEl('option')
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
				renderRangeParamDropdown(paramsEl, param, paramValues)
			} else if (param.type === 'number') {
				const input = createEl('input')
				input.type = 'number'
				input.className = 'bragi-bar-number'
				input.title = param.label
				if (param.min !== undefined) input.min = String(param.min)
				if (param.max !== undefined) input.max = String(param.max)
				if (param.step !== undefined) input.step = String(param.step)
				input.value = String(paramValues[param.id] ?? param.default)
				input.addEventListener('change', () => {
					const parsed = input.value.trim() ? parseFloat(input.value) : ''
					paramValues[param.id] = typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : ''
					updateRunState()
				})
				paramsEl.appendChild(input)
			}
		}
	}

	/**
	 * Check if a model can handle the current upstream inputs.
	 */
	function textUpstreamIssue(m: ModelConfig): string | null {
		if (m.type !== 'text') return null
		const { provider, apiModelId } = resolveProvider(m, settings)
		const capability = getTextInputCapability(m.id, provider, apiModelId)
		const checks = [
			{ kind: 'image' as const, count: upstreamImageCount },
			{ kind: 'pdf' as const, count: upstreamPdfCount },
			{ kind: 'video' as const, count: upstreamVideoCount },
			{ kind: 'audio' as const, count: upstreamAudioCount },
		]
		for (const { kind, count } of checks) {
			if (count > 0 && !textInputKindSupported(capability, kind)) {
				const label = kind === 'pdf' ? 'PDF' : kind
				return `Upstream ${label} not supported for ${m.name} via ${provider}`
			}
		}
		return null
	}

	function modelSupportsInputs(m: ModelConfig): boolean {
		if (m.type === 'text') return textUpstreamIssue(m) === null
		// Image models — always compatible for now
		if (m.type !== 'video') return true
		// No special inputs — only text-to-video models can run without refs.
		if (upstreamImageCount === 0 && upstreamVideoCount === 0) return m.modes.includes('text-to-video')
		// Has video input — needs a video-input mode
		if (upstreamVideoCount > 0) {
			return m.modes.includes('video-ref') || m.modes.includes('video-extend') || m.modes.includes('video-edit')
		}
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
		hydrateAudioControlsFromLastSelection()
		rebuildAudioSelectors()
		models = filteredModelsForCurrentSelection()

		if (models.length === 0) {
			const opt = createEl('option')
			opt.textContent = 'No models'
			opt.disabled = true
			modelSelect.appendChild(opt)
			selectedModel = null
		} else {
			let firstCompatible: ModelConfig | null = null
			for (const m of models) {
				const opt = createEl('option')
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
			const last = lastSelectionForCurrentType()
			const lastModel = last?.modelId ? models.find(m => m.id === last.modelId && modelSupportsInputs(m)) : null

			selectedModel = lastModel || firstCompatible || models[0]
			modelSelect.value = selectedModel.id
			savedParams = (lastModel && last?.params) ? last.params : null
		}

		resizeModel()
		initDefaults()
		rebuildModeList()

		// Restore saved params AFTER initDefaults (which resets to defaults)
		if (savedParams) {
			paramValues = { ...paramValues, ...savedParams }
			applyInitialVoiceModeDefaults()
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

	let savedParams: Record<string, unknown> | null = null

	function updateUpstreamMediaHint() {
		if (currentType !== 'text') {
			upstreamMediaHint.textContent = ''
			upstreamMediaHint.classList.add('bragi-bar-upstream-hint-hidden')
			return
		}
		const parts: string[] = []
		if (upstreamPdfCount > 0) parts.push(`${upstreamPdfCount} PDF`)
		if (upstreamVideoCount > 0) parts.push(`${upstreamVideoCount} video`)
		if (upstreamAudioCount > 0) parts.push(`${upstreamAudioCount} audio`)
		if (parts.length === 0) {
			upstreamMediaHint.textContent = ''
			upstreamMediaHint.classList.add('bragi-bar-upstream-hint-hidden')
			return
		}
		upstreamMediaHint.textContent = `Upstream: ${parts.join(', ')}`
		upstreamMediaHint.classList.remove('bragi-bar-upstream-hint-hidden')
	}

	// ── Run button state ──

	function updateRunState() {
		updateUpstreamMediaHint()
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

		const voiceConfig = voiceConfigFor(selectedModel)
		if (selectedModel?.type === 'audio' && selectedMode === 'tts' && (voiceConfig.clone || voiceConfig.design)) {
			if (selectedVoiceMode(paramValues) === 'reference') {
				if (orderedAudios.length === 0) {
					disabled = true
					title = 'Connect an upstream audio node to use a voice reference'
				}
			} else if (selectedVoiceMode(paramValues) === 'design') {
				if (orderedTextRefCount === 0) {
					disabled = true
					title = 'Connect an upstream text node to design a voice'
				}
			} else if (!voiceConfig.builtin) {
				disabled = true
				title = 'Choose voice ref or design.'
			}
		}

		if (selectedModel?.type === 'text') {
			const issue = textUpstreamIssue(selectedModel)
			if (issue) {
				disabled = true
				title = issue
			}
		}

		runBtn.disabled = disabled
		runBtn.title = title
		runBtn.style.opacity = disabled ? '0.4' : '1'
		runBtn.style.cursor = disabled ? 'not-allowed' : 'pointer'
	}

	// ── Wire up events ──

	audioIntentSelect.addEventListener('change', () => {
		audioIntent = audioIntentSelect.value === 'music' ? 'music' : 'speech'
		if (audioIntent === 'speech' && audioVoiceSource === 'reference' && orderedAudios.length === 0) {
			audioVoiceSource = 'builtin'
		}
		if (audioIntent === 'speech' && audioVoiceSource === 'design' && orderedTextRefCount === 0) {
			audioVoiceSource = 'builtin'
		}
		savedParams = null
		rebuildModelList()
		updateRunState()
	})

	audioVoiceSourceSelect.addEventListener('change', () => {
		audioVoiceSource = audioVoiceSourceSelect.value === 'reference'
			? 'reference'
			: audioVoiceSourceSelect.value === 'design'
				? 'design'
				: 'builtin'
		paramValues.voiceMode = audioVoiceSource
		savedParams = null
		rebuildModelList()
		updateRunState()
	})

	modelSelect.addEventListener('change', () => {
		selectedModel = models.find(m => m.id === modelSelect.value) || models[0]
		initDefaults(false)
		rebuildModeList()
		rebuildParams()
		updateRunState()
	})

	modeSelect.addEventListener('change', () => {
		selectedMode = (modeSelect.value as Mode) || null
		// Params may be mode-dependent (e.g. xAI video duration caps at 10s for image-ref).
		rebuildParams()
		updateRunState()
	})

	runBtn.addEventListener('click', (e) => {
		e.stopPropagation()
		e.preventDefault()

		void (async () => {
			let prompt = ''
			const nodeData = node.getData()
			if (nodeData.type === 'text') {
				prompt = node.text?.trim() || ''
			} else if (nodeData.type === 'file' && (nodeData as unknown).file?.endsWith('.md')) {
				const filePath = (nodeData as unknown).file
				const file = app.vault.getAbstractFileByPath(filePath)
				if (file) {
					prompt = (await app.vault.read(file as unknown)).trim()
				}
			}

			if (!prompt) {
				new Notice('Bragi canvas: no prompt found in this node')
				return
			}
			if (!selectedModel) {
				new Notice('Bragi canvas: no model selected')
				return
			}
			hideGenerateBar()
			const batchCount = parseInt(batchSelect.value) || 1

			// Save to global memory
			const lastKey = lastSelectionKey(currentType)
			;(settings as unknown)[lastKey] = {
				modelId: selectedModel.id,
				params: { ...paramValues },
				batchCount,
			}
			onSaveSettings?.()

			// Save to node metadata (persists in canvas JSON)
			const currentNodeData = node.getData() as unknown
			const bragiLastGen = currentNodeData.bragiLastGen || currentNodeData.ovidLastGen || {}
			bragiLastGen[currentType] = {
				modelId: selectedModel.id,
				params: { ...paramValues },
				batchCount,
			}
			// Write new key, drop the legacy one so it doesn't silently drift
			const rest = { ...currentNodeData }
			delete rest.ovidLastGen
			node.setData({ ...rest, bragiLastGen })

			// Resolve active provider and API model ID
			const { provider, apiModelId } = resolveProvider(selectedModel, settings)

			onSubmit({ prompt, model: selectedModel, activeProvider: provider, apiModelId, mode: selectedMode, params: paramValues, batchCount })
		})()
	})

	// ── Initialize ──

	// Register auto-sizers BEFORE first rebuild so rebuildModeList can call resizeMode()
	// after it programmatically fills options (.value = … doesn't fire `change`).
	const resizeAudioIntent = autoSizeSelect(audioIntentSelect)
	const resizeAudioVoiceSource = autoSizeSelect(audioVoiceSourceSelect)
	const resizeModel = autoSizeSelect(modelSelect)
	const resizeMode = autoSizeSelect(modeSelect)
	autoSizeSelect(batchSelect)

	rebuildModelList()

	// Restore last batch count (node metadata > global)
	const initNodeData = node.getData() as unknown
	const initNodeLast = (initNodeData.bragiLastGen || initNodeData.ovidLastGen)?.[currentType]
	const initGlobalKey = lastSelectionKey(currentType)
	const initGlobalLast = (settings as unknown)[initGlobalKey]
	const initLast = initNodeLast || initGlobalLast
	if (initLast?.batchCount) {
		batchSelect.value = String(initLast.batchCount)
	}

	updateRunState()

	// ── Attach to DOM ──

	const nodeCanvas = node.canvas
	let barParent: HTMLElement | null = null

	const menu = (nodeCanvas as unknown).menu
	if (menu?.menuEl?.parentElement) {
		barParent = menu.menuEl.parentElement
	}
	if (!barParent && nodeCanvas.wrapperEl?.parentElement) {
		barParent = nodeCanvas.wrapperEl.parentElement
	}
	if (!barParent) {
		barParent = activeDocument.body
		bar.classList.add('is-body-attached')
	}

	barParent.appendChild(bar)

	// ── Position tracking ──

	const nodeEl = getNodeElement(node)
	function updatePosition() {
		if (!activeBar) return
		const bounds = getSelectionBounds([node])
		if (!bounds) return
		positionNodeToolbar(activeBar, bounds, { placement: 'auto-below' })
		positionRAF = window.requestAnimationFrame(updatePosition)
	}
	positionRAF = window.requestAnimationFrame(updatePosition)

	// ── Auto-dismiss ──

	window.setTimeout(() => {
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

	function getModelsForType(t: GenerationType) {
		const orderKey = t
		return getEnabledModels(t, settings.modelOrder[orderKey], settings.modelPrefs, model => getConnectedConfiguredProviderIds(settings, model))
	}

	const allEnabled = allConfiguredModels(getModelsForType)
	if (allEnabled.length === 0) {
		new Notice('Bragi canvas: no models available. Add models in settings.')
		return
	}

	let currentType: GenerationType = type
	let models = getModelsForType(currentType)
	let selectedModel: ModelConfig | null = models[0] || null
	let paramValues: Record<string, string | number> = {}

	const bar = createDiv()
	bar.className = 'bragi-generate-bar'
	activeBar = bar
	bar.addEventListener('pointerdown', (e) => e.stopPropagation())
	bar.addEventListener('click', (e) => e.stopPropagation())

	const leftGroup = createDiv()
	leftGroup.className = 'bragi-bar-left'
	bar.appendChild(leftGroup)

	const modelSelect = createEl('select')
	modelSelect.className = 'bragi-bar-select'
	leftGroup.appendChild(modelSelect)

	const modeSelect = createEl('select')
	modeSelect.className = 'bragi-bar-select'
	leftGroup.appendChild(modeSelect)

	const rightGroup = createDiv()
	rightGroup.className = 'bragi-bar-right'
	bar.appendChild(rightGroup)

	const paramsEl = createDiv()
	paramsEl.className = 'bragi-bar-params'
	rightGroup.appendChild(paramsEl)

	const batchSelect = createEl('select')
	batchSelect.className = 'bragi-bar-select'
	batchSelect.title = 'Count'
	for (const n of [1, 2, 3, 4]) {
		const opt = createEl('option')
		opt.value = String(n)
		opt.textContent = `x${n}`
		batchSelect.appendChild(opt)
	}
	batchSelect.value = '1'
	rightGroup.appendChild(batchSelect)

	const runBtn = createEl('button')
	runBtn.className = 'bragi-bar-run'
	runBtn.textContent = `Run (${nodes.length})`
	rightGroup.appendChild(runBtn)

	let selectedMode: Mode | null = null

	function rebuildModeList() {
		modeSelect.innerHTML = ''
		if (!selectedModel || selectedModel.modes.length <= 1) {
			modeSelect.classList.add('bragi-hidden')
			selectedMode = selectedModel?.modes[0] || null
			return
		}
		modeSelect.classList.remove('bragi-hidden')
		for (const mode of selectedModel.modes) {
			const opt = createEl('option')
			opt.value = mode
			opt.textContent = MODE_LABELS[mode] || mode
			modeSelect.appendChild(opt)
		}
		selectedMode = selectedModel.modes[0]
		modeSelect.value = selectedMode
		resizeMode()
	}

	function initDefaults(preserveDynamicVoice = true) {
		const prev = { ...paramValues }
		paramValues = {}
		if (!selectedModel) return
		for (const p of selectedModel.params) {
			const canKeepDynamicVoice = preserveDynamicVoice && p.id === 'voice' && (p.options?.length || 0) === 0
			if (prev[p.id] !== undefined && (canKeepDynamicVoice || p.options?.some(o => o.value === String(prev[p.id])))) {
				paramValues[p.id] = prev[p.id]
			} else {
				paramValues[p.id] = p.default
			}
		}
		if (preserveDynamicVoice && typeof prev.voiceLabel === 'string') paramValues.voiceLabel = prev.voiceLabel
	}

	function rebuildParams() {
		paramsEl.innerHTML = ''
		if (!selectedModel) return
		for (const param of selectedModel.params) {
			if (param.type === 'select' && param.options) {
				const effectiveOptions = (selectedMode && param.optionsByMode?.[selectedMode]) || param.options
				const currentValue = String(paramValues[param.id] ?? param.default)
				if (!effectiveOptions.some(o => o.value === currentValue) && param.id !== 'voice') paramValues[param.id] = param.default

				if (param.id === 'voice') {
						const config = voiceConfigFor(selectedModel)
						const button = createEl('button')
						button.className = 'bragi-bar-voice-btn'
						button.title = param.label
						button.disabled = (config.clone || config.design) && !config.builtin
						const updateLabel = () => {
							button.textContent = (config.clone || config.design) && !config.builtin
								? 'Single node only'
								: voiceDisplayLabel(paramValues, effectiveOptions, param.default)
						}
					updateLabel()
					button.addEventListener('click', () => {
						if (button.disabled) return
						if (!selectedModel) return
						const { provider, apiModelId } = resolveProvider(selectedModel, settings)
						const catalogProvider = catalogProviderFor(selectedModel, provider)
						new VoicePickerModal(app, {
							settings,
							model: selectedModel,
							activeProvider: provider,
							catalogProvider,
							apiModelId,
							currentVoice: String(paramValues[param.id] ?? ''),
							currentVoiceLabel: typeof paramValues.voiceLabel === 'string' ? paramValues.voiceLabel : '',
							staticOptions: effectiveOptions,
							voiceSource: 'builtin',
							onSelect: (voice) => {
								paramValues[param.id] = voice.id
								paramValues.voiceLabel = voice.name || voice.id
								updateLabel()
							},
						}).open()
					})
					paramsEl.appendChild(button)
					continue
				}

				const select = createEl('select')
				select.className = 'bragi-bar-select'
				select.title = param.label
				for (const opt of effectiveOptions) {
					const optEl = createEl('option')
					optEl.value = opt.value
					optEl.textContent = opt.label
					select.appendChild(optEl)
				}
				select.value = String(paramValues[param.id] ?? param.default)
				select.addEventListener('change', () => { paramValues[param.id] = select.value })
				paramsEl.appendChild(select)
				autoSizeSelect(select)
			} else if (param.type === 'range') {
				renderRangeParamDropdown(paramsEl, param, paramValues)
			} else if (param.type === 'number') {
				const input = createEl('input')
				input.type = 'number'
				input.className = 'bragi-bar-number'
				input.title = param.label
				if (param.min !== undefined) input.min = String(param.min)
				if (param.max !== undefined) input.max = String(param.max)
				if (param.step !== undefined) input.step = String(param.step)
				input.value = String(paramValues[param.id] ?? param.default)
				input.addEventListener('change', () => {
					const parsed = input.value.trim() ? parseFloat(input.value) : ''
					paramValues[param.id] = typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : ''
				})
				paramsEl.appendChild(input)
			}
		}
	}

	function rebuildModelList() {
		modelSelect.innerHTML = ''
		models = getModelsForType(currentType)
		if (models.length === 0) {
			const opt = createEl('option')
			opt.textContent = 'No models'
			opt.disabled = true
			modelSelect.appendChild(opt)
			selectedModel = null
		} else {
			for (const m of models) {
				const opt = createEl('option')
				opt.value = m.id
				opt.textContent = m.name
				modelSelect.appendChild(opt)
			}
			const globalLastKey = lastSelectionKey(currentType)
			const globalLast = (settings as unknown)[globalLastKey]
			const lastModel = globalLast?.modelId ? models.find(m => m.id === globalLast.modelId) : null
			selectedModel = lastModel || models[0]
			modelSelect.value = selectedModel.id
		}
		resizeModel()
		initDefaults()
		rebuildModeList()
		rebuildParams()
		updateRunState()
	}

	function updateRunState() {
		const config = voiceConfigFor(selectedModel)
		const disabled = !!(selectedModel?.type === 'audio' && selectedMode === 'tts' && (config.clone || config.design) && !config.builtin)
		runBtn.disabled = disabled
		runBtn.title = disabled ? 'This model requires a single-node voice source.' : ''
		runBtn.style.opacity = disabled ? '0.4' : '1'
		runBtn.style.cursor = disabled ? 'not-allowed' : 'pointer'
	}

	modelSelect.addEventListener('change', () => {
		selectedModel = models.find(m => m.id === modelSelect.value) || models[0]
		initDefaults(false)
		rebuildModeList()
		rebuildParams()
		updateRunState()
	})

	modeSelect.addEventListener('change', () => {
		selectedMode = (modeSelect.value as Mode) || null
		rebuildParams()
		updateRunState()
	})

	runBtn.addEventListener('click', (e) => {
		e.stopPropagation()
		e.preventDefault()
		if (!selectedModel) {
			new Notice('Bragi canvas: no model selected')
			return
		}
		hideGenerateBar()

		const batchCount = parseInt(batchSelect.value) || 1
		const lastKey = lastSelectionKey(currentType)
		;(settings as unknown)[lastKey] = {
			modelId: selectedModel.id,
			params: { ...paramValues },
			batchCount,
		}
		onSaveSettings?.()

		const { provider, apiModelId } = resolveProvider(selectedModel, settings)

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

	const resizeModel = autoSizeSelect(modelSelect)
	const resizeMode = autoSizeSelect(modeSelect)
	autoSizeSelect(batchSelect)

	rebuildModelList()

	const globalLastKey = lastSelectionKey(currentType)
	const globalLast = (settings as unknown)[globalLastKey]
	if (globalLast?.batchCount) batchSelect.value = String(globalLast.batchCount)

	// Attach to DOM — use the first node's canvas
	const nodeCanvas = nodes[0].canvas
	let barParent: HTMLElement | null = null
	const menu = (nodeCanvas as unknown)?.menu
	if (menu?.menuEl?.parentElement) barParent = menu.menuEl.parentElement
	if (!barParent && nodeCanvas?.wrapperEl?.parentElement) barParent = nodeCanvas.wrapperEl.parentElement
	if (!barParent) { barParent = activeDocument.body; bar.classList.add('is-body-attached') }
	barParent.appendChild(bar)

	function updatePosition() {
		if (!activeBar) return
		const bounds = getSelectionBounds(nodes)
		if (!bounds) return
		positionNodeToolbar(activeBar, bounds, { placement: 'auto-below' })
		positionRAF = window.requestAnimationFrame(updatePosition)
	}
	positionRAF = window.requestAnimationFrame(updatePosition)

	// Auto-dismiss
	window.setTimeout(() => {
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
		window.cancelAnimationFrame(positionRAF)
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

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

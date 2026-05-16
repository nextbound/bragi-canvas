import { Modal, Notice, setIcon, setTooltip } from 'obsidian'
import type { App } from 'obsidian'
import type { BragiSettings } from '../settings'
import type { ModelConfig, ParamOption } from '../models/types'
import type { AudioProvider, VoiceOption } from '../providers/types'
import { getProvider } from '../providers/registry'
import { listPublicVoiceSamples } from '../voice-samples'

type FilterKey = 'language' | 'gender' | 'age' | 'tag'

export interface VoicePickerModalOptions {
	settings: BragiSettings
	model: ModelConfig
	activeProvider: string
	catalogProvider?: string
	apiModelId: string
	currentVoice?: string
	currentVoiceLabel?: string
	staticOptions?: ParamOption[]
	voiceSource?: 'builtin' | 'custom' | 'all'
	onSelect: (voice: VoiceOption) => void
}

export class VoicePickerModal extends Modal {
	private voices: VoiceOption[] = []
	private query = ''
	private filters: Record<FilterKey, string> = {
		language: '',
		gender: '',
		age: '',
		tag: '',
	}
	private controlsEl!: HTMLElement
	private listEl!: HTMLElement
	private filterEls = new Map<FilterKey, HTMLSelectElement>()
	private audio: HTMLAudioElement | null = null
	private audioProvider: AudioProvider | null = null

	constructor(app: App, private opts: VoicePickerModalOptions) {
		super(app)
	}

	onOpen(): void {
		this.modalEl.classList.add('bragi-modal', 'bragi-voice-picker-modal')
		this.titleEl.setText('Choose voice')
		this.renderShell()
		void this.loadVoices()
	}

	onClose(): void {
		this.audio?.pause()
		this.audio = null
		this.contentEl.empty()
	}

	private renderShell(): void {
		const { contentEl } = this
		contentEl.empty()
		this.filterEls.clear()

		this.controlsEl = contentEl.createDiv({ cls: 'bragi-voice-controls bragi-hidden' })

		const searchRow = this.controlsEl.createDiv({ cls: 'bragi-voice-search-row' })
		const search = searchRow.createEl('input', {
			type: 'text',
			placeholder: 'Search voices...',
			cls: 'bragi-voice-search',
		})
		search.addEventListener('input', () => {
			this.query = search.value
			this.renderList()
		})

		const filterRow = this.controlsEl.createDiv({ cls: 'bragi-voice-filter-row' })
		for (const key of ['language', 'gender', 'age', 'tag'] as FilterKey[]) {
			const select = filterRow.createEl('select', { cls: 'bragi-voice-filter' })
			select.title = key
			select.addEventListener('change', () => {
				this.filters[key] = select.value
				this.renderList()
			})
			this.filterEls.set(key, select)
		}

		this.listEl = contentEl.createDiv({ cls: 'bragi-voice-list' })
		this.listEl.createDiv({ cls: 'bragi-voice-empty', text: 'Loading voices...' })
	}

	private async loadVoices(): Promise<void> {
		const staticVoices = (this.opts.staticOptions || []).map(opt => ({
			id: opt.value,
			name: opt.label,
			source: 'builtin' as const,
		}))

		const spec = getProvider(this.opts.catalogProvider || this.opts.activeProvider)
		const provider = spec?.makeAudio?.({
			settings: this.opts.settings,
			app: this.app,
			outputDir: this.opts.settings.outputDir || 'assets',
		})
		this.audioProvider = provider || null

		this.voices = await this.resolveVoices(staticVoices)
		this.controlsEl.classList.remove('bragi-hidden')
		this.renderFilters()
		this.renderList()
	}

	private async resolveVoices(staticVoices: VoiceOption[]): Promise<VoiceOption[]> {
		const source = this.opts.voiceSource || 'builtin'
		if (source !== 'custom') {
			try {
				const publicVoices = await listPublicVoiceSamples(this.opts.model.id)
				if (publicVoices.length > 0) return publicVoices
			} catch {
				// Public samples are optional; provider/static voices remain valid fallbacks.
			}
		}

		const providerVoices = await this.listProviderVoices(source)
		if (source === 'custom') return providerVoices
		const fallbackVoices = mergeVoices([...staticVoices, ...providerVoices])
		return fallbackVoices.length > 0 ? fallbackVoices : staticVoices
	}

	private async listProviderVoices(source: 'builtin' | 'custom' | 'all'): Promise<VoiceOption[]> {
		if (!this.audioProvider?.listVoices) return []
		try {
			return await this.audioProvider.listVoices({
				modelId: this.opts.apiModelId,
				bragiModelId: this.opts.model.id,
				source: source === 'all' ? 'builtin' : source,
			})
		} catch (err: unknown) {
			new Notice(`Voice list failed: ${errorMessage(err)}`, 6000)
			return []
		}
	}

	private renderFilters(): void {
		for (const [key, select] of this.filterEls) {
			const current = this.filters[key]
			select.empty()
			select.createEl('option', { text: labelForFilter(key), value: '' })
			for (const value of uniqueFilterValues(this.voices, key)) {
				select.createEl('option', { text: value, value })
			}
			select.value = current
		}
	}

	private renderList(): void {
		this.listEl.empty()
		const query = this.query.trim().toLowerCase()
		const matches = this.voices.filter(voice => {
			if (query) {
				const haystack = [
					voice.id,
					voice.name,
					voice.description,
					voice.gender,
					voice.age,
					voice.language,
					voice.category,
					voice.tags,
				].join(' ').toLowerCase()
				if (!haystack.includes(query)) return false
			}
			for (const key of Object.keys(this.filters) as FilterKey[]) {
				const filter = this.filters[key]
				if (filter && !voiceMatchesFilter(voice, key, filter)) return false
			}
			return true
		})

		if (matches.length === 0) {
			this.listEl.createDiv({ cls: 'bragi-voice-empty', text: 'No voices found.' })
			return
		}

		for (const voice of matches) {
			this.renderVoiceRow(voice)
		}
	}

	private renderVoiceRow(voice: VoiceOption): void {
		const row = this.listEl.createDiv({ cls: 'bragi-voice-row' })
		if (voice.id === this.opts.currentVoice) row.classList.add('is-selected')
		row.addEventListener('dblclick', () => this.selectVoice(voice))

		const info = row.createDiv({ cls: 'bragi-voice-info' })
		const title = info.createDiv({ cls: 'bragi-voice-title' })
		title.createSpan({ text: voice.name || voice.id })
		title.title = voice.id
		info.createDiv({
			cls: `bragi-voice-desc${voice.description ? '' : ' is-placeholder'}`,
			text: voice.description || 'No description yet',
		})

		const badges = info.createDiv({ cls: 'bragi-voice-badges' })
		for (const label of badgeLabelsForVoice(voice)) {
			badges.createSpan({ cls: 'bragi-voice-badge', text: label })
		}

		const actions = row.createDiv({ cls: 'bragi-voice-actions' })

		const preview = actions.createEl('button', { cls: 'bragi-icon-btn bragi-voice-preview' })
		setIcon(preview, 'play')
		if (voice.previewUrl) {
			setTooltip(preview, 'Preview')
			preview.addEventListener('click', (e) => {
				e.stopPropagation()
				preview.disabled = true
				void this.playPreview(voice).finally(() => {
					if (preview.isConnected) preview.disabled = false
				})
			})
		} else {
			preview.disabled = true
			setTooltip(preview, 'No preview sample')
		}

		const select = actions.createEl('button', { text: 'Select', cls: 'mod-cta bragi-voice-select' })
		select.addEventListener('click', (e) => {
			e.stopPropagation()
			this.selectVoice(voice)
		})
	}

	private async playPreview(voice: VoiceOption): Promise<void> {
		if (!voice.previewUrl) return
		this.audio?.pause()
		this.audio = new Audio(voice.previewUrl)
		await this.audio.play().catch((err: unknown) => {
			new Notice(`Preview failed: ${errorMessage(err)}`)
		})
	}

	private selectVoice(voice: VoiceOption): void {
		this.opts.onSelect(voice)
		this.close()
	}
}

function mergeVoices(voices: VoiceOption[]): VoiceOption[] {
	const byId = new Map<string, VoiceOption>()
	for (const voice of voices) byId.set(voice.id, { ...byId.get(voice.id), ...voice })
	return [...byId.values()]
}

function uniqueFilterValues(voices: VoiceOption[], key: FilterKey): string[] {
	const values = new Set<string>()
	for (const voice of voices) {
		for (const value of filterValuesForVoice(voice, key)) values.add(value)
	}
	return [...values].sort((a, b) => a.localeCompare(b))
}

function labelForFilter(key: FilterKey): string {
	if (key === 'gender') return 'All genders'
	if (key === 'age') return 'All ages'
	if (key === 'language') return 'All languages'
	return 'All tags'
}

function filterValuesForVoice(voice: VoiceOption, key: FilterKey): string[] {
	if (key === 'tag') return stringValues(voice.tags)
	return stringValues(voice[key])
}

function voiceMatchesFilter(voice: VoiceOption, key: FilterKey, filter: string): boolean {
	return filterValuesForVoice(voice, key).some(value => value === filter)
}

function badgeLabelsForVoice(voice: VoiceOption): string[] {
	const labels: string[] = []
	for (const value of firstValues(voice.language, 2)) labels.push(value)
	if (voice.gender) labels.push(voice.gender)
	if (voice.age) labels.push(voice.age)
	for (const value of firstValues(voice.tags, 2)) labels.push(value)
	return labels.slice(0, 6)
}

function firstValues(value: string | string[] | undefined, limit: number): string[] {
	return stringValues(value).slice(0, limit)
}

function stringValues(value: string | string[] | undefined): string[] {
	if (typeof value === 'string') return value.trim() ? [value.trim()] : []
	if (!Array.isArray(value)) return []
	return value.map(item => item.trim()).filter(Boolean)
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err)
}

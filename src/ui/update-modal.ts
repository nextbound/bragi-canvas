import { App, Modal } from 'obsidian'
import type { AvailablePluginUpdate } from '../update-check'

const OBSIDIAN_PLUGIN_URL = 'obsidian://show-plugin?id=bragi-canvas'

export interface UpdateReminderModalOptions {
	update: AvailablePluginUpdate
	onSuppress: () => void | Promise<void>
	onClosed?: () => void
}

export class UpdateReminderModal extends Modal {
	private didSuppress = false

	constructor(app: App, private opts: UpdateReminderModalOptions) {
		super(app)
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this
		modalEl.classList.add('bragi-modal', 'bragi-update-modal')
		titleEl.setText('Update available')

		contentEl.createEl('p', {
			text: `Bragi Canvas ${this.opts.update.latestVersion} is available. You are using ${this.opts.update.currentVersion}.`,
		})
		if (this.opts.update.releaseName) {
			contentEl.createEl('p', {
				cls: 'setting-item-description',
				text: this.opts.update.releaseName,
			})
		}
		contentEl.createEl('p', {
			text: `Click update, then follow Obsidian's community plugins update flow if prompted.`,
		})

		const releaseLink = contentEl.createEl('a', {
			text: 'Release notes',
			href: this.opts.update.releaseUrl,
		})
		releaseLink.addEventListener('click', (event) => {
			event.preventDefault()
			window.open(this.opts.update.releaseUrl, '_blank')
		})

		const row = contentEl.createDiv({ cls: 'modal-button-container' })
		const laterBtn = row.createEl('button', { text: 'Later' })
		laterBtn.addEventListener('click', () => this.close())

		const updateBtn = row.createEl('button', { text: 'Update', cls: 'mod-cta' })
		updateBtn.addEventListener('click', () => {
			window.open(OBSIDIAN_PLUGIN_URL, '_blank')
			this.close()
		})
	}

	onClose(): void {
		this.contentEl.empty()
		this.suppress()
		this.opts.onClosed?.()
	}

	private suppress(): void {
		if (this.didSuppress) return
		this.didSuppress = true
		void Promise.resolve(this.opts.onSuppress()).catch(err => {
			console.error('Bragi Canvas: failed to save update reminder state', err)
		})
	}
}

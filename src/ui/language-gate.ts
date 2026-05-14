import { App, Modal, getLanguage } from 'obsidian'

interface AppWithPluginControls extends App {
	plugins?: {
		disablePlugin(id: string): Promise<void>
	}
}

/**
 * Bragi Canvas relies on Obsidian's built-in English aria-labels for many of
 * its UI enhancements (icon replacement, card menu buttons, etc.). Non-English
 * locales break these hooks. Instead of quietly half-working, we refuse to load
 * and ask the user to switch.
 *
 * Returns true iff the user is running English / English (GB).
 */
export function isSupportedLanguage(): boolean {
	const lang = getLanguage() || ''
	return lang === '' || lang === 'en' || lang === 'en-GB'
}

export class LanguageGateModal extends Modal {
	constructor(app: App, private pluginId: string) {
		super(app)
	}

	onOpen() {
		const { contentEl, titleEl, modalEl } = this
		modalEl.classList.add('bragi-modal', 'bragi-language-gate')
		titleEl.setText('Bragi canvas needs english')

		contentEl.createEl('p', {
			text: 'Bragi canvas relies on Obsidian being in english. Please switch Obsidian to english or english (gb), then restart Obsidian.',
		})

		const row = contentEl.createDiv({ cls: 'modal-button-container' })

		const disable = row.createEl('button', { text: 'Disable plugin' })
		disable.addEventListener('click', () => {
			void (async () => {
				try {
					await (this.app as AppWithPluginControls).plugins?.disablePlugin(this.pluginId)
				} catch (err) {
					console.error('Bragi: failed to disable plugin', err)
				}
				this.close()
			})()
		})

		const closeBtn = row.createEl('button', { text: 'Close', cls: 'mod-cta' })
		closeBtn.addEventListener('click', () => this.close())
	}

	onClose() {
		this.contentEl.empty()
	}
}

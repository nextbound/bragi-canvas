/* eslint-disable obsidianmd/ui/sentence-case, obsidianmd/prefer-get-language -- Bragi preserves exact copy; getLanguage requires Obsidian 1.8.7 but minAppVersion is 1.5.0. */
import { App, Modal } from 'obsidian'

/**
 * Bragi Canvas relies on Obsidian's built-in English aria-labels for many of
 * its UI enhancements (icon replacement, card menu buttons, etc.). Non-English
 * locales break these hooks. Instead of quietly half-working, we refuse to load
 * and ask the user to switch.
 *
 * Returns true iff the user is running English / English (GB).
 */
export function isSupportedLanguage(): boolean {
	const lang = window.localStorage.getItem('language') || ''
	return lang === '' || lang === 'en' || lang === 'en-GB'
}

export class LanguageGateModal extends Modal {
	constructor(app: App, private pluginId: string) {
		super(app)
	}

	onOpen() {
		const { contentEl, titleEl, modalEl } = this
		modalEl.classList.add('bragi-modal', 'bragi-language-gate')
		titleEl.setText('Bragi Canvas needs English')

		contentEl.createEl('p', {
			text: 'Bragi Canvas relies on Obsidian being in English. Please switch your language to English or English (GB), then restart Obsidian.',
		})

		const row = contentEl.createDiv({ cls: 'modal-button-container' })

		const disable = row.createEl('button', { text: 'Disable plugin' })
		disable.addEventListener('click', () => {
			void (async () => {
				try {
					await (this.app as unknown).plugins.disablePlugin(this.pluginId)
				} catch (err) {
					console.error('Bragi: failed to disable plugin', err)
				}
				this.close()
			})()
		})

		const switchBtn = row.createEl('button', { text: 'Switch to English & restart', cls: 'mod-cta' })
		switchBtn.addEventListener('click', () => {
			try {
				window.localStorage.setItem('language', 'en')
			} catch (err) {
				console.error('Bragi: failed to set language', err)
			}
			// Relaunch Obsidian via Electron
			try {
				const remote = (window as unknown).require?.('@electron/remote')
					?? (window as unknown).require?.('electron')?.remote
				if (remote?.app) {
					remote.app.relaunch()
					remote.app.exit(0)
					return
				}
			} catch (err) {
				console.error('Bragi: relaunch failed', err)
			}
			// Fallback: full page reload
			window.location.reload()
		})
	}

	onClose() {
		this.contentEl.empty()
	}
}

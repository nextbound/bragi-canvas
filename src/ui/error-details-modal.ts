import { Modal, Notice, type App } from 'obsidian'
import type { CanvasNode } from '../types/canvas-internal'

export function getNodeErrorDetails(node: CanvasNode): string {
	const d = node.getData() as { bragiGenError?: string }
	const error = d.bragiGenError?.trim()
	return error || 'No error details available.'
}

export class ErrorDetailsModal extends Modal {
	constructor(app: App, private readonly errorMessage: string) {
		super(app)
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this
		modalEl.classList.add('bragi-modal')
		titleEl.setText('Error Details')

		const body = contentEl.createEl('pre', { cls: 'bragi-error-details-body' })
		body.textContent = this.errorMessage

		const row = contentEl.createDiv({ cls: 'modal-button-container' })
		const copyBtn = row.createEl('button', { text: 'Copy', cls: 'mod-cta' })
		const closeBtn = row.createEl('button', { text: 'Close' })
		copyBtn.addEventListener('click', () => {
			void navigator.clipboard.writeText(this.errorMessage).then(() => {
				new Notice('Error details copied')
			})
		})
		closeBtn.addEventListener('click', () => this.close())
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

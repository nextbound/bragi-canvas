import { Modal, type App } from 'obsidian'
import type { CanvasNode } from '../types/canvas-internal'

export function getNodeErrorDetails(node: CanvasNode): string {
	const d = node.getData()
	const detail = d.bragiGenerating === true ? d.bragiGenDetail : d.bragiGenError
	return typeof detail === 'string' && detail.trim() ? detail.trim() : 'No details available.'
}

export function getNodeDetailsTitle(node: CanvasNode): string {
	return node.getData().bragiGenerating === true ? 'Checking details' : 'Error details'
}

export function openNodeDetails(node: CanvasNode): void {
	new ErrorDetailsModal(node.app, getNodeErrorDetails(node), getNodeDetailsTitle(node)).open()
}

export class ErrorDetailsModal extends Modal {
	constructor(app: App, private readonly errorMessage: string, private readonly heading = 'Error details') {
		super(app)
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this
		modalEl.classList.add('bragi-modal')
		titleEl.setText(this.heading)

		const body = contentEl.createEl('pre', { cls: 'bragi-error-details-body' })
		body.textContent = this.errorMessage

		const row = contentEl.createDiv({ cls: 'modal-button-container' })
		const closeBtn = row.createEl('button', { text: 'Close', cls: 'mod-cta' })
		closeBtn.addEventListener('click', () => this.close())
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

import { App, TFile } from 'obsidian'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'])
const PREVIEW_CLASS = 'bragi-file-hover-preview'
const OFFSET = 14

function isImageFile(file: TFile): boolean {
	return IMAGE_EXTENSIONS.has(file.extension.toLowerCase())
}

function findFileTitle(target: EventTarget | null): HTMLElement | null {
	if (!target || !(target instanceof HTMLElement)) return null
	return target.closest<HTMLElement>('.nav-file-title[data-path]')
}

function positionPreview(previewEl: HTMLElement, event: MouseEvent): void {
	const margin = 12
	const rect = previewEl.getBoundingClientRect()
	let left = event.clientX + OFFSET
	let top = event.clientY + OFFSET

	if (left + rect.width + margin > window.innerWidth) {
		left = event.clientX - rect.width - OFFSET
	}
	if (top + rect.height + margin > window.innerHeight) {
		top = window.innerHeight - rect.height - margin
	}

	previewEl.style.left = `${Math.max(margin, left)}px`
	previewEl.style.top = `${Math.max(margin, top)}px`
}

export function startFileHoverPreview(app: App): () => void {
	let previewEl: HTMLElement | null = null
	let currentPath = ''

	const removePreview = (): void => {
		previewEl?.remove()
		previewEl = null
		currentPath = ''
	}

	const showPreview = (file: TFile, event: MouseEvent): void => {
		if (currentPath === file.path && previewEl) {
			positionPreview(previewEl, event)
			return
		}

		removePreview()
		currentPath = file.path

		const wrapper = createDiv({ cls: PREVIEW_CLASS })
		const image = wrapper.createEl('img')
		image.src = app.vault.adapter.getResourcePath(file.path)
		image.alt = file.basename
		wrapper.createDiv({ cls: 'bragi-file-hover-preview-name', text: file.name })
		activeDocument.body.appendChild(wrapper)
		previewEl = wrapper
		positionPreview(wrapper, event)
	}

	const onMouseMove = (event: MouseEvent): void => {
		const titleEl = findFileTitle(event.target)
		if (!titleEl) {
			removePreview()
			return
		}

		const path = titleEl.dataset.path || ''
		const file = app.vault.getAbstractFileByPath(path)
		if (!(file instanceof TFile) || !isImageFile(file)) {
			removePreview()
			return
		}

		showPreview(file, event)
	}

	const onScroll = (): void => {
		removePreview()
	}

	activeDocument.addEventListener('mousemove', onMouseMove, true)
	activeDocument.addEventListener('scroll', onScroll, true)
	window.addEventListener('blur', removePreview)

	return () => {
		activeDocument.removeEventListener('mousemove', onMouseMove, true)
		activeDocument.removeEventListener('scroll', onScroll, true)
		window.removeEventListener('blur', removePreview)
		removePreview()
	}
}

/** DotmSquare19 loader + centered elapsed + bottom model pill. */

import { buildSquare19Grid, mountSquare19Loader, stopSquare19Loader } from './dotm-square-19'
import { setIcon, setTooltip } from 'obsidian'

export interface GeneratingStatus {
	label: string
	detail?: string
	paused?: boolean
	retryAt?: number
	onResume?: () => void
}

export interface GeneratingOverlayElements {
	overlayEl: HTMLDivElement
	loaderEl: HTMLDivElement
	modelEl: HTMLSpanElement
	elapsedEl: HTMLDivElement
	statusEl: HTMLDivElement
	detailEl: HTMLDivElement
	pausedEl: HTMLDivElement
	resumeEl: HTMLButtonElement
}

export function createGeneratingOverlay(): GeneratingOverlayElements {
	const overlayEl = createDiv({ cls: 'bragi-generating-overlay' })
	const center = overlayEl.createDiv({ cls: 'bragi-generating-center' })
	const loaderEl = center.createDiv({ cls: 'bragi-generating-loader bragi-dmx-root bragi-dotm-square-19' })
	loaderEl.setAttr('role', 'status')
	loaderEl.setAttr('aria-label', 'Loading')
	buildSquare19Grid(loaderEl)
	mountSquare19Loader(loaderEl)
	const pausedEl = center.createDiv({ cls: 'bragi-generating-paused-icon bragi-hidden' })
	setIcon(pausedEl, 'pause-circle')
	const statusEl = center.createDiv({ cls: 'bragi-generating-status' })
	const detailEl = center.createDiv({ cls: 'bragi-generating-detail bragi-hidden' })
	const elapsedEl = center.createDiv({ cls: 'bragi-generating-elapsed' })
	const footer = overlayEl.createDiv({ cls: 'bragi-generating-footer' })
	const pill = footer.createDiv({ cls: 'bragi-generating-model-pill' })
	const modelEl = pill.createSpan({ cls: 'bragi-generating-model' })
	const resumeEl = footer.createEl('button', { cls: 'bragi-generating-resume bragi-hidden' })
	resumeEl.type = 'button'
	resumeEl.setAttr('aria-label', 'Resume checking')
	setIcon(resumeEl, 'rotate-cw')
	setTooltip(resumeEl, 'Resume checking', { placement: 'top' })
	resumeEl.addEventListener('pointerdown', event => event.stopPropagation())
	return { overlayEl, loaderEl, modelEl, elapsedEl, statusEl, detailEl, pausedEl, resumeEl }
}

export function formatGeneratingElapsed(startedAt: number): string {
	const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
	return `${elapsed}s`
}

export function updateGeneratingOverlay(
	elements: GeneratingOverlayElements,
	modelName: string,
	startedAt: number,
	status: GeneratingStatus = { label: 'Generating' },
): void {
	elements.modelEl.textContent = modelName
	elements.elapsedEl.textContent = formatGeneratingElapsed(startedAt)
	elements.statusEl.textContent = status.retryAt
		? `Retrying in ${Math.max(0, Math.ceil((status.retryAt - Date.now()) / 1000))}s`
		: status.label
	elements.detailEl.textContent = status.detail || ''
	elements.detailEl.title = status.detail || ''
	elements.detailEl.classList.toggle('bragi-hidden', !status.detail)
	elements.elapsedEl.classList.toggle('bragi-hidden', !!status.paused)
	elements.loaderEl.classList.toggle('bragi-hidden', !!status.paused)
	elements.pausedEl.classList.toggle('bragi-hidden', !status.paused)
	elements.resumeEl.classList.toggle('bragi-hidden', !status.onResume)
	elements.resumeEl.onclick = event => { event.stopPropagation(); status.onResume?.() }
	if (status.paused) stopSquare19Loader(elements.loaderEl)
	else if (!(elements.loaderEl as { _bragiSquare19Stop?: () => void })._bragiSquare19Stop) mountSquare19Loader(elements.loaderEl)
}

export function stopGeneratingOverlayAnimation(elements: GeneratingOverlayElements): void {
	stopSquare19Loader(elements.loaderEl)
}

export function findGeneratingOverlay(nodeEl: HTMLElement): GeneratingOverlayElements | null {
	const overlayEl = nodeEl.querySelector<HTMLDivElement>('.bragi-generating-overlay')
	if (!overlayEl) return null
	const loaderEl = overlayEl.querySelector<HTMLDivElement>('.bragi-generating-loader')
	const modelEl = overlayEl.querySelector<HTMLSpanElement>('.bragi-generating-model')
	const elapsedEl = overlayEl.querySelector<HTMLDivElement>('.bragi-generating-elapsed')
	const statusEl = overlayEl.querySelector<HTMLDivElement>('.bragi-generating-status')
	const detailEl = overlayEl.querySelector<HTMLDivElement>('.bragi-generating-detail')
	const pausedEl = overlayEl.querySelector<HTMLDivElement>('.bragi-generating-paused-icon')
	const resumeEl = overlayEl.querySelector<HTMLButtonElement>('.bragi-generating-resume')
	if (!loaderEl || !modelEl || !elapsedEl || !statusEl || !detailEl || !pausedEl || !resumeEl) return null
	return { overlayEl, loaderEl, modelEl, elapsedEl, statusEl, detailEl, pausedEl, resumeEl }
}

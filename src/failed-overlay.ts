/** Failed / interrupted placeholder overlay — icon + title + optional model pill. */

export interface FailedOverlayElements {
	overlayEl: HTMLDivElement
	titleEl: HTMLDivElement
	modelPillEl: HTMLDivElement
	modelEl: HTMLSpanElement
}

function createFailedIcon(): HTMLDivElement {
	const icon = createDiv({ cls: 'bragi-failed-icon' })
	icon.innerHTML = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.25"/>
<path d="M8.25 8.25l7.5 7.5M15.75 8.25l-7.5 7.5" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
</svg>`
	return icon
}

export function createFailedOverlay(title: string, modelName?: string): FailedOverlayElements {
	const overlayEl = createDiv({ cls: 'bragi-failed-overlay' })
	const center = overlayEl.createDiv({ cls: 'bragi-failed-center' })
	center.appendChild(createFailedIcon())
	const titleEl = center.createDiv({ cls: 'bragi-failed-title', text: title })
	const modelPillEl = overlayEl.createDiv({ cls: 'bragi-generating-model-pill bragi-failed-model-pill' })
	const modelEl = modelPillEl.createSpan({ cls: 'bragi-generating-model' })
	updateFailedOverlay({ overlayEl, titleEl, modelPillEl, modelEl }, title, modelName)
	return { overlayEl, titleEl, modelPillEl, modelEl }
}

export function updateFailedOverlay(
	elements: FailedOverlayElements,
	title: string,
	modelName?: string,
): void {
	elements.titleEl.textContent = title
	if (modelName) {
		elements.modelEl.textContent = modelName
		elements.modelPillEl.style.display = ''
	} else {
		elements.modelEl.textContent = ''
		elements.modelPillEl.style.display = 'none'
	}
}

export function findFailedOverlay(nodeEl: HTMLElement): FailedOverlayElements | null {
	const overlayEl = nodeEl.querySelector<HTMLDivElement>('.bragi-failed-overlay')
	if (!overlayEl) return null
	const titleEl = overlayEl.querySelector<HTMLDivElement>('.bragi-failed-title')
	const modelPillEl = overlayEl.querySelector<HTMLDivElement>('.bragi-failed-model-pill')
	const modelEl = modelPillEl?.querySelector<HTMLSpanElement>('.bragi-generating-model')
	if (!titleEl || !modelPillEl || !modelEl) return null
	return { overlayEl, titleEl, modelPillEl, modelEl }
}

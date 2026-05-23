import type { CanvasNode } from './types/canvas-internal'

const REF_STRIP_SELECTORS = [
	'.bragi-text-ref-strip',
	'.bragi-ref-strip',
	'.bragi-audio-ref-strip',
] as const

const REF_NODE_CLASSES = [
	'bragi-has-text-refs',
	'bragi-has-refs',
	'bragi-has-audio-refs',
] as const

export function isGeneratingPlaceholderNode(node: CanvasNode): boolean {
	const d = node.getData() as {
		bragiGenerating?: boolean
		ovidGenerating?: boolean
		bragiGenerationFailed?: boolean
	}
	return (
		d.bragiGenerating === true ||
		d.ovidGenerating === true ||
		d.bragiGenerationFailed === true
	)
}

/** Strip upstream text/image/audio refs from a generating placeholder's content area. */
export function clearIncomingRefAttachments(node: CanvasNode): void {
	const contentEl = node.contentEl
	const nodeEl = node.nodeEl || node.containerEl
	if (!contentEl) return
	for (const sel of REF_STRIP_SELECTORS) {
		contentEl.querySelector(sel)?.remove()
	}
	for (const cls of REF_NODE_CLASSES) {
		nodeEl?.classList.remove(cls)
	}
}

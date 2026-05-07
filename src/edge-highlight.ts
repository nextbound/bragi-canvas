import type { Canvas, CanvasNode, CanvasEdge } from './types/canvas-internal'

const HIGHLIGHT_CLASS = 'bragi-edge-connected'
let highlightInterval: ReturnType<typeof setInterval> | null = null
let lastSelectedId: string | null = null

/**
 * Find the DOM <g> element for a canvas edge.
 * Obsidian stores it internally — try common property names.
 */
function getEdgeEl(edge: CanvasEdge): SVGGElement | null {
	const e = edge as unknown
	return e.lineGroupEl || e.wrapperEl || e.path?.parentElement || null
}

function clearHighlights(): void {
	activeDocument.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(el => {
		el.classList.remove(HIGHLIGHT_CLASS)
	})
}

function highlightEdgesForNode(canvas: Canvas, node: CanvasNode): void {
	try {
		const edges = canvas.getEdgesForNode(node)
		for (const edge of edges) {
			const el = getEdgeEl(edge)
			if (el) {
				el.classList.add(HIGHLIGHT_CLASS)
			}
		}
	} catch {
		// getEdgesForNode might not exist on some versions
	}
}

/**
 * Poll canvas selection and highlight connected edges.
 * Call once per canvas — cleans up via stopEdgeHighlight().
 */
export function startEdgeHighlight(canvas: Canvas): void {
	stopEdgeHighlight()

	highlightInterval = activeWindow.setInterval(() => {
		const selection = canvas.selection
		if (!selection || selection.size !== 1) {
			if (lastSelectedId !== null) {
				clearHighlights()
				lastSelectedId = null
			}
			return
		}

		const node = selection.values().next().value as CanvasNode
		if (node.id === lastSelectedId) return

		clearHighlights()
		lastSelectedId = node.id
		highlightEdgesForNode(canvas, node)
	}, 200)
}

export function stopEdgeHighlight(): void {
	if (highlightInterval) {
		activeWindow.clearInterval(highlightInterval)
		highlightInterval = null
	}
	clearHighlights()
	lastSelectedId = null
}

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import { getNodeElement } from './node-toolbar-position'
import type { Canvas, CanvasNode, CanvasEdge } from './types/canvas-internal'

const HIGHLIGHT_CLASS = 'bragi-edge-connected'
const HOVER_CLASS = 'bragi-edge-hovered'
let highlightInterval: number | null = null
let lastNodeSelectionKey = ''
let hoverCleanup: (() => void) | null = null
let hoveredLineGroup: SVGGElement | null = null
let activeCanvas: Canvas | null = null

function isCanvasNode(item: unknown): item is CanvasNode {
	return Boolean(getNodeElement(item as CanvasNode))
}

function getSelectedNodes(canvas: Canvas): CanvasNode[] {
	if (!canvas.selection?.size) return []
	return Array.from(canvas.selection).filter(isCanvasNode)
}

function getNodeSelectionKey(nodes: CanvasNode[]): string {
	if (!nodes.length) return ''
	return nodes.map(node => node.id).sort().join('|')
}

/**
 * Find the DOM <g> element for a canvas edge line.
 * Obsidian stores it internally — try common property names.
 */
function getEdgeLineGroup(edge: CanvasEdge): SVGGElement | null {
	const e = edge
	const group = e.lineGroupEl || e.wrapperEl || e.path?.parentNode
	return group instanceof SVGGElement ? group : null
}

function getEdgeEndGroup(edge: CanvasEdge): SVGGElement | null {
	const e = edge
	return e.lineEndGroupEl || null
}

function getEdgeGroups(edge: CanvasEdge): SVGGElement[] {
	return [getEdgeLineGroup(edge), getEdgeEndGroup(edge)].filter(Boolean) as SVGGElement[]
}

function setEdgeClass(edge: CanvasEdge, className: string, enabled: boolean): void {
	for (const group of getEdgeGroups(edge)) {
		group.classList.toggle(className, enabled)
	}
}

function clearHighlights(): void {
	activeDocument.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(el => {
		el.classList.remove(HIGHLIGHT_CLASS)
	})
}

function clearHover(): void {
	if (hoveredLineGroup) {
		hoveredLineGroup.classList.remove(HOVER_CLASS)
		if (activeCanvas) {
			const edge = findEdgeForLineGroup(activeCanvas, hoveredLineGroup)
			if (edge) {
				getEdgeEndGroup(edge)?.classList.remove(HOVER_CLASS)
			}
		}
		hoveredLineGroup = null
	}
}

function findEdgeForLineGroup(canvas: Canvas, lineGroup: SVGGElement): CanvasEdge | null {
	for (const edge of canvas.edges) {
		if (getEdgeLineGroup(edge) === lineGroup) return edge
	}
	return null
}

function highlightEdgesForNodes(canvas: Canvas, nodes: CanvasNode[]): void {
	const seen = new Set<CanvasEdge>()
	for (const node of nodes) {
		try {
			const edges = canvas.getEdgesForNode(node)
			for (const edge of edges) {
				if (seen.has(edge)) continue
				seen.add(edge)
				setEdgeClass(edge, HIGHLIGHT_CLASS, true)
			}
		} catch {
			// getEdgesForNode might not exist on some versions
		}
	}
}

function syncConnectedEdgeHighlights(canvas: Canvas): void {
	const selectedNodes = getSelectedNodes(canvas)
	const selectionKey = getNodeSelectionKey(selectedNodes)
	if (selectionKey === lastNodeSelectionKey) return

	lastNodeSelectionKey = selectionKey
	clearHighlights()
	if (!selectionKey) return
	highlightEdgesForNodes(canvas, selectedNodes)
}

function isEdgeSelected(lineGroup: SVGGElement): boolean {
	return lineGroup.classList.contains('is-focused') || lineGroup.classList.contains(HIGHLIGHT_CLASS)
}

function setupEdgeHover(canvas: Canvas): () => void {
	const container = canvas.edgeContainerEl
	if (!container) return () => {}

	const onMouseOver = (event: MouseEvent) => {
		const path = (event.target as Element).closest('path.canvas-display-path, path.canvas-interaction-path')
		if (!path) return

		const lineGroup = path.parentElement
		if (!(lineGroup instanceof SVGGElement) || lineGroup.parentNode !== container) return
		if (lineGroup === hoveredLineGroup) return
		if (isEdgeSelected(lineGroup)) {
			clearHover()
			return
		}

		clearHover()
		hoveredLineGroup = lineGroup
		lineGroup.classList.add(HOVER_CLASS)

		const edge = findEdgeForLineGroup(canvas, lineGroup)
		if (edge) {
			const endGroup = getEdgeEndGroup(edge)
			if (endGroup && !isEdgeSelected(endGroup)) {
				endGroup.classList.add(HOVER_CLASS)
			}
		}
	}

	const onMouseLeave = () => {
		clearHover()
	}

	container.addEventListener('mouseover', onMouseOver)
	container.addEventListener('mouseleave', onMouseLeave)

	return () => {
		container.removeEventListener('mouseover', onMouseOver)
		container.removeEventListener('mouseleave', onMouseLeave)
		clearHover()
	}
}

/**
 * Poll canvas selection and highlight connected edges for any selected node(s).
 * Call once per canvas — cleans up via stopEdgeHighlight().
 */
export function startEdgeHighlight(canvas: Canvas): void {
	stopEdgeHighlight()

	activeCanvas = canvas
	hoverCleanup = setupEdgeHover(canvas)
	syncConnectedEdgeHighlights(canvas)

	highlightInterval = window.setInterval(() => {
		syncConnectedEdgeHighlights(canvas)
	}, 200)
}

export function stopEdgeHighlight(): void {
	if (highlightInterval) {
		window.clearInterval(highlightInterval)
		highlightInterval = null
	}
	if (hoverCleanup) {
		hoverCleanup()
		hoverCleanup = null
	}
	clearHighlights()
	clearHover()
	lastNodeSelectionKey = ''
	activeCanvas = null
}

/* eslint-enable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Resume strict linting after the runtime-shaped data boundary. */

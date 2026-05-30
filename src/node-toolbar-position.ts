import type { Canvas, CanvasNode } from './types/canvas-internal'

/** Gap between a node edge and a floating toolbar (selection menu or generate bar). */
export const NODE_TOOLBAR_GAP = 12

export type NodeToolbarPlacement = 'above' | 'below'

export type ToolbarPlacementPreference =
	| 'auto-above'
	| 'auto-below'
	| NodeToolbarPlacement

export interface SelectionBounds {
	left: number
	top: number
	right: number
	bottom: number
	width: number
	height: number
	centerX: number
	centerY: number
}

export function getNodeElement(node: CanvasNode): HTMLElement | null {
	return node.nodeEl || node.containerEl || null
}

export function getSelectionBounds(nodes: Iterable<CanvasNode>): SelectionBounds | null {
	let minX = Infinity
	let minY = Infinity
	let maxX = -Infinity
	let maxY = -Infinity
	let count = 0

	for (const node of nodes) {
		const el = getNodeElement(node)
		if (!el) continue
		const rect = el.getBoundingClientRect()
		minX = Math.min(minX, rect.left)
		minY = Math.min(minY, rect.top)
		maxX = Math.max(maxX, rect.right)
		maxY = Math.max(maxY, rect.bottom)
		count++
	}

	if (count === 0 || !Number.isFinite(minX)) return null

	return {
		left: minX,
		top: minY,
		right: maxX,
		bottom: maxY,
		width: maxX - minX,
		height: maxY - minY,
		centerX: (minX + maxX) / 2,
		centerY: (minY + maxY) / 2,
	}
}

function getViewportBounds(bar: HTMLElement): DOMRect {
	const wrapper = bar.closest('.canvas-wrapper')
	const fallback = bar.offsetParent?.getBoundingClientRect()
	return wrapper?.getBoundingClientRect()
		?? fallback
		?? new DOMRect(0, 0, window.innerWidth, window.innerHeight)
}

export function detectToolbarPlacement(toolbarRect: DOMRect, selection: SelectionBounds): NodeToolbarPlacement {
	const toolbarCenterY = (toolbarRect.top + toolbarRect.bottom) / 2
	return toolbarCenterY < selection.centerY ? 'above' : 'below'
}

export function chooseToolbarPlacement(
	barHeight: number,
	selection: SelectionBounds,
	viewport: DOMRect,
	preference: ToolbarPlacementPreference = 'auto-above',
): NodeToolbarPlacement {
	if (preference === 'above' || preference === 'below') return preference

	const needed = barHeight + NODE_TOOLBAR_GAP
	const spaceAbove = selection.top - viewport.top
	const spaceBelow = viewport.bottom - selection.bottom
	const fitsAbove = spaceAbove >= needed
	const fitsBelow = spaceBelow >= needed

	if (preference === 'auto-below') {
		if (fitsBelow) return 'below'
		if (fitsAbove) return 'above'
		return spaceBelow >= spaceAbove ? 'below' : 'above'
	}

	// Obsidian popup menu prefers above when both sides fit.
	if (fitsAbove) return 'above'
	if (fitsBelow) return 'below'
	return spaceAbove >= spaceBelow ? 'above' : 'below'
}

export function getNodeSelectionBounds(selection: Iterable<unknown>): SelectionBounds | null {
	const nodes: CanvasNode[] = []
	for (const item of selection) {
		if (getNodeElement(item as CanvasNode)) {
			nodes.push(item as CanvasNode)
		}
	}
	if (!nodes.length) return null
	return getSelectionBounds(nodes)
}

export function resetToolbarPosition(bar: HTMLElement): void {
	bar.style.removeProperty('left')
	bar.style.removeProperty('top')
}

export function positionNodeToolbar(
	bar: HTMLElement,
	selection: SelectionBounds,
	options?: {
		placement?: ToolbarPlacementPreference
		preserveObsidianPlacement?: boolean
	},
): NodeToolbarPlacement | null {
	const parentRect = bar.offsetParent?.getBoundingClientRect()
	if (!parentRect) return null

	const barWidth = bar.offsetWidth
	const barHeight = bar.offsetHeight
	if (barWidth <= 0 || barHeight <= 0) return null

	let placement: NodeToolbarPlacement
	if (options?.preserveObsidianPlacement) {
		placement = detectToolbarPlacement(bar.getBoundingClientRect(), selection)
	} else {
		placement = chooseToolbarPlacement(
			barHeight,
			selection,
			getViewportBounds(bar),
			options?.placement ?? 'auto-above',
		)
	}

	const left = selection.centerX - parentRect.left - barWidth / 2
	const top = placement === 'above'
		? selection.top - parentRect.top - barHeight - NODE_TOOLBAR_GAP
		: selection.bottom - parentRect.top + NODE_TOOLBAR_GAP

	bar.style.left = `${left}px`
	bar.style.top = `${top}px`
	return placement
}

const pendingMenuSync = new WeakMap<HTMLElement, number>()

type SelectionMenuGapSyncOptions = {
	placement?: ToolbarPlacementPreference
	preserveObsidianPlacement?: boolean
}

/** Re-apply the shared node gap after Obsidian positions the selection menu. */
export function queueSelectionMenuGapSync(menuEl: HTMLElement, canvas: Canvas, options?: SelectionMenuGapSyncOptions): void {
	const pending = pendingMenuSync.get(menuEl)
	if (pending) window.cancelAnimationFrame(pending)

	const id = window.requestAnimationFrame(() => {
		pendingMenuSync.delete(menuEl)
		syncSelectionMenuGap(menuEl, canvas, options)
	})
	pendingMenuSync.set(menuEl, id)
}

export function syncSelectionMenuGap(menuEl: HTMLElement, canvas: Canvas, options?: SelectionMenuGapSyncOptions): void {
	if (!canvas.selection?.size) {
		resetToolbarPosition(menuEl)
		return
	}

	const bounds = getNodeSelectionBounds(canvas.selection)
	if (!bounds) {
		// Edge-only (or non-node) selection — Obsidian positions the menu container.
		resetToolbarPosition(menuEl)
		return
	}

	positionNodeToolbar(menuEl, bounds, options ?? { preserveObsidianPlacement: true })
}

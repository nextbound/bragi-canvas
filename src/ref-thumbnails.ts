import type { App } from 'obsidian'
import type { Canvas, CanvasNode } from './types/canvas-internal'
import { getUpstreamInputs } from './edge-parser'

const STRIP_CLASS = 'bragi-ref-strip'
const NODE_HAS_REFS_CLASS = 'bragi-has-refs'
const STRIP_HEIGHT = 72

const adjustedNodes = new Set<string>()

// Block refresh during drag
let isDragging = false

/**
 * Get the ordered image list for a node.
 * Uses bragiImageOrder from node metadata if available, otherwise upstream order.
 * Falls back to legacy ovidImageOrder for vaults created before the rename.
 */
export function getOrderedImages(canvas: Canvas, node: CanvasNode): string[] {
	const upstream = getUpstreamInputs(canvas, node)
	const uniqueImages = [...new Set(upstream.images)]

	const nodeData = node.getData() as any
	const savedOrder: string[] | undefined = nodeData.bragiImageOrder || nodeData.ovidImageOrder

	if (savedOrder && savedOrder.length > 0) {
		// Use saved order, but only for images that still exist in upstream
		const ordered: string[] = []
		for (const path of savedOrder) {
			if (uniqueImages.includes(path)) {
				ordered.push(path)
			}
		}
		// Append any new images not in saved order
		for (const path of uniqueImages) {
			if (!ordered.includes(path)) {
				ordered.push(path)
			}
		}
		return ordered
	}

	return uniqueImages
}

export function updateRefThumbnails(canvas: Canvas, node: CanvasNode, app: App): void {
	if (isDragging) return // Don't rebuild during drag

	const nodeData = node.getData()
	if (nodeData.type !== 'text' && !(nodeData.type === 'file' && (nodeData as any).file?.endsWith('.md'))) {
		return
	}

	const contentEl = node.contentEl
	const nodeEl = node.nodeEl || node.containerEl
	if (!contentEl) return

	const existing = contentEl.querySelector(`.${STRIP_CLASS}`)
	const orderedImages = getOrderedImages(canvas, node)

	if (orderedImages.length === 0) {
		if (existing) {
			existing.remove()
			nodeEl?.classList.remove(NODE_HAS_REFS_CLASS)
			adjustedNodes.delete(node.id)
		}
		return
	}

	const fingerprint = orderedImages.join('|')
	if (existing?.getAttribute('data-fingerprint') === fingerprint) {
		return
	}

	existing?.remove()

	const strip = document.createElement('div')
	strip.className = STRIP_CLASS
	strip.setAttribute('data-fingerprint', fingerprint)

	for (let i = 0; i < orderedImages.length; i++) {
		const imgPath = orderedImages[i]

		const wrapper = document.createElement('div')
		wrapper.className = 'bragi-ref-thumb-wrapper'
		wrapper.setAttribute('data-img-path', imgPath)
		wrapper.draggable = true

		const img = document.createElement('img')
		img.className = 'bragi-ref-thumb'
		img.src = app.vault.adapter.getResourcePath(imgPath)
		img.title = `#${i + 1} — ${imgPath.split('/').pop() || imgPath}`
		img.draggable = false // prevent native img drag
		wrapper.appendChild(img)

		const badge = document.createElement('div')
		badge.className = 'bragi-ref-badge'
		badge.textContent = String(i + 1)
		wrapper.appendChild(badge)

		// Asset ID indicator — read from the source image node
		const sourceImageNode = findImageNode(canvas, imgPath)
		const assetId = sourceImageNode ? (sourceImageNode.getData() as any).bragiAssetId : null

		if (assetId) {
			const assetDot = document.createElement('div')
			assetDot.className = 'bragi-asset-dot'
			assetDot.title = `Asset: ${assetId}`
			wrapper.appendChild(assetDot)
		}

		// Drag events
		wrapper.addEventListener('dragstart', (e) => {
			isDragging = true
			e.dataTransfer!.setData('text/plain', imgPath)
			wrapper.classList.add('is-dragging')
		})

		wrapper.addEventListener('dragend', () => {
			isDragging = false
			wrapper.classList.remove('is-dragging')
		})

		wrapper.addEventListener('dragover', (e) => {
			e.preventDefault()
			wrapper.classList.add('drag-over')
		})

		wrapper.addEventListener('dragleave', () => {
			wrapper.classList.remove('drag-over')
		})

		wrapper.addEventListener('drop', (e) => {
			e.preventDefault()
			wrapper.classList.remove('drag-over')
			const draggedPath = e.dataTransfer!.getData('text/plain')
			if (!draggedPath || draggedPath === imgPath) return

			// Reorder
			const newOrder = [...orderedImages]
			const fromIdx = newOrder.indexOf(draggedPath)
			const toIdx = newOrder.indexOf(imgPath)
			if (fromIdx === -1 || toIdx === -1) return

			newOrder.splice(fromIdx, 1)
			newOrder.splice(toIdx, 0, draggedPath)

			// Save to node metadata (drop legacy key so it doesn't drift)
			const data = node.getData() as any
			const { ovidImageOrder: _legacy, ...rest } = data
			node.setData({ ...rest, bragiImageOrder: newOrder })

			// Force rebuild
			isDragging = false
			updateRefThumbnails(canvas, node, app)
		})

		strip.appendChild(wrapper)
	}

	contentEl.prepend(strip)
	nodeEl?.classList.add(NODE_HAS_REFS_CLASS)

	adjustedNodes.add(node.id)
}

/**
 * Find the canvas node for a given image file path.
 */
function findImageNode(canvas: Canvas, imgPath: string): CanvasNode | null {
	const nodes = canvas.nodes instanceof Map
		? Array.from(canvas.nodes.values())
		: canvas.nodes as any[]
	for (const n of nodes) {
		const d = n.getData()
		if (d.type === 'file' && (d as any).file === imgPath) return n
	}
	return null
}

/**
 * Get asset ID map for a node's upstream images.
 * Reads bragiAssetId from each source image node.
 */
export function getAssetIds(canvas: Canvas, node: CanvasNode): Record<string, string> {
	const images = getOrderedImages(canvas, node)
	const result: Record<string, string> = {}
	for (const imgPath of images) {
		const imgNode = findImageNode(canvas, imgPath)
		if (imgNode) {
			const assetId = (imgNode.getData() as any).bragiAssetId
			if (assetId) result[imgPath] = assetId
		}
	}
	return result
}

export function refreshAllThumbnails(canvas: Canvas, app: App): void {
	if (isDragging) return
	if (!canvas.nodes) return

	const nodes = canvas.nodes instanceof Map
		? Array.from(canvas.nodes.values())
		: canvas.nodes

	for (const node of nodes) {
		const data = node.getData()
		if (data.type === 'text' || (data.type === 'file' && (data as any).file?.endsWith('.md'))) {
			updateRefThumbnails(canvas, node, app)
		}
	}
}

export function removeAllThumbnails(): void {
	document.querySelectorAll(`.${STRIP_CLASS}`).forEach(el => el.remove())
	document.querySelectorAll(`.${NODE_HAS_REFS_CLASS}`).forEach(el => el.classList.remove(NODE_HAS_REFS_CLASS))
	adjustedNodes.clear()
}

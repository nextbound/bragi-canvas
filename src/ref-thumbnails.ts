/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import type { App } from 'obsidian'
import type { Canvas, CanvasNode } from './types/canvas-internal'
import { getUpstreamInputs } from './edge-parser'
import { getIncomingAutoSlots } from './canvas-slots'

const STRIP_CLASS = 'bragi-ref-strip'
const NODE_HAS_REFS_CLASS = 'bragi-has-refs'

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
	const slots = getIncomingAutoSlots(canvas, node)
	const slotFiles = new Set(slots.flatMap(slot => slot.files))
	const directImages = upstream.images.filter(path => !slotFiles.has(path))
	const slotPreviewImages = slots
		.map(slot => slot.files[0])
		.filter((path): path is string => Boolean(path))
	const uniqueImages = [...new Set([...directImages, ...slotPreviewImages])]

	const nodeData = node.getData() as unknown
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
	if (nodeData.type !== 'text' && !(nodeData.type === 'file' && (nodeData as unknown).file?.endsWith('.md'))) {
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

	const strip = createDiv()
	strip.className = STRIP_CLASS
	strip.setAttribute('data-fingerprint', fingerprint)

	for (let i = 0; i < orderedImages.length; i++) {
		const imgPath = orderedImages[i]

		const wrapper = createDiv()
		wrapper.className = 'bragi-ref-thumb-wrapper'
		wrapper.setAttribute('data-img-path', imgPath)
		wrapper.draggable = true

		const img = createEl('img')
		img.className = 'bragi-ref-thumb'
		img.src = app.vault.adapter.getResourcePath(imgPath)
		img.title = `#${i + 1} — ${imgPath.split('/').pop() || imgPath}`
		img.draggable = false // prevent native img drag
		wrapper.appendChild(img)

		const badge = createDiv()
		badge.className = 'bragi-ref-badge'
		badge.textContent = String(i + 1)
		wrapper.appendChild(badge)

		// Asset ID indicator — read from the source image node
		const sourceImageNode = findImageNode(canvas, imgPath)
		const assetId = sourceImageNode ? (sourceImageNode.getData() as unknown).bragiAssetId : null

		if (assetId) {
			const assetDot = createDiv()
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
			const data = node.getData() as unknown
			const rest = { ...data }
			delete rest.ovidImageOrder
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
		: canvas.nodes as unknown[]
	for (const n of nodes) {
		const d = n.getData()
		if (d.type === 'file' && (d).file === imgPath) return n
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
			const assetId = (imgNode.getData() as unknown).bragiAssetId
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
		if (data.type === 'text' || (data.type === 'file' && (data as unknown).file?.endsWith('.md'))) {
			updateRefThumbnails(canvas, node, app)
		}
	}
}

export function removeAllThumbnails(): void {
	activeDocument.querySelectorAll(`.${STRIP_CLASS}`).forEach(el => el.remove())
	activeDocument.querySelectorAll(`.${NODE_HAS_REFS_CLASS}`).forEach(el => el.classList.remove(NODE_HAS_REFS_CLASS))
	adjustedNodes.clear()
}

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

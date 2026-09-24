/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import type { App } from 'obsidian'
import type { Canvas, CanvasNode } from './types/canvas-internal'
import { getUpstreamInputs } from './edge-parser'
import { clearIncomingRefAttachments, isGeneratingPlaceholderNode } from './generating-node'
import { beginRefDrag, endRefDrag, isRefDragActive } from './ref-drag-guard'
import { findFileNodeByPath, getAssetIdsForFiles, getNodeAssetIdMap } from './asset-ids'

const STRIP_CLASS = 'bragi-ref-strip'
const NODE_HAS_REFS_CLASS = 'bragi-has-refs'

const adjustedNodes = new Set<string>()

/**
 * Get the ordered image list for a node.
 * Uses bragiImageOrder from node metadata if available, otherwise upstream order.
 * Falls back to legacy ovidImageOrder for vaults created before the rename.
 */
export function getOrderedImages(canvas: Canvas, node: CanvasNode): string[] {
	const upstream = getUpstreamInputs(canvas, node)
	const uniqueImages = [...new Set(upstream.images)]

	const nodeData = node.getData()
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
	if (isRefDragActive()) return // Don't rebuild during an active reorder drag
	if (isGeneratingPlaceholderNode(node)) {
		clearIncomingRefAttachments(node)
		return
	}

	const nodeData = node.getData()
	if (nodeData.type !== 'text' && !(nodeData.type === 'file' && nodeData.file?.endsWith('.md'))) {
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
		const sourceImageNode = findFileNodeByPath(canvas, imgPath)
		const assetIds = sourceImageNode ? getNodeAssetIdMap(sourceImageNode) : {}
		const assetIdCount = Object.keys(assetIds).length

		if (assetIdCount > 0) {
			const assetDot = createDiv()
			assetDot.className = 'bragi-asset-dot'
			assetDot.title = Object.entries(assetIds)
				.map(([provider, id]) => `${provider}: ${id}`)
				.join('\n')
			wrapper.appendChild(assetDot)
		}

		// Drag events
		wrapper.addEventListener('dragstart', (e) => {
			beginRefDrag()
			e.dataTransfer!.setData('text/plain', imgPath)
			wrapper.classList.add('is-dragging')
		})

		wrapper.addEventListener('dragend', () => {
			endRefDrag()
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
			const data = node.getData()
			const rest = { ...data }
			delete rest.ovidImageOrder
			node.setData({ ...rest, bragiImageOrder: newOrder })

			// Force rebuild
			endRefDrag()
			updateRefThumbnails(canvas, node, app)
		})

		strip.appendChild(wrapper)
	}

	contentEl.prepend(strip)
	nodeEl?.classList.add(NODE_HAS_REFS_CLASS)

	adjustedNodes.add(node.id)
}

/**
 * Get asset ID map for a node's upstream images.
 * Reads provider-scoped bragiAssetIds first; legacy bragiAssetId only falls
 * back for Volcengine/BytePlus compatibility.
 */
export function getAssetIds(canvas: Canvas, node: CanvasNode, providerId?: string): Record<string, string> {
	return getAssetIdsForFiles(canvas, getOrderedImages(canvas, node), providerId)
}

export function refreshAllThumbnails(canvas: Canvas, app: App): void {
	if (isRefDragActive()) return
	if (!canvas.nodes) return

	const nodes = canvas.nodes instanceof Map
		? Array.from(canvas.nodes.values())
		: canvas.nodes

	for (const node of nodes) {
		const data = node.getData()
		if (data.type === 'text' || (data.type === 'file' && data.file?.endsWith('.md'))) {
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

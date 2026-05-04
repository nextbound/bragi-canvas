import type { App } from 'obsidian'
import type { Canvas, CanvasNode } from './types/canvas-internal'

const STRIP_CLASS = 'bragi-text-ref-strip'
const NODE_HAS_TEXT_REFS_CLASS = 'bragi-has-text-refs'

let isDragging = false

export interface TextRef {
	nodeId: string
	preview: string
	kind: 'text' | 'md'
	mdPath?: string
}

function previewOf(text: string): string {
	const oneLine = text.replace(/\s+/g, ' ').trim()
	return oneLine.length > 200 ? oneLine.substring(0, 200) : oneLine
}

/**
 * Collect upstream text/md refs for a node, applying saved order from bragiTextOrder.
 */
export function getOrderedTextRefs(canvas: Canvas, node: CanvasNode): TextRef[] {
	const edges = canvas.getEdgesForNode(node)
	if (!edges) return []

	const byId = new Map<string, TextRef>()

	for (const edge of edges) {
		if (edge.to.node.id !== node.id) continue
		const edgeData = (edge as any).getData?.() || edge
		const toEnd = edgeData.toEnd ?? 'arrow'
		const fromEnd = edgeData.fromEnd ?? 'none'
		if (toEnd !== 'arrow') continue
		if (fromEnd === 'arrow') continue

		const src = edge.from.node
		const data = src.getData() as any
		const srcId = src.id

		if (data.type === 'text') {
			const text = (src.text || data.text || '').trim()
			if (!text) continue
			byId.set(srcId, { nodeId: srcId, preview: previewOf(text), kind: 'text' })
		} else if (data.type === 'file' && /\.md$/i.test(data.file || '')) {
			const path: string = data.file
			const basename = path.split('/').pop() || path
			byId.set(srcId, { nodeId: srcId, preview: basename, kind: 'md', mdPath: path })
		}
	}

	const nodeData = node.getData() as any
	const savedOrder: string[] | undefined = nodeData.bragiTextOrder
	const ordered: TextRef[] = []

	if (savedOrder && savedOrder.length) {
		for (const id of savedOrder) {
			const ref = byId.get(id)
			if (ref) {
				ordered.push(ref)
				byId.delete(id)
			}
		}
	}
	// Append any new refs not yet in saved order
	for (const ref of byId.values()) ordered.push(ref)
	return ordered
}

/**
 * Resolve ordered upstream prompts (text content + md file contents) for generation.
 */
export async function getOrderedPrompts(
	canvas: Canvas,
	node: CanvasNode,
	app: App,
): Promise<string[]> {
	// Use live data, not truncated preview — re-walk edges to get full text
	const refs = getOrderedTextRefs(canvas, node)
	const result: string[] = []

	// Build nodeId -> full text map from current upstream
	const edges = canvas.getEdgesForNode(node)
	if (!edges) return result
	const fullById = new Map<string, { kind: 'text' | 'md'; value: string }>()
	for (const edge of edges) {
		if (edge.to.node.id !== node.id) continue
		const edgeData = (edge as any).getData?.() || edge
		if ((edgeData.toEnd ?? 'arrow') !== 'arrow') continue
		if ((edgeData.fromEnd ?? 'none') === 'arrow') continue
		const src = edge.from.node
		const data = src.getData() as any
		if (data.type === 'text') {
			const text = (src.text || data.text || '').trim()
			if (text) fullById.set(src.id, { kind: 'text', value: text })
		} else if (data.type === 'file' && /\.md$/i.test(data.file || '')) {
			fullById.set(src.id, { kind: 'md', value: data.file })
		}
	}

	for (const ref of refs) {
		const full = fullById.get(ref.nodeId)
		if (!full) continue
		if (full.kind === 'text') {
			result.push(full.value)
		} else {
			const file = app.vault.getAbstractFileByPath(full.value)
			if (file) {
				const content = await app.vault.read(file as any)
				if (content.trim()) result.push(content.trim())
			}
		}
	}
	return result
}

export function updateTextRefStrip(canvas: Canvas, node: CanvasNode, app: App): void {
	if (isDragging) return

	const nodeData = node.getData() as any
	if (nodeData.type !== 'text' && !(nodeData.type === 'file' && /\.md$/i.test(nodeData.file || ''))) {
		return
	}

	const contentEl = node.contentEl
	const nodeEl = node.nodeEl || node.containerEl
	if (!contentEl) return

	const existing = contentEl.querySelector(`.${STRIP_CLASS}`)
	const refs = getOrderedTextRefs(canvas, node)

	if (refs.length === 0) {
		if (existing) {
			existing.remove()
			nodeEl?.classList.remove(NODE_HAS_TEXT_REFS_CLASS)
		}
		return
	}

	const fingerprint = refs.map(r => `${r.nodeId}:${r.preview.length}:${r.preview.substring(0, 40)}`).join('|')
	if (existing?.getAttribute('data-fingerprint') === fingerprint) return

	existing?.remove()

	const strip = document.createElement('div')
	strip.className = STRIP_CLASS
	strip.setAttribute('data-fingerprint', fingerprint)

	for (let i = 0; i < refs.length; i++) {
		const ref = refs[i]
		const row = document.createElement('div')
		row.className = 'bragi-text-ref-row'
		row.setAttribute('data-ref-id', ref.nodeId)
		row.draggable = true

		const leading = document.createElement('div')
		leading.className = 'bragi-ref-leading'

		const handle = document.createElement('span')
		handle.className = 'bragi-text-ref-handle'
		handle.textContent = '⠿'
		leading.appendChild(handle)

		const badge = document.createElement('span')
		badge.className = 'bragi-ref-badge bragi-ref-badge-inline'
		badge.textContent = String(i + 1)
		leading.appendChild(badge)

		row.appendChild(leading)

		const preview = document.createElement('span')
		preview.className = 'bragi-text-ref-preview'
		preview.textContent = ref.preview
		preview.title = ref.preview
		row.appendChild(preview)

		row.addEventListener('dragstart', (e) => {
			isDragging = true
			e.dataTransfer!.setData('text/plain', `bragi-text-ref:${ref.nodeId}`)
			row.classList.add('is-dragging')
		})
		row.addEventListener('dragend', () => {
			isDragging = false
			row.classList.remove('is-dragging')
		})
		row.addEventListener('dragover', (e) => {
			e.preventDefault()
			row.classList.add('drag-over')
		})
		row.addEventListener('dragleave', () => {
			row.classList.remove('drag-over')
		})
		row.addEventListener('drop', (e) => {
			e.preventDefault()
			row.classList.remove('drag-over')
			const payload = e.dataTransfer!.getData('text/plain') || ''
			if (!payload.startsWith('bragi-text-ref:')) return
			const draggedId = payload.substring('bragi-text-ref:'.length)
			if (!draggedId || draggedId === ref.nodeId) return

			const order = refs.map(r => r.nodeId)
			const fromIdx = order.indexOf(draggedId)
			const toIdx = order.indexOf(ref.nodeId)
			if (fromIdx === -1 || toIdx === -1) return
			order.splice(fromIdx, 1)
			order.splice(toIdx, 0, draggedId)

			const d = node.getData() as any
			node.setData({ ...d, bragiTextOrder: order })

			isDragging = false
			updateTextRefStrip(canvas, node, app)
		})

		strip.appendChild(row)
	}

	// Insert AFTER the image strip if present, otherwise at the top
	const imageStrip = contentEl.querySelector('.bragi-ref-strip')
	if (imageStrip && imageStrip.parentElement === contentEl) {
		imageStrip.insertAdjacentElement('afterend', strip)
	} else {
		contentEl.prepend(strip)
	}
	nodeEl?.classList.add(NODE_HAS_TEXT_REFS_CLASS)
}

export function refreshAllTextRefs(canvas: Canvas, app: App): void {
	if (isDragging) return
	if (!canvas.nodes) return
	const nodes = canvas.nodes instanceof Map
		? Array.from(canvas.nodes.values())
		: (canvas.nodes as any[])
	for (const node of nodes) {
		const data = node.getData()
		if (data.type === 'text' || (data.type === 'file' && /\.md$/i.test((data as any).file || ''))) {
			updateTextRefStrip(canvas, node, app)
		}
	}
}

export function removeAllTextRefs(): void {
	document.querySelectorAll(`.${STRIP_CLASS}`).forEach(el => el.remove())
	document.querySelectorAll(`.${NODE_HAS_TEXT_REFS_CLASS}`).forEach(el => el.classList.remove(NODE_HAS_TEXT_REFS_CLASS))
}

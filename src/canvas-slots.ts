/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas node data is runtime-shaped and narrowed here. */
import { Notice, type App } from 'obsidian'
import type { Canvas, CanvasNode } from './types/canvas-internal'

type CanvasViewLike = {
	getViewType?: () => string
	canvas?: Canvas
	containerEl?: HTMLElement
	file?: { path?: string }
}

type CanvasNodeDataLike = {
	id?: string
	type?: string
	file?: string
	label?: string
	text?: string
	x?: number
	y?: number
	width?: number
	height?: number
}

export type AutoSlotRef = {
	id: string
	node: CanvasNode
	label: string
	files: string[]
}

export type SlotPlacement = {
	x: number
	y: number
	width: number
	height: number
}

export function isAutoSlotLabel(label?: string): boolean {
	return /预设框|输出框|自动框|preset|slot/i.test((label || '').trim())
}

export function findAutoSlotForSource(canvas: Canvas, sourceNode: CanvasNode): CanvasNode | null {
	try {
		const edges = canvas.getEdgesForNode(sourceNode) || []
		for (const edge of edges) {
			if (edge.from.node.id !== sourceNode.id) continue
			const target = edge.to.node
			const data = target.getData() as CanvasNodeDataLike
			if (data.type === 'group' && isAutoSlotLabel(data.label)) return target
		}
	} catch (err) {
		console.error('Bragi: failed to find auto slot', err)
	}
	return null
}

export function getAutoSlotTargets(canvas: Canvas, slotNode: CanvasNode): CanvasNode[] {
	const targets: CanvasNode[] = []
	try {
		const edges = canvas.getEdgesForNode(slotNode) || []
		for (const edge of edges) {
			if (edge.from.node.id !== slotNode.id) continue
			const target = edge.to.node
			const data = target.getData() as CanvasNodeDataLike
			if (isPromptNodeData(data)) targets.push(target)
		}
	} catch (err) {
		console.error('Bragi: failed to find auto slot targets', err)
	}
	return targets
}

export function getAutoSlotPlacement(
	canvas: Canvas,
	slotNode: CanvasNode,
	fallback: { width: number; height: number },
): SlotPlacement {
	const slotData = slotNode.getData() as CanvasNodeDataLike
	const slotWidth = slotData.width || 460
	const slotHeight = slotData.height || 360
	const existingCount = getNodesInSlot(canvas, slotNode)
		.filter(node => (node.getData() as CanvasNodeDataLike).type === 'file')
		.length

	return {
		x: (slotData.x || 0) + 24,
		y: (slotData.y || 0) + 48 + existingCount * 330,
		width: Math.max(220, Math.min(fallback.width || 400, slotWidth - 48)),
		height: Math.max(180, Math.min(fallback.height || 300, slotHeight - 72)),
	}
}

export function getIncomingAutoSlots(canvas: Canvas, node: CanvasNode): AutoSlotRef[] {
	const refs: AutoSlotRef[] = []
	const edges = canvas.getEdgesForNode(node)
	if (!edges) return refs

	for (const edge of edges) {
		if (edge.to.node.id !== node.id) continue
		const source = edge.from.node
		const data = source.getData() as CanvasNodeDataLike
		if (data.type === 'group' && isAutoSlotLabel(data.label)) {
			refs.push({
				id: source.id,
				node: source,
				label: data.label || 'Preset slot',
				files: getAutoSlotFilePaths(canvas, source),
			})
		}
	}
	return refs
}

export function getAutoSlotFilePaths(canvas: Canvas, slotNode: CanvasNode): string[] {
	return getNodesInSlot(canvas, slotNode)
		.map(node => ({ node, data: node.getData() }))
		.filter(({ data }) => data.type === 'file' && /\.(png|jpg|jpeg|webp|gif)$/i.test(data.file || ''))
		.sort((a, b) => (a.data.y || 0) - (b.data.y || 0) || (a.data.x || 0) - (b.data.x || 0))
		.map(({ data }) => data.file || '')
		.filter(Boolean)
}

export function createPresetSlot(app: App): void {
	try {
		const leaf = app.workspace.getLeaf(false)
		const view = leaf?.view as CanvasViewLike | undefined
		if (view?.getViewType?.() !== 'canvas' || !view.canvas) {
			new Notice('Open a canvas first')
			return
		}

		const canvas = view.canvas
		const currentData = canvas.getData()
		const pos = getCanvasViewportCenter(canvas, view, 560, 380)
		const node = {
			id: generateId(),
			type: 'group',
			x: Math.round(pos.x),
			y: Math.round(pos.y),
			width: 560,
			height: 380,
			label: 'Preset slot',
		}

		canvas.importData({
			nodes: [...currentData.nodes, node],
			edges: currentData.edges || [],
		})
		void canvas.requestSave()
		new Notice('Preset slot added')
	} catch (err: unknown) {
		console.error('Bragi: create preset slot failed', err)
		new Notice(`Failed to add preset slot: ${err instanceof Error ? err.message : String(err)}`)
	}
}

function getNodesInSlot(canvas: Canvas, slotNode: CanvasNode): CanvasNode[] {
	const nodes = canvas.nodes instanceof Map
		? Array.from(canvas.nodes.values())
		: canvas.nodes as unknown as CanvasNode[]
	return nodes.filter(node => node.id !== slotNode.id && isNodeInsideSlot(slotNode, node))
}

function isNodeInsideSlot(slotNode: CanvasNode, node: CanvasNode): boolean {
	const slot = slotNode.getData() as CanvasNodeDataLike
	const data = node.getData() as CanvasNodeDataLike
	const x = data.x || 0
	const y = data.y || 0
	return x >= (slot.x || 0)
		&& y >= (slot.y || 0)
		&& x <= (slot.x || 0) + (slot.width || 0)
		&& y <= (slot.y || 0) + (slot.height || 0)
}

function isPromptNodeData(data: CanvasNodeDataLike): boolean {
	return data.type === 'text' || (data.type === 'file' && /\.md$/i.test(data.file || ''))
}

function getCanvasViewportCenter(canvas: Canvas, view: CanvasViewLike, width: number, height: number): { x: number; y: number } {
	try {
		const nodeContainer = view.containerEl?.querySelector('.canvas-node-container') as HTMLElement | null
		const viewport = nodeContainer?.parentElement
			|| canvas.wrapperEl?.parentElement
			|| view.containerEl?.parentElement
		if (nodeContainer && viewport && window.DOMMatrix && window.DOMPoint) {
			const rect = viewport.getBoundingClientRect()
			const transform = getComputedStyle(nodeContainer).transform
			const matrix = new DOMMatrix(transform)
			if (!matrix.isIdentity || transform !== 'none') {
				const center = new DOMPoint(rect.width / 2, rect.height / 2).matrixTransform(matrix.inverse())
				return { x: center.x - width / 2, y: center.y - height / 2 }
			}
		}
	} catch {
		// Fall through to a stable center-ish default.
	}
	return { x: -width / 2, y: -height / 2 }
}

function generateId(): string {
	return Math.random().toString(36).substring(2, 18)
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after runtime-shaped data handling. */

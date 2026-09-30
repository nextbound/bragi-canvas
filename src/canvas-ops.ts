import type { AllCanvasNodeData } from 'obsidian/canvas'
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import type { Canvas, CanvasNode } from './types/canvas-internal'
import {
	createGeneratingOverlay,
	findGeneratingOverlay,
	stopGeneratingOverlayAnimation,
	updateGeneratingOverlay,
	type GeneratingOverlayElements,
	type GeneratingStatus,
} from './generating-overlay'
import { clearIncomingRefAttachments } from './generating-node'
import { openNodeDetails } from './ui/error-details-modal'
import { stopSquare19Loader } from './dotm-square-19'
import {
	createFailedOverlay,
	findFailedOverlay,
	updateFailedOverlay,
} from './failed-overlay'

/**
 * Get canvas from a known node
 */
export function getCanvasFromNode(node: CanvasNode): Canvas {
	return node.canvas
}

export type DuplicateWithConnectionsResult = {
	canvas: Canvas
	newNodeId: string
}

const PLACEMENT_GAP = 20
const PLACEMENT_RADIUS = 20  // up to (2*R+1)² = 1681 candidate cells

// Default canvas node dimensions by type. Image/video actual dimensions are
// derived from the user-selected aspect ratio; these are the fallbacks.
export const DEFAULT_MEDIA_LONG_EDGE = 400   // image/video: long edge in canvas pixels
const DEFAULT_TEXT_SIZE = { w: 400, h: 200 }
const DEFAULT_AUDIO_SIZE = { w: 400, h: 100 }

/**
 * Compute canvas node dimensions for a generation output based on the user's
 * selected aspect ratio. This keeps the placeholder and the final file node
 * at the same size, so we don't re-run findFreePosition a second time.
 *
 * aspectRatio: e.g. "16:9", "1:1", "9:16", "3:4". Anything unparseable →
 * defaults to 4:3 landscape so the canvas doesn't shift.
 */
export function computeOutputSize(
	outputType: 'image' | 'video' | 'text' | 'audio',
	aspectRatio?: string,
): { w: number; h: number } {
	if (outputType === 'text') return { ...DEFAULT_TEXT_SIZE }
	if (outputType === 'audio') return { ...DEFAULT_AUDIO_SIZE }
	// image / video
	const { wRatio, hRatio } = parseAspectRatio(aspectRatio)
	// Long edge is fixed at DEFAULT_MEDIA_LONG_EDGE so cards stay a consistent
	// visual size regardless of orientation; short edge scales.
	if (wRatio >= hRatio) {
		return { w: DEFAULT_MEDIA_LONG_EDGE, h: Math.round(DEFAULT_MEDIA_LONG_EDGE * hRatio / wRatio) }
	}
	return { w: Math.round(DEFAULT_MEDIA_LONG_EDGE * wRatio / hRatio), h: DEFAULT_MEDIA_LONG_EDGE }
}

function parseAspectRatio(raw?: string): { wRatio: number; hRatio: number } {
	if (!raw) return { wRatio: 4, hRatio: 3 }
	const m = String(raw).match(/^(\d+)\s*[:x]\s*(\d+)$/)
	if (!m) return { wRatio: 4, hRatio: 3 }
	const w = parseInt(m[1], 10), h = parseInt(m[2], 10)
	if (!w || !h) return { wRatio: 4, hRatio: 3 }
	return { wRatio: w, hRatio: h }
}

function ratioParam(value: unknown): string | undefined {
	if (typeof value === 'string' && value.trim()) return value.trim()
	if (typeof value === 'number' && Number.isFinite(value)) return String(value)
	return undefined
}

function positiveIntParam(value: unknown): number | undefined {
	const parsed = typeof value === 'number' ? value : parseInt(ratioParam(value) || '', 10)
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined
	return Math.round(parsed)
}

/**
 * Pull the user-selected aspect ratio out of PanelResult.params. Accepts both
 * `aspectRatio` (most models) and `aspect_ratio` (kling, grok video) spellings.
 * Pixel-sized image models can also provide width/height.
 */
export function readAspectRatio(params?: Record<string, unknown>): string | undefined {
	if (!params) return undefined
	const explicit = ratioParam(params.aspectRatio) || ratioParam(params.aspect_ratio) || ratioParam(params.ratio)
	if (explicit) return explicit
	const width = positiveIntParam(params.width)
	const height = positiveIntParam(params.height)
	if (width && height) return `${width}:${height}`
	return undefined
}

interface BBox { x: number; y: number; w: number; h: number }

/**
 * Find a position for a new node that doesn't overlap any existing node.
 *
 * Strategy: 8-way spiral. Generate grid cells around (initialX, initialY) with
 * step (w+gap, h+gap), sort by Euclidean distance to the origin, and return
 * the first non-overlapping cell. This finds the *closest* free spot in any
 * direction — not just to the right — so nodes don't fly thousands of pixels
 * away on dense canvases.
 *
 * @param excludeId — id of a node to ignore during overlap check (e.g. the placeholder being replaced)
 */
export function findFreePosition(
	canvas: Canvas,
	initialX: number,
	initialY: number,
	width: number,
	height: number,
	excludeId?: string,
): { x: number; y: number } {
	const data = canvas.getData()
	const existing: BBox[] = []
	for (const n of (data.nodes || [])) {
		if (excludeId && n.id === excludeId) continue
		existing.push({ x: n.x, y: n.y, w: n.width, h: n.height })
	}

	const xStep = width + PLACEMENT_GAP
	const yStep = height + PLACEMENT_GAP

	const overlaps = (x: number, y: number) => {
		for (const e of existing) {
			if (x + width <= e.x || e.x + e.w <= x) continue
			if (y + height <= e.y || e.y + e.h <= y) continue
			return true
		}
		return false
	}

	// Build candidates sorted by distance. Stable tie-breakers:
	// 1) distance, 2) prefer right (dx >= 0), 3) prefer down (dy >= 0),
	// 4) smaller |dy|, 5) smaller |dx| — keeps behaviour feeling "to the right
	// of source first, then below, then around".
	const candidates: { dx: number; dy: number; dist: number }[] = []
	for (let dy = -PLACEMENT_RADIUS; dy <= PLACEMENT_RADIUS; dy++) {
		for (let dx = -PLACEMENT_RADIUS; dx <= PLACEMENT_RADIUS; dx++) {
			candidates.push({ dx, dy, dist: Math.hypot(dx, dy) })
		}
	}
	candidates.sort((a, b) => {
		if (a.dist !== b.dist) return a.dist - b.dist
		if ((a.dx >= 0) !== (b.dx >= 0)) return a.dx >= 0 ? -1 : 1
		if ((a.dy >= 0) !== (b.dy >= 0)) return a.dy >= 0 ? -1 : 1
		if (Math.abs(a.dy) !== Math.abs(b.dy)) return Math.abs(a.dy) - Math.abs(b.dy)
		return Math.abs(a.dx) - Math.abs(b.dx)
	})

	for (const c of candidates) {
		const x = initialX + c.dx * xStep
		const y = initialY + c.dy * yStep
		if (!overlaps(x, y)) return { x, y }
	}

	// Fallback: far below everything (should never happen given 1681 candidates)
	const maxY = existing.reduce((m, e) => Math.max(m, e.y + e.h), initialY)
	return { x: initialX, y: maxY + PLACEMENT_GAP }
}

// ── Generating overlay + ticker ──────────────────────────────────────────
//
// Instead of writing "Generating with X... (10s)" into the node's text (which
// looks ugly, forces the text to update every second, and leaves a readable
// breadcrumb if the task is interrupted), we attach a DOM overlay to the
// placeholder's node element. The node's actual text stays empty. A single
// global 1s ticker refreshes every overlay in the registry — one timer for N
// placeholders, not N timers.

interface GeneratingEntry {
	modelName: string
	startedAt: number
	overlay: GeneratingOverlayElements
	nodeEl: HTMLElement
	status: GeneratingStatus
}

const generatingRegistry = new Map<string, GeneratingEntry>()
let tickInterval: number | null = null

// Failure messages recorded this session, by placeholder ID. A stale canvas
// snapshot applied after a failure (a disk reload, undo) can restore
// `bragiGenerating`; the sweep then reapplies the real failure instead of
// reporting the placeholder as interrupted.
const recordedFailures = new Map<string, string>()

/**
 * Resolve the canvas's current runtime node for a placeholder captured when a
 * generation started, so late results never land on a detached node object.
 */
function livePlaceholder(node: CanvasNode, canvas: Canvas | undefined = node.canvas): CanvasNode {
	return canvas?.nodes.get(node.id) ?? node
}

function ensureTicker(): void {
	if (tickInterval) return
	tickInterval = window.setInterval(() => {
		if (generatingRegistry.size === 0) { stopTicker(); return }
		for (const entry of generatingRegistry.values()) {
			updateGeneratingOverlay(entry.overlay, entry.modelName, entry.startedAt, entry.status)
		}
	}, 1000)
}

function stopTicker(): void {
	if (tickInterval) { window.clearInterval(tickInterval); tickInterval = null }
}

/**
 * Attach (or replace) the generating overlay on a placeholder's DOM element.
 * Idempotent — calling twice just updates the existing overlay.
 */
function attachGeneratingOverlay(node: CanvasNode, modelName: string, startedAt: number, onResume?: () => void): void {
	const nodeEl = node.nodeEl || node.containerEl
	if (!nodeEl) return
	clearIncomingRefAttachments(node)
	let overlay = findGeneratingOverlay(nodeEl)
	if (!overlay) {
		nodeEl.querySelectorAll('.bragi-generating-overlay').forEach(el => {
			const loader = el.querySelector<HTMLElement>('.bragi-generating-loader')
			stopSquare19Loader(loader)
			el.remove()
		})
		overlay = createGeneratingOverlay()
		nodeEl.appendChild(overlay.overlayEl)
	}
	const data = node.getData()
	const status: GeneratingStatus = {
		label: typeof data.bragiGenStatus === 'string' ? data.bragiGenStatus : 'Generating',
		detail: typeof data.bragiGenDetail === 'string' ? data.bragiGenDetail : undefined,
		paused: data.bragiGenPaused === true,
		retryAt: typeof data.bragiGenRetryAt === 'number' ? data.bragiGenRetryAt : undefined,
		onResume: onResume || generatingRegistry.get(node.id)?.status.onResume,
		onDetails: () => openNodeDetails(node),
	}
	nodeEl.classList.toggle('bragi-checking-paused', !!status.paused)
	nodeEl.classList.toggle('bragi-generating-compact', typeof data.height === 'number' && data.height < 200)
	updateGeneratingOverlay(overlay, modelName, startedAt, status)
	generatingRegistry.set(node.id, { modelName, startedAt, overlay, nodeEl, status })
	ensureTicker()
}

/** Update the persistent placeholder presentation without changing its task identity. */
export function setGeneratingStatus(placeholder: CanvasNode, status: GeneratingStatus): void {
	const node = livePlaceholder(placeholder)
	const data = node.getData()
	if (data.type === 'file') return
	recordedFailures.delete(node.id)
	const rest = { ...data }
	delete rest.bragiGenerationFailed
	delete rest.bragiGenFailureTitle
	delete rest.bragiGenError
	const fields = { bragiGenerating: true, bragiGenStatus: status.label, bragiGenDetail: status.detail || '', bragiGenPaused: !!status.paused, bragiGenRetryAt: status.retryAt || 0 }
	if (data.bragiGenerationFailed || Object.entries(fields).some(([key, value]) => data[key] !== value)) {
		node.setData({ ...rest, ...fields })
	}
	const nodeEl = node.nodeEl || node.containerEl
	nodeEl?.classList.remove('bragi-generation-failed')
	nodeEl?.classList.add('bragi-generating')
	nodeEl?.querySelector('.bragi-failed-overlay')?.remove()
	const previous = generatingRegistry.get(node.id)
	if (previous) previous.status.onResume = status.onResume
	attachGeneratingOverlay(node, typeof data.bragiGenModelName === 'string' ? data.bragiGenModelName : 'Model', typeof data.bragiGenStartedAt === 'number' ? data.bragiGenStartedAt : Date.now(), status.onResume)
}

/** Apply generating shimmer + overlay to an existing text node (preview / rehydrate). */
export function styleGeneratingPlaceholder(
	node: CanvasNode,
	modelName: string,
	startedAt: number,
): void {
	node.setData({
		...node.getData(),
		color: '',
		bragiGenerating: true,
		bragiGenModelName: modelName,
		bragiGenStartedAt: startedAt,
	})
	const nodeEl = node.nodeEl || node.containerEl
	if (nodeEl) nodeEl.classList.add('bragi-generating')
	attachGeneratingOverlay(node, modelName, startedAt)
}

/**
 * Remove overlay + ticker tracking. Safe to call on a node that was never
 * registered (e.g. a ghost we're sweeping).
 */
export function detachGeneratingOverlay(nodeId: string, nodeEl?: HTMLElement | null): void {
	const entry = generatingRegistry.get(nodeId)
	if (entry) {
		stopGeneratingOverlayAnimation(entry.overlay)
		entry.overlay.overlayEl.remove()
		generatingRegistry.delete(nodeId)
	}
	// Defensive: strip any stray overlay even if the registry missed it
	nodeEl?.querySelectorAll('.bragi-generating-overlay').forEach(el => el.remove())
	if (generatingRegistry.size === 0) stopTicker()
}

/** Stop the ticker and clear overlays on plugin unload. */
export function stopGeneratingTicker(): void {
	for (const entry of generatingRegistry.values()) {
		stopGeneratingOverlayAnimation(entry.overlay)
		entry.overlay.overlayEl.remove()
	}
	generatingRegistry.clear()
	stopTicker()
}

/**
 * Save the canvas now instead of after Obsidian's debounced save, so a new
 * `bragiGenerating` placeholder reaches disk even if Obsidian reloads within
 * seconds. Silent on failure.
 *
 * Save through the view, never with `vault.adapter.write`: Obsidian treats an
 * adapter write as an external edit and reloads the whole canvas from disk a
 * few milliseconds later. That reload reverted a concurrent generation's
 * failure back to `bragiGenerating`, and the sweep then reported it as
 * interrupted.
 */
function flushCanvasSave(canvas: Canvas): void {
	void canvas.requestSave()
	void canvas.view?.save?.().catch((err: unknown) => console.debug('Bragi: canvas save skipped', err))
}

/**
 * Sweep the active canvas for placeholder nodes left over from a previous
 * session (canvas reload, Obsidian restart, crash). A placeholder is "a ghost"
 * iff it has `bragiGenerating: true` in canvas JSON but is not currently
 * tracked by an in-memory registry (TaskQueue or sync generation set). Ghosts
 * are marked red with an "interrupted" message — we never delete user data.
 * A placeholder whose generation already failed this session gets its recorded
 * failure back instead, and is not counted.
 *
 * Tracked placeholders (still running in this session) get their overlay and
 * shimmer class re-attached — the DOM elements are new on every canvas
 * activation, so any previous overlay reference is stale.
 *
 * Returns number of ghosts marked.
 */
export function sweepInterruptedPlaceholders(
	canvas: Canvas,
	isTracked: (nodeId: string) => boolean,
): number {
	let count = 0
	for (const node of canvas.nodes.values()) {
		const d = node.getData()
		if (d.bragiGenerating !== true) continue
		if (isTracked(node.id)) {
			// Rehydrate: DOM was recreated on canvas activate, reattach overlay + class
			const nodeEl = node.nodeEl || node.containerEl
			if (nodeEl) nodeEl.classList.add('bragi-generating')
			const modelName = d.bragiGenModelName || 'model'
			const startedAt = typeof d.bragiGenStartedAt === 'number' ? d.bragiGenStartedAt : Date.now()
			attachGeneratingOverlay(node, modelName, startedAt)
			continue
		}
		const failure = recordedFailures.get(node.id)
		if (failure !== undefined) {
			// This generation already failed; a stale snapshot brought the flag back.
			markNodeFailed(node, failure)
			continue
		}
		markNodeInterrupted(node)
		count++
	}
	return count
}

function attachFailedOverlay(node: CanvasNode, title: string, modelName?: string): void {
	const nodeEl = node.nodeEl || node.containerEl
	if (!nodeEl) return
	clearIncomingRefAttachments(node)
	let overlay = findFailedOverlay(nodeEl)
	if (!overlay) {
		nodeEl.querySelectorAll('.bragi-failed-overlay').forEach(el => el.remove())
		overlay = createFailedOverlay(title, modelName, () => openNodeDetails(node))
		nodeEl.appendChild(overlay.overlayEl)
	} else {
		updateFailedOverlay(overlay, title, modelName, () => openNodeDetails(node))
	}
}

/** Apply failed / interrupted visual overlay; stores error in node data, not on canvas text. */
export function styleFailedPlaceholder(node: CanvasNode, title: string, errorMsg?: string): void {
	const d = node.getData() as Record<string, unknown>
	const modelName = typeof d.bragiGenModelName === 'string' ? d.bragiGenModelName : ''
	const rest = { ...d }
	delete rest.ovidGenerating
	delete rest.bragiGenerating
	delete rest.bragiGenStartedAt
	delete rest.bragiGenStatus
	delete rest.bragiGenDetail
	delete rest.bragiGenPaused
	delete rest.bragiGenRetryAt
	node.setData({
		...rest,
		color: '',
		bragiGenerationFailed: true,
		bragiGenFailureTitle: title,
		bragiGenError: errorMsg ?? (typeof d.bragiGenError === 'string' ? d.bragiGenError : ''),
		...(modelName ? { bragiGenModelName: modelName } : {}),
	})
	void node.setText('')
	const nodeEl = node.nodeEl || node.containerEl
	nodeEl?.classList.remove('bragi-generating')
	nodeEl?.classList.add('bragi-generation-failed')
	detachGeneratingOverlay(node.id, nodeEl)
	attachFailedOverlay(node, title, modelName || undefined)
}

/** Reattach failed overlays after canvas reload; migrate legacy text-only failed nodes. */
export function rehydrateFailedPlaceholders(canvas: Canvas): void {
	for (const node of canvas.nodes.values()) {
		const d = node.getData() as Record<string, unknown>
		if (d.bragiGenerationFailed === true) {
			const title = typeof d.bragiGenFailureTitle === 'string' ? d.bragiGenFailureTitle : 'Generation Failed'
			const errorMsg = typeof d.bragiGenError === 'string' ? d.bragiGenError : undefined
			styleFailedPlaceholder(node, title, errorMsg)
			continue
		}
		const rawText = typeof node.text === 'string' ? node.text : typeof d.text === 'string' ? d.text : ''
		const text = rawText.trim()
		if (text.startsWith('Generation failed:')) {
			styleFailedPlaceholder(node, 'Generation Failed', text.slice('Generation failed:'.length).trim())
		} else if (text.startsWith('Generation interrupted:')) {
			styleFailedPlaceholder(node, 'Generation Interrupted', text)
		}
	}
}

/**
 * Create a placeholder text node with edge from source (shown during generation).
 * Placement uses collision avoidance: we never put the placeholder on top of
 * an existing node. The placeholder is sized to match the expected output so
 * we don't have to re-find a free spot when it's replaced. The "Generating…"
 * label is rendered as a DOM overlay, not written into the node's text — so
 * the node appears empty if the task is interrupted (and the ghost sweeper
 * can mark it cleanly).
 */
export function createPlaceholderNode(
	canvas: Canvas,
	modelName: string,
	sourceNode: CanvasNode,
	targetSize?: { w: number; h: number },
): CanvasNode {
	const sourceData = sourceNode.getData()
	const w = targetSize?.w ?? 400
	const h = targetSize?.h ?? 300
	const initialX = sourceData.x + sourceData.width + 50
	const initialY = sourceData.y
	const { x, y } = findFreePosition(canvas, initialX, initialY, w, h)

	const node = canvas.createTextNode({
		text: '',
		pos: { x, y },
		size: { width: w, height: h },
		focus: false,
	})

	const startedAt = Date.now()

	// Add edge from source to placeholder FIRST (before setData) so that the
	// subsequent setData call is the authoritative last write to the node —
	// importData with a stale nodes snapshot can otherwise clobber custom
	// fields like bragiGenerating.
	const currentData = canvas.getData()
	const edgeId = generateId()
	canvas.importData({
		nodes: currentData.nodes,
		edges: [...currentData.edges, {
			id: edgeId,
			fromNode: sourceNode.id,
			fromSide: 'right',
			toNode: node.id,
			toSide: 'left',
			toEnd: 'none',
		}],
	})

	// Now mark as generating: these custom fields are what the ghost sweeper
	// looks for on reload. They MUST land in the .canvas file, so we force an
	// immediate save — requestSave is debounced and would otherwise miss the
	// write if the user reloads within ~1s of starting generation.
	node.setData({ ...node.getData(), color: '', bragiGenerating: true, bragiGenModelName: modelName, bragiGenStartedAt: startedAt })
	// Fire-and-forget: the caller stays synchronous.
	flushCanvasSave(canvas)

	const nodeEl = node.nodeEl || node.containerEl
	if (nodeEl) nodeEl.classList.add('bragi-generating')
	attachGeneratingOverlay(node, modelName, startedAt)

	return node
}

/**
 * Replace a placeholder node with the actual file node + edge from source
 */
export function replacePlaceholderWithFile(
	canvas: Canvas,
	placeholder: CanvasNode,
	filePath: string,
	sourceNode: CanvasNode
): void {
	const live = livePlaceholder(placeholder, canvas)
	// Reuse the placeholder's exact position AND size — it was sized to match the
	// output when we created it, so there's no reason to reflow now. This avoids
	// a second collision-avoidance pass that used to shove the node around.
	const pd = live.getData()
	const x = live.x ?? pd.x
	const y = live.y ?? pd.y
	const width = pd.width ?? 400
	const height = pd.height ?? 300

	// Clean up overlay + ticker before the node disappears
	detachGeneratingOverlay(live.id, live.nodeEl || live.containerEl)
	// Remove placeholder first
	canvas.removeNode(live)

	const currentData = canvas.getData()

	const nodeId = generateId()
	const edgeId = generateId()

	const newNode = {
		id: nodeId,
		type: 'file' as const,
		file: filePath,
		x,
		y,
		width,
		height,
		color: '',
	}

	const newEdge = {
		id: edgeId,
		fromNode: sourceNode.id,
		fromSide: 'right',
		toNode: nodeId,
		toSide: 'left',
		toEnd: 'none',
	}

	canvas.importData({
		nodes: [...currentData.nodes, newNode],
		edges: [...currentData.edges, newEdge],
	})

	void canvas.requestSave()
}

/**
 * Mark a node as failed. Clears generating flags and overlay; stores the error
 * in node metadata (not visible on the node — for a future details UI).
 */
export function markNodeFailed(placeholder: CanvasNode, errorMsg: string): void {
	const node = livePlaceholder(placeholder)
	recordedFailures.set(node.id, errorMsg)
	styleFailedPlaceholder(node, 'Generation Failed', errorMsg)
	// Refresh the canvas save snapshot: the pending debounced save still holds
	// the data captured while this node was generating.
	void node.canvas?.requestSave()
}

/**
 * Mark a placeholder as interrupted (red) — called by the ghost sweeper when
 * a `bragiGenerating` node is found at startup but no in-memory task tracks it.
 */
export function markNodeInterrupted(node: CanvasNode): void {
	const d = node.getData() as Record<string, unknown>
	const modelName = typeof d.bragiGenModelName === 'string' ? d.bragiGenModelName : 'unknown model'
	const startedAt = typeof d.bragiGenStartedAt === 'number' ? d.bragiGenStartedAt : null
	const runtime = startedAt ? ` (ran ${Math.floor((Date.now() - startedAt) / 1000)}s before interruption)` : ''
	styleFailedPlaceholder(
		node,
		'Generation Interrupted',
		`Interrupted during ${modelName}${runtime}`,
	)
}

/**
 * Duplicate a node and recreate all its incoming (upstream) edges on the copy.
 * The new node is placed to the right of the original.
 */
export function duplicateWithConnections(canvas: Canvas, node: CanvasNode): DuplicateWithConnectionsResult | null {
	try {
	const targetCanvas = node.canvas || canvas
	const data = node.getData()
	const gap = 50

	if (data.type === 'text') {
		const width = data.width || 300
		const height = data.height || 100
		const nodeId = generateId()
		const currentData = targetCanvas.getData()
		const newNodeData: AllCanvasNodeData = {
			id: nodeId,
			type: 'text',
			text: data.text || node.text || '',
			x: data.x + width + gap,
			y: data.y,
			width,
			height,
		}
		if (data.color) newNodeData.color = data.color
		const imageOrder = data.bragiImageOrder || data.ovidImageOrder
		if (imageOrder) newNodeData.bragiImageOrder = [...imageOrder]
		const lastGen = data.bragiLastGen || data.ovidLastGen
		if (lastGen) newNodeData.bragiLastGen = { ...lastGen }

		const incomingEdges = getIncomingEdgeData(targetCanvas, node)
		const newEdges = incomingEdges.map(e => ({
			id: generateId(),
			fromNode: e.fromNode,
			fromSide: e.fromSide,
			fromEnd: e.fromEnd,
			toNode: nodeId,
			toSide: e.toSide,
			toEnd: e.toEnd,
		}))

		targetCanvas.importData({
			nodes: [...currentData.nodes, newNodeData],
			edges: [...currentData.edges, ...newEdges],
		})
		void targetCanvas.requestSave()
		// importData mutates the data model but does not repaint on its own; without
		// a frame request the duplicated node is saved to disk yet never rendered.
		try {
			void targetCanvas.requestFrame()
		} catch (frameErr) {
			console.debug('Bragi duplicate: canvas frame refresh skipped', frameErr)
		}
		return { canvas: targetCanvas, newNodeId: nodeId }
	} else if (data.type === 'file') {
		const nodeId = generateId()
		const currentData = targetCanvas.getData()
		const newNodeData = {
			id: nodeId,
			type: 'file' as const,
			file: data.file,
			x: data.x + data.width + gap,
			y: data.y,
			width: data.width,
			height: data.height,
			color: data.color || '',
			subpath: data.subpath,
		}

		const incomingEdges = getIncomingEdgeData(targetCanvas, node)
		const newEdges = incomingEdges.map(e => ({
			id: generateId(),
			fromNode: e.fromNode,
			fromSide: e.fromSide,
			fromEnd: e.fromEnd,
			toNode: nodeId,
			toSide: e.toSide,
			toEnd: e.toEnd,
		}))

		targetCanvas.importData({
			nodes: [...currentData.nodes, newNodeData],
			edges: [...currentData.edges, ...newEdges],
		})
		void targetCanvas.requestSave()
		// importData mutates the data model but does not repaint on its own; without
		// a frame request the duplicated node is saved to disk yet never rendered.
		try {
			void targetCanvas.requestFrame()
		} catch (frameErr) {
			console.debug('Bragi duplicate: canvas frame refresh skipped', frameErr)
		}
		return { canvas: targetCanvas, newNodeId: nodeId }
	}
	} catch (err) {
		console.error('[Bragi] duplicateWithConnections failed', err)
	}
	return null
}

function getIncomingEdgeData(canvas: Canvas, node: CanvasNode): Array<{
	fromNode: string
	fromSide: string
	fromEnd: string
	toSide: string
	toEnd: string
}> {
	const edges = canvas.getEdgesForNode(node)
	if (!edges) return []

	const result: Array<{ fromNode: string; fromSide: string; fromEnd: string; toSide: string; toEnd: string }> = []
	for (const edge of edges) {
		if (edge.to.node.id !== node.id) continue
		const edgeData = edge.getData?.() || edge
		result.push({
			fromNode: edge.from.node.id,
			fromSide: edgeData.fromSide || edge.from.side || 'right',
			fromEnd: edgeData.fromEnd || 'none',
			toSide: edgeData.toSide || edge.to.side || 'left',
			toEnd: edgeData.toEnd || 'arrow',
		})
	}
	return result
}

function generateId(): string {
	return Math.random().toString(36).substring(2, 18)
}

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

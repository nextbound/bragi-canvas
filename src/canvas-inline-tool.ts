import type { Canvas, CanvasNode } from './types/canvas-internal'

export type CanvasInlineToolToolbarPhase = 'hidden' | 'ready'

export type CanvasInlineToolContext<TAction> = {
	readonly id: string
	readonly canvas: Canvas
	readonly node: CanvasNode
	readonly wrapperEl: HTMLElement
	readonly sessionId: string
	readonly toolbarPhase: CanvasInlineToolToolbarPhase
	setToolbarPhase(phase: CanvasInlineToolToolbarPhase): void
	refreshToolbar(force?: boolean): void
	close(): void
	dispatchAction(action: TAction): void
}

export type CanvasInlineToolSessionOptions<TAction> = {
	id: string
	canvas: Canvas
	node: CanvasNode
	actionEvent: string
	renderToolbar: (menuEl: HTMLElement, context: CanvasInlineToolContext<TAction>) => void
	onAction: (action: TAction, context: CanvasInlineToolContext<TAction>) => void
	mountLayer?: (context: CanvasInlineToolContext<TAction>) => void
	isToolEventTarget?: (target: EventTarget | null) => boolean
	onReady?: (context: CanvasInlineToolContext<TAction>) => void
	onClose?: (context: CanvasInlineToolContext<TAction>) => void
	legacyModeClass?: string
	legacyTargetClass?: string
	legacyBodyClass?: string
	legacyContentClass?: string
	legacyDatasetPrefix?: string
}

type CanvasViewportSnapshot = Partial<Record<'x' | 'y' | 'tx' | 'ty' | 'zoom' | 'tZoom' | 'scale', number>>

type CanvasViewportTarget = {
	x: number
	y: number
	zoom: number
}

type CanvasViewportInternals = Canvas & {
	x?: number
	y?: number
	tx?: number
	ty?: number
	zoom?: number
	tZoom?: number
	scale?: number
	zoomCenter?: { x: number; y: number } | null
	finishViewportAnimation?: boolean
	markViewportChanged?: () => void
	menu?: {
		render?: (showButtons?: boolean) => void
		containerEl?: HTMLElement
		menuEl?: HTMLElement
	}
}

const MAX_CANVAS_ZOOM = 1
const VIEWPORT_ANIMATION_TIMEOUT_MS = 900
const VIEWPORT_FALLBACK_TOOLBAR_DELAY_MS = 350
const VIEWPORT_KEYS = ['x', 'y', 'tx', 'ty', 'zoom', 'tZoom', 'scale'] as const
const GATED_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'click', 'dblclick', 'wheel', 'contextmenu'] as const

let activeInlineToolSession: CanvasInlineToolSession<unknown> | null = null

function setActiveInlineToolSession(session: CanvasInlineToolSession<unknown>): void {
	activeInlineToolSession = session
}

function createId(): string {
	return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
}

function snapshotViewport(canvas: Canvas): CanvasViewportSnapshot {
	const internals = canvas as CanvasViewportInternals
	const snapshot: CanvasViewportSnapshot = {}
	for (const key of VIEWPORT_KEYS) {
		const value = internals[key]
		if (typeof value === 'number' && Number.isFinite(value)) snapshot[key] = value
	}
	return snapshot
}

function animateViewportTo(canvas: Canvas, x: number, y: number, zoom: number): CanvasViewportTarget | null {
	const internals = canvas as CanvasViewportInternals
	if (typeof internals.markViewportChanged !== 'function') return null
	internals.tx = x
	internals.ty = y
	internals.tZoom = zoom
	internals.zoomCenter = null
	internals.finishViewportAnimation = false
	internals.markViewportChanged()
	void canvas.requestFrame()
	return { x, y, zoom }
}

function readViewport(canvas: Canvas): CanvasViewportTarget | null {
	const internals = canvas as CanvasViewportInternals
	if (
		typeof internals.x !== 'number'
		|| typeof internals.y !== 'number'
		|| typeof internals.zoom !== 'number'
		|| !Number.isFinite(internals.x)
		|| !Number.isFinite(internals.y)
		|| !Number.isFinite(internals.zoom)
	) {
		return null
	}
	return { x: internals.x, y: internals.y, zoom: internals.zoom }
}

function isViewportAtTarget(canvas: Canvas, target: CanvasViewportTarget): boolean {
	const current = readViewport(canvas)
	if (!current) return false
	return Math.abs(current.x - target.x) <= 1
		&& Math.abs(current.y - target.y) <= 1
		&& Math.abs(current.zoom - target.zoom) <= 0.01
}

function waitForViewport(canvas: Canvas, target: CanvasViewportTarget | null, fallbackDelayMs = 0): Promise<void> {
	if (!target) {
		return fallbackDelayMs > 0
			? new Promise(resolve => window.setTimeout(resolve, fallbackDelayMs))
			: Promise.resolve()
	}
	const startedAt = performance.now()
	return new Promise(resolve => {
		const tick = () => {
			if (isViewportAtTarget(canvas, target) || performance.now() - startedAt >= VIEWPORT_ANIMATION_TIMEOUT_MS) {
				resolve()
				return
			}
			window.requestAnimationFrame(tick)
		}
		tick()
	})
}

function waitForAnimationFrames(count: number): Promise<void> {
	return new Promise(resolve => {
		const tick = (remaining: number): void => {
			if (remaining <= 0) {
				resolve()
				return
			}
			window.requestAnimationFrame(() => tick(remaining - 1))
		}
		tick(count)
	})
}

function restoreViewport(canvas: Canvas, snapshot: CanvasViewportSnapshot): CanvasViewportTarget | null {
	const internals = canvas as CanvasViewportInternals
	if (typeof snapshot.x === 'number' && typeof snapshot.y === 'number' && typeof snapshot.zoom === 'number') {
		const target = animateViewportTo(canvas, snapshot.x, snapshot.y, snapshot.zoom)
		if (target) return target
	}
	for (const key of VIEWPORT_KEYS) {
		const value = snapshot[key]
		if (typeof value === 'number' && Number.isFinite(value)) internals[key] = value
	}
	internals.finishViewportAnimation = true
	try {
		internals.markViewportChanged?.()
		void canvas.requestFrame()
	} catch (err) {
		console.debug('Bragi inline tool: viewport restore refresh skipped', err)
	}
	return null
}

function getNodeBBox(node: CanvasNode): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number } {
	const bbox = node.getBBox?.()
	if (bbox) return bbox
	return {
		minX: node.x,
		minY: node.y,
		maxX: node.x + node.width,
		maxY: node.y + node.height,
		width: node.width,
		height: node.height,
	}
}

function legacyKey(prefix: string, suffix: string): string {
	return `${prefix}${suffix}`
}

export class CanvasInlineToolSession<TAction> {
	private readonly sessionId = createId()
	private wrapperEl: HTMLElement | null = null
	private previousSelectionIds: string[] = []
	private viewportSnapshot: CanvasViewportSnapshot = {}
	private toolbarPhase: CanvasInlineToolToolbarPhase = 'hidden'
	private closed = false

	constructor(private readonly options: CanvasInlineToolSessionOptions<TAction>) {}

	get id(): string {
		return this.options.id
	}

	get canvas(): Canvas {
		return this.options.canvas
	}

	get node(): CanvasNode {
		return this.options.node
	}

	get targetNodeId(): string {
		return this.options.node.id
	}

	get phase(): CanvasInlineToolToolbarPhase {
		return this.toolbarPhase
	}

	get context(): CanvasInlineToolContext<TAction> | null {
		if (!this.wrapperEl) return null
		return this.createContext()
	}

	open(): void {
		if (activeInlineToolSession && activeInlineToolSession !== this) {
			activeInlineToolSession.close()
		}
		setActiveInlineToolSession(this)

		const wrapper = this.options.canvas.wrapperEl
		if (!wrapper) throw new Error('Could not find canvas wrapper')
		this.wrapperEl = wrapper
		this.previousSelectionIds = Array.from(this.options.canvas.selection || []).map(node => node.id)
		this.viewportSnapshot = snapshotViewport(this.options.canvas)

		this.applyModeState()
		wrapper.addEventListener(this.options.actionEvent, this.handleToolAction)
		for (const eventName of GATED_EVENTS) {
			wrapper.addEventListener(eventName, this.handleCanvasGate, { capture: true, passive: false })
		}

		this.options.node.nodeEl.classList.add('bragi-inline-tool-target')
		if (this.options.legacyTargetClass) this.options.node.nodeEl.classList.add(this.options.legacyTargetClass)
		if (this.options.legacyContentClass) this.options.node.contentEl.classList.add(this.options.legacyContentClass)

		const context = this.createContext()
		this.options.mountLayer?.(context)
		this.options.canvas.selectOnly(this.options.node, false)
		this.refreshToolbar()
		const target = this.focusTargetNode()
		this.refreshToolbar()
		void this.showToolbarAfterFocus(target)
	}

	close(): void {
		if (this.closed) return
		this.closed = true
		this.setToolbarPhase('hidden')
		this.hideToolbarMenu()
		this.options.onClose?.(this.createContext())
		if (this.wrapperEl) {
			this.wrapperEl.removeEventListener(this.options.actionEvent, this.handleToolAction)
		}
		const restoreTarget = restoreViewport(this.options.canvas, this.viewportSnapshot)
		void this.finishCloseAfterViewport(restoreTarget)
	}

	renderToolbar(menuEl: HTMLElement): void {
		this.options.renderToolbar(menuEl, this.createContext())
	}

	hideToolbarMenu(): void {
		const menu = (this.options.canvas as CanvasViewportInternals).menu
		const menuEl = menu?.menuEl || menu?.containerEl?.querySelector<HTMLElement>('.bragi-canvas-menu')
		if (!menuEl) return
		menuEl.classList.add('bragi-inline-tool-toolbar-hidden')
		menuEl.classList.add('bragi-annotation-toolbar-hidden')
	}

	setToolbarPhase(phase: CanvasInlineToolToolbarPhase): void {
		this.toolbarPhase = phase
		this.syncDataset()
	}

	refreshToolbar(force = false): void {
		if (this.closed && !force) return
		try {
			;(this.options.canvas as CanvasViewportInternals).menu?.render?.(true)
		} catch (err) {
			console.debug('Bragi inline tool: selection toolbar refresh skipped', err)
		}
	}

	dispatchAction(action: TAction): void {
		this.wrapperEl?.dispatchEvent(new CustomEvent<TAction>(this.options.actionEvent, { detail: action }))
	}

	private createContext(): CanvasInlineToolContext<TAction> {
		if (!this.wrapperEl) throw new Error('Canvas inline tool session is not open')
		return {
			id: this.options.id,
			canvas: this.options.canvas,
			node: this.options.node,
			wrapperEl: this.wrapperEl,
			sessionId: this.sessionId,
			toolbarPhase: this.toolbarPhase,
			setToolbarPhase: phase => this.setToolbarPhase(phase),
			refreshToolbar: force => this.refreshToolbar(force),
			close: () => this.close(),
			dispatchAction: action => this.dispatchAction(action),
		}
	}

	private applyModeState(): void {
		const wrapper = this.wrapperEl
		if (!wrapper) return
		activeDocument.body.classList.add('bragi-inline-tool-active')
		activeDocument.body.dataset.bragiInlineToolId = this.options.id
		activeDocument.body.dataset.bragiInlineToolSessionId = this.sessionId
		if (this.options.legacyBodyClass) activeDocument.body.classList.add(this.options.legacyBodyClass)
		if (this.options.legacyDatasetPrefix) {
			activeDocument.body.dataset[legacyKey(this.options.legacyDatasetPrefix, 'SessionId')] = this.sessionId
		}

		wrapper.classList.add('bragi-inline-tool-mode')
		if (this.options.legacyModeClass) wrapper.classList.add(this.options.legacyModeClass)
		this.syncDataset()
	}

	private syncDataset(): void {
		const wrapper = this.wrapperEl
		if (!wrapper) return
		wrapper.dataset.bragiInlineToolId = this.options.id
		wrapper.dataset.bragiInlineToolSessionId = this.sessionId
		wrapper.dataset.bragiInlineToolNodeId = this.options.node.id
		wrapper.dataset.bragiInlineToolToolbar = this.toolbarPhase
		if (this.toolbarPhase !== 'ready') delete wrapper.dataset.bragiInlineToolToolbarRevealed
		if (this.options.legacyDatasetPrefix) {
			const prefix = this.options.legacyDatasetPrefix
			wrapper.dataset[legacyKey(prefix, 'SessionId')] = this.sessionId
			wrapper.dataset[legacyKey(prefix, 'NodeId')] = this.options.node.id
			wrapper.dataset[legacyKey(prefix, 'Toolbar')] = this.toolbarPhase
			if (this.toolbarPhase !== 'ready') delete wrapper.dataset[legacyKey(prefix, 'ToolbarRevealed')]
		}
	}

	private focusTargetNode(): CanvasViewportTarget | null {
		this.options.node.focus()
		const bbox = getNodeBBox(this.options.node)
		const center = {
			x: (bbox.minX + bbox.maxX) / 2,
			y: (bbox.minY + bbox.maxY) / 2,
		}
		const target = animateViewportTo(this.options.canvas, center.x, center.y, MAX_CANVAS_ZOOM)
		if (target) return target
		if (typeof this.options.canvas.zoomToSelection === 'function') {
			this.options.canvas.zoomToSelection()
			void this.options.canvas.requestFrame()
		}
		return null
	}

	private async showToolbarAfterFocus(target: CanvasViewportTarget | null): Promise<void> {
		await waitForViewport(this.options.canvas, target, VIEWPORT_FALLBACK_TOOLBAR_DELAY_MS)
		await waitForAnimationFrames(2)
		if (this.closed) return
		this.setToolbarPhase('ready')
		this.options.onReady?.(this.createContext())
		this.refreshToolbar()
	}

	private readonly handleToolAction = (event: Event): void => {
		const action = (event as CustomEvent<TAction>).detail
		if (!action || this.closed) return
		this.options.onAction(action, this.createContext())
	}

	private readonly handleCanvasGate = (event: Event): void => {
		if (event.type !== 'wheel' && this.options.isToolEventTarget?.(event.target)) return
		event.preventDefault()
		event.stopPropagation()
		if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
	}

	private async finishCloseAfterViewport(target: CanvasViewportTarget | null): Promise<void> {
		await waitForViewport(this.options.canvas, target)
		const wrapper = this.wrapperEl
		const ownsWrapper = !wrapper || wrapper.dataset.bragiInlineToolSessionId === this.sessionId
		const ownsBody = activeDocument.body.dataset.bragiInlineToolSessionId === this.sessionId
		if (ownsBody) {
			activeDocument.body.classList.remove('bragi-inline-tool-active')
			delete activeDocument.body.dataset.bragiInlineToolId
			delete activeDocument.body.dataset.bragiInlineToolSessionId
			if (this.options.legacyBodyClass) activeDocument.body.classList.remove(this.options.legacyBodyClass)
			if (this.options.legacyDatasetPrefix) {
				delete activeDocument.body.dataset[legacyKey(this.options.legacyDatasetPrefix, 'SessionId')]
			}
		}
		if (wrapper) {
			for (const eventName of GATED_EVENTS) {
				wrapper.removeEventListener(eventName, this.handleCanvasGate, true)
			}
			if (ownsWrapper) {
				wrapper.classList.remove('bragi-inline-tool-mode')
				if (this.options.legacyModeClass) wrapper.classList.remove(this.options.legacyModeClass)
				delete wrapper.dataset.bragiInlineToolId
				delete wrapper.dataset.bragiInlineToolSessionId
				delete wrapper.dataset.bragiInlineToolNodeId
				delete wrapper.dataset.bragiInlineToolToolbar
				delete wrapper.dataset.bragiInlineToolToolbarRevealed
				if (this.options.legacyDatasetPrefix) {
					const prefix = this.options.legacyDatasetPrefix
					delete wrapper.dataset[legacyKey(prefix, 'SessionId')]
					delete wrapper.dataset[legacyKey(prefix, 'NodeId')]
					delete wrapper.dataset[legacyKey(prefix, 'Toolbar')]
					delete wrapper.dataset[legacyKey(prefix, 'ToolbarRevealed')]
				}
			}
		}
		if (!ownsWrapper) {
			if (activeInlineToolSession !== this) {
				this.options.node.nodeEl.classList.remove('bragi-inline-tool-target')
				if (this.options.legacyTargetClass) this.options.node.nodeEl.classList.remove(this.options.legacyTargetClass)
				if (this.options.legacyContentClass) this.options.node.contentEl.classList.remove(this.options.legacyContentClass)
			}
			return
		}
		this.options.node.nodeEl.classList.remove('bragi-inline-tool-target')
		if (this.options.legacyTargetClass) this.options.node.nodeEl.classList.remove(this.options.legacyTargetClass)
		if (this.options.legacyContentClass) this.options.node.contentEl.classList.remove(this.options.legacyContentClass)
		this.restoreSelection()
		activeDocument.body.dataset.bragiInlineToolRevealNativeToolbar = 'true'
		if (this.options.legacyDatasetPrefix) {
			activeDocument.body.dataset[legacyKey(this.options.legacyDatasetPrefix, 'RevealNativeToolbar')] = 'true'
		}
		this.refreshToolbar(true)
		if (activeInlineToolSession === this) activeInlineToolSession = null
	}

	private restoreSelection(): void {
		const nodes = this.previousSelectionIds
			.map(id => this.options.canvas.nodes.get(id))
			.filter((node): node is CanvasNode => Boolean(node))
		if (nodes.length === 0) {
			this.options.canvas.deselectAll()
			return
		}
		this.options.canvas.deselectAll()
		this.options.canvas.selectOnly(nodes[0], false)
		for (const node of nodes.slice(1)) {
			this.options.canvas.selection.add(node)
		}
	}
}

export function getActiveInlineToolSession(canvas?: Canvas): CanvasInlineToolSession<unknown> | null {
	if (!activeInlineToolSession) return null
	if (canvas && activeInlineToolSession.canvas !== canvas) return null
	return activeInlineToolSession
}

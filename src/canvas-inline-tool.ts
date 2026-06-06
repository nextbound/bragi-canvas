/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas node bounding-box internals are runtime-shaped data narrowed at use sites. */
import type { Canvas, CanvasNode } from './types/canvas-internal'
import { getSelectionBounds, positionNodeToolbar, NODE_TOOLBAR_GAP } from './node-toolbar-position'

export type CanvasInlineToolToolbarPhase = 'hidden' | 'ready'
export type CanvasInlineToolSessionState = 'opening' | 'active' | 'closing' | 'closed'

export type CanvasInlineToolFocusOptions = {
	maxZoom?: number
	topMarginPx?: number
	bottomMarginPx?: number
	sideMarginPx?: number
}

export type CanvasInlineToolContext<TAction> = {
	readonly id: string
	readonly canvas: Canvas
	readonly node: CanvasNode
	readonly wrapperEl: HTMLElement
	readonly sessionId: string
	readonly toolbarPhase: CanvasInlineToolToolbarPhase
	setToolbarPhase(phase: CanvasInlineToolToolbarPhase): void
	refreshToolbar(force?: boolean): void
	repositionToolbars(): void
	close(): void
	dispatchAction(action: TAction): void
}

/**
 * A bottom toolbar mounted by the framework as a node-relative, framework-owned
 * element. Mirrors the top toolbar (which reuses the native selection menu) but
 * lives as a custom div positioned a fixed gap below the node — matching the
 * generate bar's positioning model (see node-toolbar-position.ts).
 */
export type CanvasInlineToolBottomToolbar<TAction> = {
	/** Populate the framework-owned bottom bar element. Called once at mount. */
	render: (barEl: HTMLElement, context: CanvasInlineToolContext<TAction>) => void
	/** Optional extra class on the bar element (e.g. 'bragi-video-edit-bar'). */
	className?: string
}

export type CanvasInlineToolSessionOptions<TAction> = {
	id: string
	canvas: Canvas
	node: CanvasNode
	actionEvent: string
	renderToolbar?: (menuEl: HTMLElement, context: CanvasInlineToolContext<TAction>) => void
	bottomToolbar?: CanvasInlineToolBottomToolbar<TAction>
	onAction: (action: TAction, context: CanvasInlineToolContext<TAction>) => void
	mountLayer?: (context: CanvasInlineToolContext<TAction>) => void
	isToolEventTarget?: (target: EventTarget | null) => boolean
	onKeyDown?: (event: KeyboardEvent, context: CanvasInlineToolContext<TAction>) => void
	onReady?: (context: CanvasInlineToolContext<TAction>) => void
	onClose?: (context: CanvasInlineToolContext<TAction>) => void
	focusOptions?: CanvasInlineToolFocusOptions
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
	scale: number
}

type CanvasTargetGeometry = {
	center: {
		x: number
		y: number
	}
	width: number
	height: number
}

type ScreenRect = {
	left: number
	top: number
	right: number
	bottom: number
	width: number
	height: number
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

const DEFAULT_INLINE_TOOL_MAX_ZOOM = 1
const MIN_INLINE_TOOL_ZOOM = 0.1
const DEFAULT_INLINE_TOOL_SIDE_MARGIN_PX = 32
const DEFAULT_INLINE_TOOL_TOOLBAR_HEIGHT_PX = 44
const INLINE_TOOL_TOOLBAR_TOP_GAP_PX = 12
const INLINE_TOOL_BOTTOM_GAP_PX = 32
const INLINE_TOOL_RENDERED_FIT_PADDING_PX = 12
const INLINE_TOOL_RENDERED_CORRECTION_PASSES = 2
const VIEWPORT_ANIMATION_TIMEOUT_MS = 900
const VIEWPORT_FALLBACK_TOOLBAR_DELAY_MS = 350
const VIEWPORT_KEYS = ['x', 'y', 'tx', 'ty', 'zoom', 'tZoom', 'scale'] as const
const GATED_EVENTS = ['pointerdown', 'pointermove', 'pointerup', 'click', 'dblclick', 'wheel', 'contextmenu'] as const

const activeInlineToolSessions = new WeakMap<HTMLElement, CanvasInlineToolSession<unknown>>()

function setActiveInlineToolSession(wrapper: HTMLElement, session: CanvasInlineToolSession<unknown>): void {
	activeInlineToolSessions.set(wrapper, session)
}

function clearActiveInlineToolSession(wrapper: HTMLElement | null, session: CanvasInlineToolSession<unknown>): void {
	if (!wrapper) return
	if (activeInlineToolSessions.get(wrapper) === session) activeInlineToolSessions.delete(wrapper)
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
	return { x, y, zoom, scale: resolveViewportScale(zoom, internals.scale) }
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
	return {
		x: internals.x,
		y: internals.y,
		zoom: internals.zoom,
		scale: resolveViewportScale(internals.zoom, internals.scale),
	}
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

function finiteNumber(value: number | undefined, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function resolveViewportScale(zoom: number, scale: number | undefined): number {
	if (typeof scale === 'number' && Number.isFinite(scale) && scale > 0) return scale
	return Math.max(0.001, Math.pow(2, zoom))
}

function isLogarithmicZoom(viewport: Pick<CanvasViewportTarget, 'zoom' | 'scale'>): boolean {
	return Math.abs(Math.log2(viewport.scale) - viewport.zoom) <= 0.05
}

function scaleToZoom(scale: number, reference: Pick<CanvasViewportTarget, 'zoom' | 'scale'> | null): number {
	const safeScale = Math.max(0.001, scale)
	if (!reference || isLogarithmicZoom(reference)) return Math.log2(safeScale)
	if (reference.zoom > 0 && Math.abs(reference.scale - reference.zoom) <= Math.max(0.02, reference.scale * 0.05)) {
		return safeScale
	}
	return Math.log2(safeScale)
}

function zoomToScale(zoom: number, reference: Pick<CanvasViewportTarget, 'zoom' | 'scale'> | null): number {
	if (!reference || isLogarithmicZoom(reference)) return Math.pow(2, zoom)
	if (reference.zoom > 0 && Math.abs(reference.scale - reference.zoom) <= Math.max(0.02, reference.scale * 0.05)) {
		return Math.max(0.001, zoom)
	}
	return Math.pow(2, zoom)
}

function screenRectFromBounds(left: number, top: number, right: number, bottom: number): ScreenRect {
	return {
		left,
		top,
		right,
		bottom,
		width: Math.max(1, right - left),
		height: Math.max(1, bottom - top),
	}
}

function screenRectFromDomRect(rect: DOMRect): ScreenRect {
	return screenRectFromBounds(rect.left, rect.top, rect.right, rect.bottom)
}

function getWindowViewportRect(doc: Document): ScreenRect {
	const view = doc.defaultView || window
	const layoutRect = screenRectFromBounds(0, 0, view.innerWidth, view.innerHeight)
	const visualViewport = view.visualViewport
	if (!visualViewport) return layoutRect
	const visualRect = screenRectFromBounds(
		visualViewport.offsetLeft,
		visualViewport.offsetTop,
		visualViewport.offsetLeft + visualViewport.width,
		visualViewport.offsetTop + visualViewport.height,
	)
	const left = Math.max(layoutRect.left, visualRect.left)
	const top = Math.max(layoutRect.top, visualRect.top)
	const right = Math.min(layoutRect.right, visualRect.right)
	const bottom = Math.min(layoutRect.bottom, visualRect.bottom)
	if (right <= left || bottom <= top) return layoutRect
	return screenRectFromBounds(left, top, right, bottom)
}

function getVisibleViewportRect(wrapper: HTMLElement): ScreenRect {
	const wrapperRect = wrapper.getBoundingClientRect()
	const viewportRect = getWindowViewportRect(wrapper.ownerDocument || activeDocument)
	const left = Math.max(wrapperRect.left, viewportRect.left)
	const top = Math.max(wrapperRect.top, viewportRect.top)
	const right = Math.min(wrapperRect.right, viewportRect.right)
	const bottom = Math.min(wrapperRect.bottom, viewportRect.bottom)
	if (right <= left || bottom <= top) return screenRectFromDomRect(wrapperRect)
	return screenRectFromBounds(left, top, right, bottom)
}

function getSelectionMenuEl(canvas: Canvas): HTMLElement | null {
	const menu = (canvas as CanvasViewportInternals).menu
	return menu?.menuEl
		|| menu?.containerEl?.querySelector<HTMLElement>('.bragi-canvas-menu')
		|| canvas.wrapperEl?.querySelector<HTMLElement>('.bragi-canvas-menu')
		|| null
}

function getInlineToolbarEl(canvas: Canvas): HTMLElement | null {
	const menuEl = getSelectionMenuEl(canvas)
	const sessionId = canvas.wrapperEl?.dataset.bragiInlineToolSessionId
	if (
		menuEl?.classList.contains('bragi-inline-tool-menu-inline')
		&& (!sessionId || menuEl.dataset.bragiInlineToolSessionId === sessionId)
	) {
		return menuEl
	}
	if (!sessionId) return null
	return activeDocument.querySelector<HTMLElement>(
		`.bragi-canvas-menu.bragi-inline-tool-menu-inline[data-bragi-inline-tool-session-id="${sessionId}"]`,
	)
}

function measureElementHeight(el: HTMLElement | null): number {
	if (!el) return 0
	const rect = el.getBoundingClientRect()
	return Number.isFinite(rect.height) ? rect.height : 0
}

function measureInlineToolbarHeight(canvas: Canvas): number {
	return measureElementHeight(getInlineToolbarEl(canvas))
		|| measureElementHeight(getSelectionMenuEl(canvas))
		|| DEFAULT_INLINE_TOOL_TOOLBAR_HEIGHT_PX
}

function measureTopChromeOverlap(wrapper: HTMLElement): number {
	const wrapperRect = wrapper.getBoundingClientRect()
	let overlap = 0
	for (const el of activeDocument.querySelectorAll<HTMLElement>('.workspace-tab-header-container, .view-header, .titlebar')) {
		const rect = el.getBoundingClientRect()
		if (rect.width <= 0 || rect.height <= 0) continue
		const intersectsHorizontally = rect.right > wrapperRect.left && rect.left < wrapperRect.right
		if (!intersectsHorizontally || rect.bottom <= wrapperRect.top) continue
		overlap = Math.max(overlap, rect.bottom - wrapperRect.top)
	}
	return Math.max(0, overlap)
}

function measureBottomChromeTop(wrapper: HTMLElement, visibleRect: ScreenRect): number {
	const wrapperRect = wrapper.getBoundingClientRect()
	let chromeTop = visibleRect.bottom
	for (const el of wrapper.querySelectorAll<HTMLElement>('.canvas-card-menu:not(.bragi-canvas-menu)')) {
		const rect = el.getBoundingClientRect()
		if (rect.width <= 0 || rect.height <= 0) continue
		const intersectsHorizontally = rect.right > wrapperRect.left && rect.left < wrapperRect.right
		if (!intersectsHorizontally) continue
		if (rect.top < visibleRect.top || rect.top > visibleRect.bottom) continue
		chromeTop = Math.min(chromeTop, rect.top)
	}
	return chromeTop
}

/**
 * Vertical space (in screen px) that each toolbar needs OUTSIDE the node: the
 * toolbar's own measured height plus the node gap. The safe rect reserves this
 * above (top toolbar) and below (bottom toolbar) so both bars sit a fixed gap
 * from the node and stay on-screen — replacing the old viewport-top pin and the
 * video-edit `bottomMarginPx` magic number.
 */
type ToolbarMetrics = {
	topReserve: number
	bottomReserve: number
}

function calculateSafeScreenRect(
	wrapper: HTMLElement,
	focusOptions: CanvasInlineToolFocusOptions | undefined,
	metrics: ToolbarMetrics,
): ScreenRect {
	const visibleRect = getVisibleViewportRect(wrapper)
	const sideMargin = finiteNumber(focusOptions?.sideMarginPx, DEFAULT_INLINE_TOOL_SIDE_MARGIN_PX)
	const bottomChromeTop = measureBottomChromeTop(wrapper, visibleRect)
	const topChromeOverlap = measureTopChromeOverlap(wrapper)
	const top = focusOptions?.topMarginPx !== undefined
		? visibleRect.top + focusOptions.topMarginPx
		: visibleRect.top + topChromeOverlap + INLINE_TOOL_TOOLBAR_TOP_GAP_PX + metrics.topReserve
	const viewportBottom = focusOptions?.bottomMarginPx !== undefined
		? visibleRect.bottom - focusOptions.bottomMarginPx
		: visibleRect.bottom - INLINE_TOOL_BOTTOM_GAP_PX - metrics.bottomReserve
	const bottom = Math.min(viewportBottom, bottomChromeTop - INLINE_TOOL_BOTTOM_GAP_PX)
	const left = visibleRect.left + sideMargin
	const right = visibleRect.right - sideMargin
	return screenRectFromBounds(
		Math.min(left, right - 1),
		Math.min(top, bottom - 1),
		right,
		bottom,
	)
}

function calculateFocusTarget(
	canvas: Canvas,
	node: CanvasNode,
	wrapper: HTMLElement,
	focusOptions: CanvasInlineToolFocusOptions | undefined,
	metrics: ToolbarMetrics,
): CanvasViewportTarget {
	const bbox = getNodeBBox(node)
	const wrapperRect = wrapper.getBoundingClientRect()
	const safeRect = calculateSafeScreenRect(wrapper, focusOptions, metrics)
	const current = readViewport(canvas)
	const maxZoom = finiteNumber(focusOptions?.maxZoom, DEFAULT_INLINE_TOOL_MAX_ZOOM)
	const maxScale = zoomToScale(maxZoom, current)
	const targetGeometry = getRenderedTargetGeometry(canvas, node, wrapper) || getBboxTargetGeometry(bbox)
	const paddedSafeWidth = Math.max(1, safeRect.width - INLINE_TOOL_RENDERED_FIT_PADDING_PX * 2)
	const paddedSafeHeight = Math.max(1, safeRect.height - INLINE_TOOL_RENDERED_FIT_PADDING_PX * 2)
	const fitScale = Math.min(maxScale, paddedSafeWidth / targetGeometry.width, paddedSafeHeight / targetGeometry.height)
	const scale = Math.max(zoomToScale(MIN_INLINE_TOOL_ZOOM, current), fitScale)
	const zoom = scaleToZoom(scale, current)
	const wrapperCenter = {
		x: wrapperRect.left + wrapperRect.width / 2,
		y: wrapperRect.top + wrapperRect.height / 2,
	}
	const safeCenter = {
		x: safeRect.left + safeRect.width / 2,
		y: safeRect.top + safeRect.height / 2,
	}
	return {
		x: targetGeometry.center.x - (safeCenter.x - wrapperCenter.x) / scale,
		y: targetGeometry.center.y - (safeCenter.y - wrapperCenter.y) / scale,
		zoom,
		scale,
	}
}

function getBboxTargetGeometry(bbox: { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number }): CanvasTargetGeometry {
	const bboxWidth = Math.max(1, bbox.width || bbox.maxX - bbox.minX)
	const bboxHeight = Math.max(1, bbox.height || bbox.maxY - bbox.minY)
	return {
		center: {
			x: (bbox.minX + bbox.maxX) / 2,
			y: (bbox.minY + bbox.maxY) / 2,
		},
		width: bboxWidth,
		height: bboxHeight,
	}
}

function getRenderedTargetGeometry(canvas: Canvas, node: CanvasNode, wrapper: HTMLElement): CanvasTargetGeometry | null {
	const current = readViewport(canvas)
	if (!current || current.scale <= 0) return null
	const contentRect = node.contentEl.getBoundingClientRect()
	const nodeElRect = node.nodeEl.getBoundingClientRect()
	const renderedRect = contentRect.width > 0 && contentRect.height > 0 ? contentRect : nodeElRect
	if (renderedRect.width <= 0 || renderedRect.height <= 0) return null

	const bbox = getNodeBBox(node)
	const bboxGeometry = getBboxTargetGeometry(bbox)
	const renderedContentWidth = contentRect.width > 0 ? contentRect.width / current.scale : 0
	const renderedContentHeight = contentRect.height > 0 ? contentRect.height / current.scale : 0
	const renderedNodeWidth = nodeElRect.width > 0 ? nodeElRect.width / current.scale : 0
	const renderedNodeHeight = nodeElRect.height > 0 ? nodeElRect.height / current.scale : 0

	const wrapperRect = wrapper.getBoundingClientRect()
	const wrapperCenter = {
		x: wrapperRect.left + wrapperRect.width / 2,
		y: wrapperRect.top + wrapperRect.height / 2,
	}
	return {
		center: {
			x: current.x + (renderedRect.left + renderedRect.width / 2 - wrapperCenter.x) / current.scale,
			y: current.y + (renderedRect.top + renderedRect.height / 2 - wrapperCenter.y) / current.scale,
		},
		width: Math.max(1, bboxGeometry.width, renderedContentWidth, renderedNodeWidth),
		height: Math.max(1, bboxGeometry.height, renderedContentHeight, renderedNodeHeight),
	}
}

function calculateRenderedCorrectionTarget(
	canvas: Canvas,
	node: CanvasNode,
	wrapper: HTMLElement,
	focusOptions: CanvasInlineToolFocusOptions | undefined,
	metrics: ToolbarMetrics,
): CanvasViewportTarget | null {
	const current = readViewport(canvas)
	if (!current) return null
	const contentRect = node.contentEl.getBoundingClientRect()
	const nodeRect = contentRect.width > 0 && contentRect.height > 0 ? contentRect : node.nodeEl.getBoundingClientRect()
	if (nodeRect.width <= 0 || nodeRect.height <= 0) return null
	const safeRect = calculateSafeScreenRect(wrapper, focusOptions, metrics)
	const maxZoom = finiteNumber(focusOptions?.maxZoom, DEFAULT_INLINE_TOOL_MAX_ZOOM)
	const maxScale = zoomToScale(maxZoom, current)
	const paddedSafeWidth = Math.max(1, safeRect.width - INLINE_TOOL_RENDERED_FIT_PADDING_PX * 2)
	const paddedSafeHeight = Math.max(1, safeRect.height - INLINE_TOOL_RENDERED_FIT_PADDING_PX * 2)
	const fitRatio = Math.min(1, paddedSafeWidth / nodeRect.width, paddedSafeHeight / nodeRect.height)
	const overlapsSafeRect = nodeRect.top < safeRect.top
		|| nodeRect.bottom > safeRect.bottom
		|| nodeRect.left < safeRect.left
		|| nodeRect.right > safeRect.right
	if (fitRatio >= 0.999 && !overlapsSafeRect) return null

	const targetGeometry = getRenderedTargetGeometry(canvas, node, wrapper) || getBboxTargetGeometry(getNodeBBox(node))
	const scale = Math.max(zoomToScale(MIN_INLINE_TOOL_ZOOM, current), Math.min(maxScale, current.scale * fitRatio))
	const zoom = scaleToZoom(scale, current)
	const wrapperRect = wrapper.getBoundingClientRect()
	const wrapperCenter = {
		x: wrapperRect.left + wrapperRect.width / 2,
		y: wrapperRect.top + wrapperRect.height / 2,
	}
	const safeCenter = {
		x: safeRect.left + safeRect.width / 2,
		y: safeRect.top + safeRect.height / 2,
	}
	return {
		x: targetGeometry.center.x - (safeCenter.x - wrapperCenter.x) / scale,
		y: targetGeometry.center.y - (safeCenter.y - wrapperCenter.y) / scale,
		zoom,
		scale,
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
	private sessionState: CanvasInlineToolSessionState = 'closed'
	private keyboardScopeActive = false
	private bottomBarEl: HTMLElement | null = null
	private positionRAF: number | null = null
	/** Elevate the target node above the dimmed siblings. Obsidian writes z-index inline on
	   .canvas-node, which no stylesheet rule can beat, so we set it inline too and restore the
	   captured prior value on close. `null` = not currently elevated. */
	private readonly TARGET_NODE_Z_INDEX = '50'
	private prevNodeZIndex: string | null = null
	private nodeZIndexElevated = false

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

	get state(): CanvasInlineToolSessionState {
		return this.sessionState
	}

	get context(): CanvasInlineToolContext<TAction> | null {
		if (!this.wrapperEl) return null
		return this.createContext()
	}

	isActive(): boolean {
		return (this.sessionState === 'opening' || this.sessionState === 'active') && this.wrapperEl?.isConnected === true
	}

	open(): void {
		const wrapper = this.options.canvas.wrapperEl
		if (!wrapper) throw new Error('Could not find canvas wrapper')
		const existingSession = activeInlineToolSessions.get(wrapper)
		if (existingSession && existingSession !== this) existingSession.close()
		setActiveInlineToolSession(wrapper, this)
		this.sessionState = 'opening'
		this.wrapperEl = wrapper
		this.previousSelectionIds = Array.from(this.options.canvas.selection || []).map(node => node.id)
		this.viewportSnapshot = snapshotViewport(this.options.canvas)

		this.applyModeState()
		wrapper.addEventListener(this.options.actionEvent, this.handleToolAction)
		for (const eventName of GATED_EVENTS) {
			wrapper.addEventListener(eventName, this.handleCanvasGate, { capture: true, passive: false })
		}
		this.installKeyboardListeners()

		this.options.node.nodeEl.classList.add('bragi-inline-tool-target')
		if (this.options.legacyTargetClass) this.options.node.nodeEl.classList.add(this.options.legacyTargetClass)
		if (this.options.legacyContentClass) this.options.node.contentEl.classList.add(this.options.legacyContentClass)

		const context = this.createContext()
		this.options.mountLayer?.(context)
		this.mountBottomToolbar(context)
		this.options.canvas.selectOnly(this.options.node, false)
		this.refreshToolbar()
		const target = this.focusTargetNode()
		// Elevate AFTER focusTargetNode(): node.focus()/zoomToSelection() rewrite the node's
		// inline z-index, so setting it earlier would be clobbered. The position loop re-asserts.
		this.elevateTargetNode()
		this.refreshToolbar()
		void this.showToolbarAfterFocus(target)
	}

	private mountBottomToolbar(context: CanvasInlineToolContext<TAction>): void {
		const bottomToolbar = this.options.bottomToolbar
		const wrapper = this.wrapperEl
		if (!bottomToolbar || !wrapper) return
		const bar = createDiv({ cls: 'bragi-inline-tool-bottom-bar' })
		if (bottomToolbar.className) bar.classList.add(bottomToolbar.className)
		// Start hidden (visibility:hidden, NOT display:none) so it can still be measured
		// for the safe-rect fit while the open zoom animation runs.
		bar.classList.add('bragi-inline-tool-bottom-bar-hidden')
		bar.dataset.bragiInlineToolId = this.options.id
		bar.dataset.bragiInlineToolSessionId = this.sessionId
		bar.dataset.bragiInlineToolNodeId = this.options.node.id
		bar.addEventListener('pointerdown', event => event.stopPropagation())
		bar.addEventListener('click', event => event.stopPropagation())
		wrapper.appendChild(bar)
		this.bottomBarEl = bar
		bottomToolbar.render(bar, context)
	}

	close(): void {
		if (this.sessionState === 'closing' || this.sessionState === 'closed') return
		this.sessionState = 'closing'
		this.stopPositionLoop()
		this.suppressNativeToolbar()
		clearActiveInlineToolSession(this.wrapperEl, this)
		this.setToolbarPhase('hidden')
		this.hideToolbarMenu()
		this.removeKeyboardListeners()
		this.options.onClose?.(this.createContext())
		if (this.wrapperEl) {
			this.wrapperEl.removeEventListener(this.options.actionEvent, this.handleToolAction)
		}
		const restoreTarget = restoreViewport(this.options.canvas, this.viewportSnapshot)
		void this.finishCloseAfterViewport(restoreTarget)
	}

	renderToolbar(menuEl: HTMLElement): void {
		if (!this.options.renderToolbar) return
		this.tagToolbarMenu(menuEl)
		this.options.renderToolbar(menuEl, this.createContext())
	}

	hideToolbarMenu(): void {
		const menu = (this.options.canvas as CanvasViewportInternals).menu
		const menuEl = menu?.menuEl || menu?.containerEl?.querySelector<HTMLElement>('.bragi-canvas-menu')
		const inlineMenus = new Set<HTMLElement>()
		if (menuEl) inlineMenus.add(menuEl)
		activeDocument.querySelectorAll<HTMLElement>(
			`.bragi-canvas-menu.bragi-inline-tool-menu-inline[data-bragi-inline-tool-session-id="${this.sessionId}"], .bragi-canvas-menu.bragi-annotation-menu-inline[data-bragi-inline-tool-session-id="${this.sessionId}"]`,
		)
			.forEach(el => inlineMenus.add(el))
		for (const el of inlineMenus) {
			el.classList.add('bragi-inline-tool-toolbar-hidden')
			el.classList.add('bragi-annotation-toolbar-hidden')
			el.querySelectorAll('.bragi-menu-injected').forEach(child => child.remove())
			el.classList.remove('bragi-inline-tool-menu-inline')
			el.classList.remove('bragi-annotation-menu-inline')
			this.clearToolbarMenuTag(el)
		}
	}

	primeNativeToolbarFadeIn(): void {
		const menuEl = getSelectionMenuEl(this.options.canvas)
		if (!menuEl) return
		menuEl.classList.remove('bragi-native-toolbar-suppressed')
		menuEl.classList.add('bragi-native-toolbar-fade', 'bragi-native-toolbar-hidden')
	}

	setToolbarPhase(phase: CanvasInlineToolToolbarPhase): void {
		this.toolbarPhase = phase
		this.syncDataset()
		if (this.bottomBarEl) {
			this.bottomBarEl.classList.toggle('bragi-inline-tool-bottom-bar-hidden', phase !== 'ready')
		}
	}

	refreshToolbar(force = false): void {
		if (!this.isActive() && !force) return
		try {
			;(this.options.canvas as CanvasViewportInternals).menu?.render?.(true)
		} catch (err) {
			console.debug('Bragi inline tool: selection toolbar refresh skipped', err)
		}
		this.requestReposition()
	}

	/** Re-position both toolbars relative to the node, debounced through rAF. */
	requestReposition(): void {
		if (this.positionRAF !== null) return
		this.positionRAF = window.requestAnimationFrame(() => {
			this.positionRAF = null
			this.repositionToolbars()
		})
	}

	/** Set the target node's inline z-index so it lifts above the dimmed siblings, capturing
	   Obsidian's prior inline value once so it can be restored on close. */
	private elevateTargetNode(): void {
		const nodeEl = this.options.node.nodeEl
		if (!this.nodeZIndexElevated) {
			this.prevNodeZIndex = nodeEl.style.zIndex || null
			this.nodeZIndexElevated = true
		}
		if (nodeEl.style.zIndex !== this.TARGET_NODE_Z_INDEX) {
			nodeEl.style.zIndex = this.TARGET_NODE_Z_INDEX
		}
	}

	/** Restore the node's inline z-index to whatever Obsidian had set before we elevated it. */
	private restoreTargetNodeZIndex(): void {
		if (!this.nodeZIndexElevated) return
		const nodeEl = this.options.node.nodeEl
		if (this.prevNodeZIndex === null) nodeEl.style.removeProperty('z-index')
		else nodeEl.style.zIndex = this.prevNodeZIndex
		this.nodeZIndexElevated = false
		this.prevNodeZIndex = null
	}

	private repositionToolbars(): void {
		if (!this.isActive()) return
		// Re-assert the elevated z-index each frame: Obsidian rewrites the node's inline
		// z-index during interaction, so this keeps us winning the way !important used to.
		if (this.nodeZIndexElevated) this.elevateTargetNode()
		const bounds = getSelectionBounds([this.options.node])
		if (!bounds) return
		const topEl = getInlineToolbarEl(this.options.canvas)
		if (topEl) positionNodeToolbar(topEl, bounds, { placement: 'above' })
		if (this.bottomBarEl) {
			positionNodeToolbar(this.bottomBarEl, bounds, { placement: 'below' })
		}
	}

	/** Continuously track the node so the toolbars follow pan/zoom/resize. */
	private startPositionLoop(): void {
		const tick = (): void => {
			if (!this.isActive()) {
				this.positionRAF = null
				return
			}
			this.repositionToolbars()
			this.positionRAF = window.requestAnimationFrame(tick)
		}
		if (this.positionRAF !== null) window.cancelAnimationFrame(this.positionRAF)
		this.positionRAF = window.requestAnimationFrame(tick)
	}

	private stopPositionLoop(): void {
		if (this.positionRAF !== null) {
			window.cancelAnimationFrame(this.positionRAF)
			this.positionRAF = null
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
			repositionToolbars: () => this.requestReposition(),
			close: () => this.close(),
			dispatchAction: action => this.dispatchAction(action),
		}
	}

	private applyModeState(): void {
		const wrapper = this.wrapperEl
		if (!wrapper) return
		delete wrapper.dataset.bragiInlineToolSuppressNativeToolbar
		delete wrapper.dataset.bragiInlineToolRevealNativeToolbar
		activeDocument.body.classList.add('bragi-inline-tool-active')
		activeDocument.body.dataset.bragiInlineToolId = this.options.id
		activeDocument.body.dataset.bragiInlineToolSessionId = this.sessionId
		if (this.options.legacyBodyClass) activeDocument.body.classList.add(this.options.legacyBodyClass)
		if (this.options.legacyDatasetPrefix) {
			delete wrapper.dataset[legacyKey(this.options.legacyDatasetPrefix, 'SuppressNativeToolbar')]
			delete wrapper.dataset[legacyKey(this.options.legacyDatasetPrefix, 'RevealNativeToolbar')]
			activeDocument.body.dataset[legacyKey(this.options.legacyDatasetPrefix, 'SessionId')] = this.sessionId
		}

		wrapper.classList.add('bragi-inline-tool-mode')
		if (this.options.legacyModeClass) wrapper.classList.add(this.options.legacyModeClass)
		this.syncDataset()
	}

	private suppressNativeToolbar(): void {
		const wrapper = this.wrapperEl
		if (wrapper) {
			wrapper.dataset.bragiInlineToolSuppressNativeToolbar = 'true'
			delete wrapper.dataset.bragiInlineToolRevealNativeToolbar
			if (this.options.legacyDatasetPrefix) {
				wrapper.dataset[legacyKey(this.options.legacyDatasetPrefix, 'SuppressNativeToolbar')] = 'true'
				delete wrapper.dataset[legacyKey(this.options.legacyDatasetPrefix, 'RevealNativeToolbar')]
			}
		}
		const menuEl = getSelectionMenuEl(this.options.canvas)
		if (menuEl) {
			menuEl.classList.add('bragi-native-toolbar-suppressed', 'bragi-native-toolbar-hidden')
			menuEl.classList.remove('bragi-native-toolbar-fade')
		}
	}

	private clearNativeToolbarSuppression(): void {
		const wrapper = this.wrapperEl
		if (wrapper) {
			delete wrapper.dataset.bragiInlineToolSuppressNativeToolbar
			if (this.options.legacyDatasetPrefix) {
				delete wrapper.dataset[legacyKey(this.options.legacyDatasetPrefix, 'SuppressNativeToolbar')]
			}
		}
	}

	private requestNativeToolbarReveal(): void {
		const wrapper = this.wrapperEl
		if (!wrapper) return
		wrapper.dataset.bragiInlineToolRevealNativeToolbar = 'true'
		if (this.options.legacyDatasetPrefix) {
			wrapper.dataset[legacyKey(this.options.legacyDatasetPrefix, 'RevealNativeToolbar')] = 'true'
		}
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

	/**
	 * Screen-px vertical space each toolbar needs outside the node (own measured
	 * height + node gap). Bars use visibility:hidden while opening, so they still
	 * report a real height via getBoundingClientRect.
	 */
	private computeToolbarMetrics(): ToolbarMetrics {
		const hasTopToolbar = Boolean(this.options.renderToolbar)
		const topHeight = hasTopToolbar ? measureInlineToolbarHeight(this.options.canvas) : 0
		const bottomHeight = this.options.bottomToolbar ? measureElementHeight(this.bottomBarEl) : 0
		return {
			topReserve: topHeight > 0 ? topHeight + NODE_TOOLBAR_GAP : 0,
			bottomReserve: bottomHeight > 0 ? bottomHeight + NODE_TOOLBAR_GAP : 0,
		}
	}

	private focusTargetNode(): CanvasViewportTarget | null {
		if (!this.wrapperEl) return null
		const focusTarget = calculateFocusTarget(this.options.canvas, this.options.node, this.wrapperEl, this.options.focusOptions, this.computeToolbarMetrics())
		const target = animateViewportTo(this.options.canvas, focusTarget.x, focusTarget.y, focusTarget.zoom)
		if (target) return target
		this.options.node.focus()
		if (typeof this.options.canvas.zoomToSelection === 'function') {
			this.options.canvas.zoomToSelection()
			void this.options.canvas.requestFrame()
		}
		return null
	}

	private async showToolbarAfterFocus(target: CanvasViewportTarget | null): Promise<void> {
		await waitForViewport(this.options.canvas, target, VIEWPORT_FALLBACK_TOOLBAR_DELAY_MS)
		await waitForAnimationFrames(2)
		if (this.sessionState !== 'opening') return
		for (let pass = 0; pass < INLINE_TOOL_RENDERED_CORRECTION_PASSES; pass++) {
			const correctionTarget = this.wrapperEl
				? calculateRenderedCorrectionTarget(this.options.canvas, this.options.node, this.wrapperEl, this.options.focusOptions, this.computeToolbarMetrics())
				: null
			if (!correctionTarget) break
			const appliedCorrection = animateViewportTo(this.options.canvas, correctionTarget.x, correctionTarget.y, correctionTarget.zoom)
			await waitForViewport(this.options.canvas, appliedCorrection)
			await waitForAnimationFrames(2)
			if (this.sessionState !== 'opening') return
		}
		if (this.sessionState !== 'opening') return
		this.sessionState = 'active'
		this.setToolbarPhase('ready')
		this.options.onReady?.(this.createContext())
		this.refreshToolbar()
		this.startPositionLoop()
	}

	private readonly handleToolAction = (event: Event): void => {
		const action = (event as CustomEvent<TAction>).detail
		if (!action || !this.isActive()) return
		this.options.onAction(action, this.createContext())
	}

	private readonly handleCanvasGate = (event: Event): void => {
		if (event.type !== 'wheel' && this.isOwnBottomBarTarget(event.target)) return
		if (event.type !== 'wheel' && this.options.isToolEventTarget?.(event.target)) return
		event.preventDefault()
		event.stopPropagation()
		if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation()
	}

	private readonly handleDocumentScopeEvent = (event: Event): void => {
		this.keyboardScopeActive = this.isTargetInSessionScope(event.target)
	}

	private readonly handleDocumentKeyDown = (event: KeyboardEvent): void => {
		if (!this.options.onKeyDown || !this.isActive() || !this.isKeyboardEventInSessionScope(event)) return
		this.options.onKeyDown(event, this.createContext())
	}

	private installKeyboardListeners(): void {
		if (!this.options.onKeyDown) return
		this.keyboardScopeActive = true
		activeDocument.addEventListener('keydown', this.handleDocumentKeyDown, true)
		activeDocument.addEventListener('pointerdown', this.handleDocumentScopeEvent, true)
		activeDocument.addEventListener('focusin', this.handleDocumentScopeEvent, true)
	}

	private removeKeyboardListeners(): void {
		if (!this.options.onKeyDown) return
		activeDocument.removeEventListener('keydown', this.handleDocumentKeyDown, true)
		activeDocument.removeEventListener('pointerdown', this.handleDocumentScopeEvent, true)
		activeDocument.removeEventListener('focusin', this.handleDocumentScopeEvent, true)
		this.keyboardScopeActive = false
	}

	private tagToolbarMenu(menuEl: HTMLElement): void {
		menuEl.dataset.bragiInlineToolId = this.options.id
		menuEl.dataset.bragiInlineToolSessionId = this.sessionId
		menuEl.dataset.bragiInlineToolNodeId = this.options.node.id
	}

	private clearToolbarMenuTag(menuEl: HTMLElement): void {
		delete menuEl.dataset.bragiInlineToolId
		delete menuEl.dataset.bragiInlineToolSessionId
		delete menuEl.dataset.bragiInlineToolNodeId
	}

	private isKeyboardEventInSessionScope(event: KeyboardEvent): boolean {
		const targetEl = eventTargetElement(event.target)
		if (isDocumentLevelTarget(targetEl)) {
			const activeEl = eventTargetElement(activeDocument.activeElement)
			if (!isDocumentLevelTarget(activeEl)) return this.isTargetInSessionScope(activeEl)
			return this.keyboardScopeActive
		}
		const inScope = this.isTargetInSessionScope(event.target)
		this.keyboardScopeActive = inScope
		return inScope
	}

	private isOwnBottomBarTarget(target: EventTarget | null): boolean {
		if (!this.bottomBarEl) return false
		const targetEl = eventTargetElement(target)
		return targetEl ? this.bottomBarEl.contains(targetEl) : false
	}

	private isTargetInSessionScope(target: EventTarget | null): boolean {
		const wrapper = this.wrapperEl
		if (!wrapper) return false
		const targetEl = eventTargetElement(target)
		if (!targetEl) return this.keyboardScopeActive

		if (this.isOwnBottomBarTarget(target)) return true

		const targetWrapper = targetEl.closest<HTMLElement>('.canvas-wrapper')
		if (targetWrapper) return targetWrapper === wrapper

		const canvasMenu = targetEl.closest<HTMLElement>('.bragi-canvas-menu')
		if (canvasMenu) return canvasMenu.dataset.bragiInlineToolSessionId === this.sessionId

		return this.options.isToolEventTarget?.(target) === true
	}

	private async finishCloseAfterViewport(target: CanvasViewportTarget | null): Promise<void> {
		this.stopPositionLoop()
		this.bottomBarEl?.remove()
		this.bottomBarEl = null
		await waitForViewport(this.options.canvas, target)
		const wrapper = this.wrapperEl
		const ownsWrapper = !wrapper || wrapper.dataset.bragiInlineToolSessionId === this.sessionId
		const ownsBody = activeDocument.body.dataset.bragiInlineToolSessionId === this.sessionId
		if (ownsWrapper) {
			this.primeNativeToolbarFadeIn()
		}
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
			if (wrapper && activeInlineToolSessions.get(wrapper) !== this) {
				this.restoreTargetNodeZIndex()
				this.options.node.nodeEl.classList.remove('bragi-inline-tool-target')
				if (this.options.legacyTargetClass) this.options.node.nodeEl.classList.remove(this.options.legacyTargetClass)
				if (this.options.legacyContentClass) this.options.node.contentEl.classList.remove(this.options.legacyContentClass)
			}
			this.sessionState = 'closed'
			return
		}
		this.restoreTargetNodeZIndex()
		this.options.node.nodeEl.classList.remove('bragi-inline-tool-target')
		if (this.options.legacyTargetClass) this.options.node.nodeEl.classList.remove(this.options.legacyTargetClass)
		if (this.options.legacyContentClass) this.options.node.contentEl.classList.remove(this.options.legacyContentClass)
		this.restoreSelection()
		this.clearNativeToolbarSuppression()
		this.requestNativeToolbarReveal()
		this.refreshToolbar(true)
		this.sessionState = 'closed'
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

function eventTargetElement(target: EventTarget | null): HTMLElement | null {
	if (target instanceof HTMLElement) return target
	if (target instanceof SVGElement) return target.closest<HTMLElement>('svg') || target.parentElement
	return null
}

function isDocumentLevelTarget(target: HTMLElement | null): boolean {
	return !target || target === activeDocument.body || target === activeDocument.documentElement
}

export function getActiveInlineToolSession(canvas?: Canvas): CanvasInlineToolSession<unknown> | null {
	const wrapper = canvas?.wrapperEl
	if (!wrapper) return null
	const session = activeInlineToolSessions.get(wrapper)
	if (!session) return null
	if (!session.isActive()) {
		activeInlineToolSessions.delete(wrapper)
		return null
	}
	if (session.canvas !== canvas) return null
	return session
}

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

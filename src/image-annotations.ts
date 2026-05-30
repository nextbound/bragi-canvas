import { Notice, setIcon, setTooltip } from 'obsidian'
import type BragiCanvas from './main'
import { findFreePosition } from './canvas-ops'
import { CanvasInlineToolSession, type CanvasInlineToolContext } from './canvas-inline-tool'
import type { Canvas, CanvasNode } from './types/canvas-internal'

export type AnnotationTool = 'box' | 'number' | 'mosaic'

export const IMAGE_ANNOTATION_ACTION_EVENT = 'bragi-image-annotation-action'

export type ImageAnnotationAction =
	| { type: 'set-tool'; tool: AnnotationTool }
	| { type: 'set-color'; color: string }
	| { type: 'set-size'; size: number }
	| { type: 'undo' }
	| { type: 'redo' }
	| { type: 'save' }
	| { type: 'exit' }

type Point = {
	x: number
	y: number
}

type BoxMark = {
	kind: 'box'
	start: Point
	end: Point
	color: string
	strokeWidth: number
}

type NumberMark = {
	kind: 'number'
	center: Point
	label: string
	color: string
	radius: number
}

type MosaicMark = {
	kind: 'mosaic'
	points: Point[]
	brushSize: number
}

type AnnotationMark = BoxMark | NumberMark | MosaicMark

type CanvasFileData = {
	type?: string
	file?: string
	x?: number
	y?: number
	width?: number
	height?: number
	color?: string
}

type ImageSize = {
	width: number
	height: number
}

type ImageCoverTransform = ImageSize & {
	scale: number
	x: number
	y: number
}

const IMAGE_PATH_RE = /\.(png|jpe?g|webp|gif)$/i
const OUTPUT_PREFIX = 'annotation'
const MAX_ANNOTATION_PIXEL_RATIO = 3
const ANNOTATION_SIZE_MIN = 8
const ANNOTATION_SIZE_MAX = 72
const DEFAULT_ANNOTATION_SIZE = 32

function createId(): string {
	return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
}

function imageMime(path: string): string {
	const ext = path.split('.').pop()?.toLowerCase()
	if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
	if (ext === 'webp') return 'image/webp'
	if (ext === 'gif') return 'image/gif'
	return 'image/png'
}

function isImageFile(path: string | undefined): path is string {
	return typeof path === 'string' && IMAGE_PATH_RE.test(path)
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value))
}

function boxStrokeWidthFromSize(size: number): number {
	return clamp(Math.round(size / 8), 1, 9)
}

function numberRadiusFromSize(size: number): number {
	return clamp(Math.round(size * 0.4), 4, 29)
}

function mosaicBrushSizeFromSize(size: number): number {
	return clamp(Math.round(size * 0.75), 6, 54)
}

function mosaicCellSizeFromBrush(brushSize: number): number {
	return Math.max(3, Math.round(brushSize / 8))
}

function cursorDiameterForTool(tool: AnnotationTool, size: number): number {
	if (tool === 'box') return boxStrokeWidthFromSize(size)
	if (tool === 'number') return numberRadiusFromSize(size) * 2
	return mosaicBrushSizeFromSize(size)
}

function annotationPixelRatio(): number {
	return clamp(window.devicePixelRatio || 1, 1, MAX_ANNOTATION_PIXEL_RATIO)
}

function pointerToCanvas(canvasEl: HTMLCanvasElement, event: PointerEvent, width: number, height: number): Point {
	const rect = canvasEl.getBoundingClientRect()
	const x = (event.clientX - rect.left) * width / Math.max(1, rect.width)
	const y = (event.clientY - rect.top) * height / Math.max(1, rect.height)
	return {
		x: clamp(x, 0, width),
		y: clamp(y, 0, height),
	}
}

function isPointerInsideCanvas(canvasEl: HTMLCanvasElement, event: PointerEvent): boolean {
	const rect = canvasEl.getBoundingClientRect()
	return event.clientX >= rect.left
		&& event.clientX <= rect.right
		&& event.clientY >= rect.top
		&& event.clientY <= rect.bottom
}

function normalizedBox(mark: BoxMark): { x: number; y: number; width: number; height: number } {
	const x = Math.min(mark.start.x, mark.end.x)
	const y = Math.min(mark.start.y, mark.end.y)
	return {
		x,
		y,
		width: Math.abs(mark.end.x - mark.start.x),
		height: Math.abs(mark.end.y - mark.start.y),
	}
}

function imageSize(image: HTMLImageElement): ImageSize {
	return {
		width: Math.max(1, image.naturalWidth || image.width || 1),
		height: Math.max(1, image.naturalHeight || image.height || 1),
	}
}

function imageCoverTransform(image: HTMLImageElement, canvasWidth: number, canvasHeight: number): ImageCoverTransform {
	const source = imageSize(image)
	const scale = Math.max(canvasWidth / source.width, canvasHeight / source.height)
	const width = source.width * scale
	const height = source.height * scale
	return {
		...source,
		scale,
		x: (canvasWidth - width) / 2,
		y: (canvasHeight - height) / 2,
	}
}

async function loadVaultImage(plugin: BragiCanvas, path: string): Promise<HTMLImageElement> {
	const binary = await plugin.app.vault.adapter.readBinary(path)
	const url = URL.createObjectURL(new Blob([binary], { type: imageMime(path) }))

	return new Promise((resolve, reject) => {
		const image = new Image()
		image.onload = () => {
			window.setTimeout(() => URL.revokeObjectURL(url), 0)
			resolve(image)
		}
		image.onerror = () => {
			URL.revokeObjectURL(url)
			reject(new Error(`Could not load image: ${path}`))
		}
		image.src = url
	})
}

async function ensureVaultFolder(plugin: BragiCanvas, folderPath: string): Promise<void> {
	const parts = folderPath.split('/').filter(Boolean)
	let current = ''
	for (const part of parts) {
		current = current ? `${current}/${part}` : part
		if (!await plugin.app.vault.adapter.exists(current)) {
			await plugin.app.vault.adapter.mkdir(current)
		}
	}
}

function encodePng(canvasEl: HTMLCanvasElement): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		canvasEl.toBlob(blob => {
			if (!blob) {
				reject(new Error('Could not encode annotated image'))
				return
			}
			void blob.arrayBuffer().then(resolve, reject)
		}, 'image/png')
	})
}

async function saveAnnotatedPng(plugin: BragiCanvas, canvasEl: HTMLCanvasElement): Promise<string> {
	const outputDir = plugin.getOutputDir()
	await ensureVaultFolder(plugin, outputDir)
	const filePath = `${outputDir}/${OUTPUT_PREFIX}_${Date.now()}_${createId().slice(0, 6)}.png`
	await plugin.app.vault.adapter.writeBinary(filePath, await encodePng(canvasEl))
	plugin.rememberGeneratedAsset(filePath)
	return filePath
}

function addAnnotatedNode(canvas: Canvas, sourceNode: CanvasNode, filePath: string, imageWidth: number, imageHeight: number): string {
	const sourceData = sourceNode.getData() as CanvasFileData
	const sourceX = numberOr(sourceData.x, sourceNode.x)
	const sourceY = numberOr(sourceData.y, sourceNode.y)
	const sourceWidth = numberOr(sourceData.width, sourceNode.width || 360)
	const nodeWidth = clamp(sourceWidth, 180, 520)
	const nodeHeight = Math.max(120, Math.round(nodeWidth * imageHeight / Math.max(1, imageWidth)))
	const position = findFreePosition(
		canvas,
		sourceX + sourceWidth + 40,
		sourceY,
		nodeWidth,
		nodeHeight,
		sourceNode.id,
	)
	const nodeId = createId()
	const edgeId = createId()
	const current = canvas.getData() as unknown as { nodes: object[]; edges: object[] }

	canvas.importData({
		nodes: [...current.nodes, {
			id: nodeId,
			type: 'file',
			file: filePath,
			x: position.x,
			y: position.y,
			width: nodeWidth,
			height: nodeHeight,
			color: sourceData.color || '',
		}],
		edges: [...current.edges, {
			id: edgeId,
			fromNode: sourceNode.id,
			fromSide: 'right',
			toNode: nodeId,
			toSide: 'left',
			toEnd: 'arrow',
		}],
	})

	void canvas.requestSave()
	try {
		void canvas.requestFrame()
	} catch (err) {
		console.debug('Bragi annotation: canvas frame refresh skipped', err)
	}
	return nodeId
}

function drawBase(ctx: CanvasRenderingContext2D, image: HTMLImageElement, canvasWidth: number, canvasHeight: number): void {
	ctx.clearRect(0, 0, canvasWidth, canvasHeight)
	const transform = imageCoverTransform(image, canvasWidth, canvasHeight)
	ctx.drawImage(
		image,
		transform.x,
		transform.y,
		transform.width * transform.scale,
		transform.height * transform.scale,
	)
}

function drawOriginalBase(ctx: CanvasRenderingContext2D, image: HTMLImageElement): ImageSize {
	const size = imageSize(image)
	ctx.clearRect(0, 0, size.width, size.height)
	ctx.drawImage(image, 0, 0, size.width, size.height)
	return size
}

function drawBox(ctx: CanvasRenderingContext2D, mark: BoxMark): void {
	const box = normalizedBox(mark)
	if (box.width < 1 || box.height < 1) return

	const lineWidth = Math.max(1, Math.round(mark.strokeWidth))
	const x = Math.round(box.x) + lineWidth / 2
	const y = Math.round(box.y) + lineWidth / 2
	const width = Math.max(1, Math.round(box.width) - lineWidth)
	const height = Math.max(1, Math.round(box.height) - lineWidth)

	ctx.save()
	ctx.strokeStyle = mark.color
	ctx.lineWidth = lineWidth
	ctx.lineCap = 'butt'
	ctx.lineJoin = 'miter'
	ctx.strokeRect(x, y, width, height)
	ctx.restore()
}

function drawNumber(ctx: CanvasRenderingContext2D, mark: NumberMark): void {
	ctx.save()
	ctx.fillStyle = mark.color
	ctx.strokeStyle = '#ffffff'
	ctx.lineWidth = Math.max(2, Math.round(mark.radius * 0.1))
	ctx.beginPath()
	ctx.arc(mark.center.x, mark.center.y, mark.radius, 0, Math.PI * 2)
	ctx.fill()
	ctx.stroke()

	ctx.fillStyle = '#ffffff'
	ctx.font = `700 ${Math.round(mark.radius * (mark.label.length > 1 ? 0.72 : 0.92))}px sans-serif`
	ctx.textAlign = 'center'
	ctx.textBaseline = 'middle'
	ctx.fillText(mark.label, mark.center.x, mark.center.y + mark.radius * 0.03)
	ctx.restore()
}

function drawMosaic(
	ctx: CanvasRenderingContext2D,
	mark: MosaicMark,
	sampleCtx = ctx,
	canvasWidth = ctx.canvas.width,
	canvasHeight = ctx.canvas.height,
	sampleScale = 1,
): void {
	const radius = Math.max(5, mark.brushSize / 2)
	const cellSize = mosaicCellSizeFromBrush(mark.brushSize)

	for (const point of mark.points) {
		const left = Math.max(0, Math.floor(point.x - radius))
		const right = Math.min(canvasWidth, Math.ceil(point.x + radius))
		const top = Math.max(0, Math.floor(point.y - radius))
		const bottom = Math.min(canvasHeight, Math.ceil(point.y + radius))

		for (let y = top; y < bottom; y += cellSize) {
			for (let x = left; x < right; x += cellSize) {
				const centerX = Math.min(canvasWidth - 1, x + cellSize / 2)
				const centerY = Math.min(canvasHeight - 1, y + cellSize / 2)
				if (Math.hypot(centerX - point.x, centerY - point.y) > radius) continue

				const sampleX = clamp(Math.round(centerX * sampleScale), 0, sampleCtx.canvas.width - 1)
				const sampleY = clamp(Math.round(centerY * sampleScale), 0, sampleCtx.canvas.height - 1)
				const sample = sampleCtx.getImageData(sampleX, sampleY, 1, 1).data
				ctx.fillStyle = `rgb(${sample[0]}, ${sample[1]}, ${sample[2]})`
				ctx.fillRect(x, y, cellSize, cellSize)
			}
		}
	}
}

function drawMark(
	ctx: CanvasRenderingContext2D,
	mark: AnnotationMark,
	sampleCtx = ctx,
	canvasWidth = ctx.canvas.width,
	canvasHeight = ctx.canvas.height,
	sampleScale = 1,
): void {
	if (mark.kind === 'box') drawBox(ctx, mark)
	else if (mark.kind === 'number') drawNumber(ctx, mark)
	else drawMosaic(ctx, mark, sampleCtx, canvasWidth, canvasHeight, sampleScale)
}

function pointToOriginal(point: Point, transform: ImageCoverTransform): Point {
	return {
		x: clamp((point.x - transform.x) / transform.scale, 0, transform.width),
		y: clamp((point.y - transform.y) / transform.scale, 0, transform.height),
	}
}

function markToOriginal(mark: AnnotationMark, transform: ImageCoverTransform): AnnotationMark {
	if (mark.kind === 'box') {
		return {
			...mark,
			start: pointToOriginal(mark.start, transform),
			end: pointToOriginal(mark.end, transform),
			strokeWidth: Math.max(1, mark.strokeWidth / transform.scale),
		}
	}
	if (mark.kind === 'number') {
		return {
			...mark,
			center: pointToOriginal(mark.center, transform),
			radius: Math.max(1, mark.radius / transform.scale),
		}
	}
	return {
		...mark,
		points: mark.points.map(point => pointToOriginal(point, transform)),
		brushSize: Math.max(1, mark.brushSize / transform.scale),
	}
}

function drawCursor(ctx: CanvasRenderingContext2D, point: Point, diameter: number, color: string): void {
	const radius = Math.max(1, diameter / 2)
	ctx.save()
	ctx.fillStyle = 'transparent'
	ctx.lineWidth = 1.25
	ctx.strokeStyle = color
	ctx.beginPath()
	ctx.arc(point.x, point.y, radius, 0, Math.PI * 2)
	ctx.stroke()
	ctx.restore()
}

function readImagePath(node: CanvasNode): string | null {
	const data = node.getData() as CanvasFileData
	return data.type === 'file' && isImageFile(data.file) ? data.file : null
}

function isEditableTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false
	return target.instanceOf(HTMLInputElement)
		|| target.instanceOf(HTMLTextAreaElement)
		|| target.instanceOf(HTMLSelectElement)
		|| target.isContentEditable
}

function isAnnotationEventTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false
	return Boolean(target.closest('.bragi-annotation-layer, .bragi-canvas-menu, .bragi-annotation-color-dropdown'))
}

const ANNOTATION_COLOR_PRESETS = [
	{ name: 'Red', color: '#e03131' },
	{ name: 'Orange', color: '#f08c00' },
	{ name: 'Yellow', color: '#ffd43b' },
	{ name: 'Green', color: '#2f9e44' },
	{ name: 'Blue', color: '#1971c2' },
	{ name: 'Purple', color: '#9c36b5' },
] as const

type AnnotationColorPreset = (typeof ANNOTATION_COLOR_PRESETS)[number]

let annotationColorDropdownOutsideHandler: ((event: PointerEvent) => void) | null = null

function setInstantTopTooltip(el: HTMLElement, text: string): void {
	setTooltip(el, text, { placement: 'top' })
	el.setAttribute('data-tooltip-delay', '0')
	el.setAttribute('data-tooltip-position', 'top')
}

function closeAnnotationDropdown(): void {
	activeDocument.querySelectorAll('.bragi-annotation-color-dropdown').forEach(el => el.remove())
	if (annotationColorDropdownOutsideHandler) {
		activeDocument.removeEventListener('pointerdown', annotationColorDropdownOutsideHandler, true)
		annotationColorDropdownOutsideHandler = null
	}
}

function createToolbarButton(
	className: string,
	iconName: string,
	tooltip: string,
	onClick: (event: MouseEvent) => void,
): HTMLElement {
	const button = createDiv()
	button.className = `clickable-icon ${className} bragi-menu-injected`
	setIcon(button, iconName)
	setInstantTopTooltip(button, tooltip)
	button.addEventListener('click', (event) => {
		event.stopPropagation()
		onClick(event)
	})
	return button
}

function createLabeledToolbarButton(
	className: string,
	iconName: string,
	label: string,
	tooltip: string,
	onClick: (event: MouseEvent) => void,
): HTMLElement {
	const button = createToolbarButton(className, iconName, tooltip, onClick)
	button.classList.add('bragi-labeled-menu-button')
	button.setAttribute('aria-label', tooltip)
	button.createSpan({ cls: 'bragi-menu-button-label', text: label })
	return button
}

function createTextToolbarButton(
	className: string,
	label: string,
	tooltip: string,
	onClick: (event: MouseEvent) => void,
): HTMLElement {
	const button = createDiv()
	button.className = `clickable-icon ${className} bragi-labeled-menu-button bragi-menu-injected`
	setInstantTopTooltip(button, tooltip)
	button.setAttribute('aria-label', tooltip)
	button.createSpan({ cls: 'bragi-menu-button-label', text: label })
	button.addEventListener('click', (event) => {
		event.stopPropagation()
		onClick(event)
	})
	return button
}

function createAnnotationControl(className: string): HTMLElement {
	const control = createDiv({ cls: `bragi-annotation-control ${className} bragi-menu-injected` })
	control.addEventListener('pointerdown', event => event.stopPropagation())
	control.addEventListener('click', event => event.stopPropagation())
	return control
}

function normalizeHexColor(color: string): string {
	return color.trim().toLowerCase()
}

function getAnnotationColorPreset(color: string): AnnotationColorPreset {
	const normalized = normalizeHexColor(color)
	return ANNOTATION_COLOR_PRESETS.find(preset => normalizeHexColor(preset.color) === normalized)
		|| ANNOTATION_COLOR_PRESETS[0]
}

function setAnnotationColorDot(dot: HTMLElement, color: string): void {
	dot.style.setProperty('--bragi-annotation-active-color', color)
}

class ImageAnnotationCanvasMode {
	private image: HTMLImageElement | null = null
	private session: CanvasInlineToolSession<ImageAnnotationAction> | null = null
	private canvasEl: HTMLCanvasElement | null = null
	private ctx: CanvasRenderingContext2D | null = null
	private baseCanvasEl: HTMLCanvasElement | null = null
	private baseCtx: CanvasRenderingContext2D | null = null
	private resizeObserver: ResizeObserver | null = null
	private activePointerId: number | null = null
	private cursorPoint: Point | null = null
	private layerWidth = 1
	private layerHeight = 1
	private layerPixelRatio = 1
	private draft: AnnotationMark | null = null
	private marks: AnnotationMark[] = []
	private redoStack: AnnotationMark[] = []
	private color = '#e03131'
	private size = DEFAULT_ANNOTATION_SIZE
	private nextNumber = 1
	private closed = false

	constructor(
		private readonly plugin: BragiCanvas,
		private readonly sourceCanvas: Canvas,
		private readonly sourceNode: CanvasNode,
		private readonly filePath: string,
		private activeTool: AnnotationTool,
	) {}

	open(): void {
		void this.load().catch(err => {
			console.error('Bragi annotation editor failed to open', err)
			new Notice(err instanceof Error ? err.message : 'Could not open annotation editor')
			this.close()
		})
	}

	private readonly handleKeyDown = (event: KeyboardEvent): void => {
		if (event.key === 'Escape') {
			event.preventDefault()
			event.stopPropagation()
			this.close()
			return
		}
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
			event.preventDefault()
			event.stopPropagation()
			if (event.shiftKey) this.redo()
			else this.undo()
			return
		}
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
			event.preventDefault()
			event.stopPropagation()
			this.redo()
			return
		}
		if (isEditableTarget(event.target)) return

		if (event.key === 'Backspace' || event.key === 'Delete' || event.key === ' ') {
			event.preventDefault()
			event.stopPropagation()
		}
	}

	private async load(): Promise<void> {
		this.image = await loadVaultImage(this.plugin, this.filePath)
		this.session = new CanvasInlineToolSession<ImageAnnotationAction>({
			id: 'image-annotation',
			canvas: this.sourceCanvas,
			node: this.sourceNode,
			actionEvent: IMAGE_ANNOTATION_ACTION_EVENT,
			renderToolbar: (menuEl, context) => this.renderToolbar(menuEl, context),
			onAction: action => this.handleToolbarAction(action),
			mountLayer: () => this.buildNodeLayer(),
			isToolEventTarget: isAnnotationEventTarget,
			onKeyDown: event => this.handleKeyDown(event),
			onClose: () => this.cleanupAfterSessionClose(),
			legacyModeClass: 'bragi-annotation-mode',
			legacyTargetClass: 'bragi-annotation-target',
			legacyBodyClass: 'bragi-annotation-mode-active',
			legacyContentClass: 'bragi-annotation-content',
			legacyDatasetPrefix: 'bragiAnnotation',
		})
		this.session.open()
		this.syncToolState()
		this.render()
	}

	private syncToolState(): void {
		const wrapper = this.session?.context?.wrapperEl
		if (!wrapper) return
		wrapper.dataset.bragiAnnotationTool = this.activeTool
		wrapper.dataset.bragiAnnotationColor = this.color
		wrapper.dataset.bragiAnnotationSize = String(this.size)
		wrapper.dataset.bragiAnnotationCanUndo = this.marks.length > 0 ? 'true' : 'false'
		wrapper.dataset.bragiAnnotationCanRedo = this.redoStack.length > 0 ? 'true' : 'false'
	}

	private renderToolbar(menuEl: HTMLElement, context: CanvasInlineToolContext<ImageAnnotationAction>): void {
		const activeColorPreset = getAnnotationColorPreset(this.color)

		const exitButton = createLabeledToolbarButton('bragi-annotation-exit', 'bragi-annotation-exit-icon', 'Exit', 'Exit annotation', () => {
			context.dispatchAction({ type: 'exit' })
		})
		menuEl.appendChild(exitButton)
		menuEl.createDiv({ cls: 'bragi-annotation-separator bragi-menu-injected' })

		menuEl.appendChild(this.createAnnotationToolButton(menuEl, context, 'box', 'bragi-annotation-box', 'Box'))
		menuEl.appendChild(this.createAnnotationToolButton(menuEl, context, 'number', 'bragi-annotation-number', 'Number'))
		menuEl.appendChild(this.createAnnotationToolButton(menuEl, context, 'mosaic', 'bragi-annotation-mosaic', 'Mosaic'))
		menuEl.createDiv({ cls: 'bragi-annotation-separator bragi-menu-injected' })

		const colorButton = createDiv({ cls: 'clickable-icon bragi-annotation-color-button bragi-menu-injected' })
		colorButton.setAttribute('aria-label', `Color: ${activeColorPreset.name}`)
		setInstantTopTooltip(colorButton, 'Color')
		const colorDot = colorButton.createSpan({ cls: 'bragi-annotation-color-dot' })
		setAnnotationColorDot(colorDot, activeColorPreset.color)
		colorButton.addEventListener('click', (event) => {
			event.stopPropagation()
			this.openColorDropdown(colorButton, colorDot, menuEl, context)
		})
		menuEl.appendChild(colorButton)

		const sizeControl = createAnnotationControl('bragi-annotation-size-control')
		const sizeIcon = sizeControl.createDiv({ cls: 'bragi-annotation-size-icon' })
		setIcon(sizeIcon, 'bragi-annotation-size')
		setInstantTopTooltip(sizeControl, 'Brush size')
		const sizeInput = sizeControl.createEl('input')
		sizeInput.type = 'range'
		sizeInput.min = String(ANNOTATION_SIZE_MIN)
		sizeInput.max = String(ANNOTATION_SIZE_MAX)
		sizeInput.step = '1'
		sizeInput.value = String(this.size)
		sizeInput.addEventListener('input', () => {
			context.dispatchAction({ type: 'set-size', size: Number(sizeInput.value) || DEFAULT_ANNOTATION_SIZE })
		})
		menuEl.appendChild(sizeControl)

		menuEl.appendChild(this.createHistoryButton('bragi-annotation-undo', 'bragi-ctrl-undo', 'Undo', this.marks.length === 0, () => {
			context.dispatchAction({ type: 'undo' })
		}))
		menuEl.appendChild(this.createHistoryButton('bragi-annotation-redo', 'bragi-ctrl-redo', 'Redo', this.redoStack.length === 0, () => {
			context.dispatchAction({ type: 'redo' })
		}))
		const saveButton = createTextToolbarButton('bragi-annotation-save', 'Save', 'Save annotation', () => {
			context.dispatchAction({ type: 'save' })
		})
		menuEl.appendChild(saveButton)

		this.syncAnnotationToolButtons(menuEl)
	}

	private createAnnotationToolButton(
		menuEl: HTMLElement,
		context: CanvasInlineToolContext<ImageAnnotationAction>,
		tool: AnnotationTool,
		icon: string,
		label: string,
	): HTMLElement {
		const button = createToolbarButton(`bragi-annotation-tool bragi-annotation-${tool}`, icon, label, () => {
			context.dispatchAction({ type: 'set-tool', tool })
			this.syncAnnotationToolButtons(menuEl)
		})
		button.dataset.bragiAnnotationTool = tool
		button.setAttribute('aria-pressed', 'false')
		return button
	}

	private createHistoryButton(
		className: string,
		iconName: string,
		tooltip: string,
		disabled: boolean,
		onClick: () => void,
	): HTMLElement {
		const button = createDiv()
		button.className = `clickable-icon ${className} bragi-annotation-history-action bragi-menu-injected`
		setIcon(button, iconName)
		setInstantTopTooltip(button, tooltip)
		button.classList.toggle('is-disabled', disabled)
		button.setAttribute('aria-disabled', disabled ? 'true' : 'false')
		button.addEventListener('click', (event) => {
			event.stopPropagation()
			if (disabled) return
			onClick()
		})
		return button
	}

	private syncAnnotationToolButtons(menuEl: HTMLElement): void {
		menuEl.querySelectorAll<HTMLElement>('.bragi-annotation-tool').forEach((button) => {
			const tool = button.dataset.bragiAnnotationTool
			button.classList.toggle('is-active', tool === this.activeTool)
			button.setAttribute('aria-pressed', tool === this.activeTool ? 'true' : 'false')
		})
	}

	private openColorDropdown(
		button: HTMLElement,
		dot: HTMLElement,
		menuEl: HTMLElement,
		context: CanvasInlineToolContext<ImageAnnotationAction>,
	): void {
		const existing = activeDocument.querySelector('.bragi-annotation-color-dropdown')
		if (existing) {
			closeAnnotationDropdown()
			return
		}

		closeAnnotationDropdown()
		const current = getAnnotationColorPreset(this.color)
		const btnRect = button.getBoundingClientRect()
		const toolbarRect = menuEl.getBoundingClientRect()
		const dropdown = createDiv()
		dropdown.className = 'bragi-more-dropdown bragi-annotation-color-dropdown'
		dropdown.style.left = `${btnRect.left}px`
		dropdown.style.top = `${toolbarRect.bottom - 1}px`

		for (const preset of ANNOTATION_COLOR_PRESETS) {
			const item = dropdown.createDiv({
				cls: `bragi-more-dropdown-item bragi-annotation-color-option${preset === current ? ' is-active' : ''}`,
			})
			const colorDot = item.createSpan({ cls: 'bragi-annotation-dropdown-color-dot' })
			colorDot.style.setProperty('--bragi-annotation-option-color', preset.color)
			item.createDiv({ cls: 'bragi-more-dropdown-label', text: preset.name })
			item.addEventListener('click', (event) => {
				event.stopPropagation()
				setAnnotationColorDot(dot, preset.color)
				button.setAttribute('aria-label', `Color: ${preset.name}`)
				context.dispatchAction({ type: 'set-color', color: preset.color })
				closeAnnotationDropdown()
			})
		}

		dropdown.addEventListener('pointerdown', event => event.stopPropagation())
		activeDocument.body.appendChild(dropdown)
		const outsideHandler = (event: PointerEvent): void => {
			const target = event.target as Node | null
			if (target && (dropdown.contains(target) || button.contains(target))) return
			closeAnnotationDropdown()
		}
		annotationColorDropdownOutsideHandler = outsideHandler
		window.setTimeout(() => {
			if (annotationColorDropdownOutsideHandler === outsideHandler) {
				activeDocument.addEventListener('pointerdown', outsideHandler, true)
			}
		}, 0)
	}

	private buildNodeLayer(): void {
		const canvasEl = this.sourceNode.contentEl.createEl('canvas', { cls: 'bragi-annotation-layer' })
		const ctx = canvasEl.getContext('2d', { willReadFrequently: true })
		if (!ctx) throw new Error('Could not start canvas editor')
		const baseCanvasEl = createEl('canvas')
		const baseCtx = baseCanvasEl.getContext('2d', { willReadFrequently: true })
		if (!baseCtx) throw new Error('Could not start annotation sampler')

		this.canvasEl = canvasEl
		this.ctx = ctx
		this.baseCanvasEl = baseCanvasEl
		this.baseCtx = baseCtx
		this.bindCanvasEvents(canvasEl)

		this.resizeObserver = new ResizeObserver(() => this.resizeLayer())
		this.resizeObserver.observe(this.sourceNode.contentEl)
		this.resizeLayer()
	}

	private refreshSelectionToolbar(force = false): void {
		this.session?.refreshToolbar(force)
	}

	private resizeLayer(): void {
		if (!this.canvasEl || !this.ctx) return
		const width = Math.max(1, Math.round(this.sourceNode.contentEl.clientWidth || this.sourceNode.width || 1))
		const height = Math.max(1, Math.round(this.sourceNode.contentEl.clientHeight || this.sourceNode.height || 1))
		const pixelRatio = annotationPixelRatio()
		const pixelWidth = Math.max(1, Math.round(width * pixelRatio))
		const pixelHeight = Math.max(1, Math.round(height * pixelRatio))

		this.layerWidth = width
		this.layerHeight = height
		this.layerPixelRatio = pixelRatio
		if (this.canvasEl.width !== pixelWidth) this.canvasEl.width = pixelWidth
		if (this.canvasEl.height !== pixelHeight) this.canvasEl.height = pixelHeight
		this.ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
		if (this.baseCanvasEl) {
			if (this.baseCanvasEl.width !== pixelWidth) this.baseCanvasEl.width = pixelWidth
			if (this.baseCanvasEl.height !== pixelHeight) this.baseCanvasEl.height = pixelHeight
			this.baseCtx?.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
		}
		this.render()
	}

	private handleToolbarAction(action: ImageAnnotationAction): void {
		if (!action || this.closed) return
		if (action.type === 'set-tool') {
			this.activeTool = action.tool
			this.draft = null
			this.syncToolState()
			this.render()
		} else if (action.type === 'set-color') {
			this.color = action.color
			this.syncToolState()
			this.render()
		} else if (action.type === 'set-size') {
			this.size = clamp(action.size, ANNOTATION_SIZE_MIN, ANNOTATION_SIZE_MAX)
			this.syncToolState()
			this.render()
		} else if (action.type === 'undo') {
			this.undo()
		} else if (action.type === 'redo') {
			this.redo()
		} else if (action.type === 'save') {
			void this.save()
		} else if (action.type === 'exit') {
			this.close()
		}
	}

	private commitMark(mark: AnnotationMark): void {
		this.marks.push(mark)
		this.redoStack = []
		this.syncHistoryState()
		this.render()
	}

	private syncHistoryState(): void {
		this.nextNumber = 1 + this.marks.filter(mark => mark.kind === 'number').length
		this.syncToolState()
		this.refreshSelectionToolbar()
	}

	private undo(): void {
		const mark = this.marks.pop()
		if (!mark) return
		this.redoStack.push(mark)
		this.syncHistoryState()
		this.render()
	}

	private redo(): void {
		const mark = this.redoStack.pop()
		if (!mark) return
		this.marks.push(mark)
		this.syncHistoryState()
		this.render()
	}

	private bindCanvasEvents(canvasEl: HTMLCanvasElement): void {
		canvasEl.addEventListener('pointerdown', event => this.handlePointerDown(event))
		canvasEl.addEventListener('pointermove', event => this.handlePointerMove(event))
		canvasEl.addEventListener('pointerup', event => this.finishPointer(event))
		canvasEl.addEventListener('pointercancel', event => this.finishPointer(event))
		canvasEl.addEventListener('pointerleave', () => this.handlePointerLeave())
		canvasEl.addEventListener('click', event => event.stopPropagation())
		canvasEl.addEventListener('contextmenu', event => event.preventDefault())
	}

	private updateCursor(event: PointerEvent): Point {
		const point = pointerToCanvas(this.canvasEl!, event, this.layerWidth, this.layerHeight)
		this.cursorPoint = point
		return point
	}

	private handlePointerLeave(): void {
		if (this.activePointerId !== null) return
		this.cursorPoint = null
		this.render()
	}

	private handlePointerDown(event: PointerEvent): void {
		if (!this.canvasEl) return

		event.preventDefault()
		event.stopPropagation()
		this.activePointerId = event.pointerId
		this.canvasEl.setPointerCapture(event.pointerId)
		const point = this.updateCursor(event)

		if (this.activeTool === 'number') {
			this.commitMark({
				kind: 'number',
				center: point,
				label: String(this.nextNumber),
				color: this.color,
				radius: numberRadiusFromSize(this.size),
			})
			return
		}

		if (this.activeTool === 'box') {
			this.draft = {
				kind: 'box',
				start: point,
				end: point,
				color: this.color,
				strokeWidth: boxStrokeWidthFromSize(this.size),
			}
			this.render()
			return
		}

		this.draft = {
			kind: 'mosaic',
			points: [point],
			brushSize: mosaicBrushSizeFromSize(this.size),
		}
		this.render()
	}

	private handlePointerMove(event: PointerEvent): void {
		if (!this.canvasEl) return

		event.preventDefault()
		event.stopPropagation()
		const point = this.updateCursor(event)
		if (this.activePointerId !== event.pointerId || !this.draft) {
			this.render()
			return
		}
		if (this.draft.kind === 'box') {
			this.draft.end = point
		} else if (this.draft.kind === 'mosaic') {
			const last = this.draft.points[this.draft.points.length - 1]
			if (!last || Math.hypot(last.x - point.x, last.y - point.y) >= Math.max(2, this.size / 6)) {
				this.draft.points.push(point)
			}
		}
		this.render()
	}

	private finishPointer(event: PointerEvent): void {
		if (!this.canvasEl || this.activePointerId !== event.pointerId) return

		event.preventDefault()
		event.stopPropagation()
		const point = pointerToCanvas(this.canvasEl, event, this.layerWidth, this.layerHeight)
		if (this.draft) {
			const finished = this.draft
			this.draft = null
			if (finished.kind === 'box') {
				const box = normalizedBox(finished)
				if (box.width >= 5 && box.height >= 5) this.commitMark(finished)
			} else {
				this.commitMark(finished)
			}
		}

		if (this.canvasEl.hasPointerCapture(event.pointerId)) {
			this.canvasEl.releasePointerCapture(event.pointerId)
		}
		this.activePointerId = null
		this.cursorPoint = event.type === 'pointercancel' || !isPointerInsideCanvas(this.canvasEl, event) ? null : point
		this.render()
	}

	private render(): void {
		if (!this.ctx || !this.baseCtx || !this.image) return

		drawBase(this.baseCtx, this.image, this.layerWidth, this.layerHeight)
		this.ctx.clearRect(0, 0, this.layerWidth, this.layerHeight)
		for (const mark of this.marks) {
			drawMark(this.ctx, mark, this.baseCtx, this.layerWidth, this.layerHeight, this.layerPixelRatio)
		}
		if (this.draft) {
			drawMark(this.ctx, this.draft, this.baseCtx, this.layerWidth, this.layerHeight, this.layerPixelRatio)
		}
		if (this.cursorPoint) {
			drawCursor(this.ctx, this.cursorPoint, cursorDiameterForTool(this.activeTool, this.size), this.color)
		}
	}

	private buildExportCanvas(): HTMLCanvasElement {
		if (!this.canvasEl || !this.image) throw new Error('Annotation editor is not ready')
		const sourceSize = imageSize(this.image)
		const previewTransform = imageCoverTransform(this.image, this.layerWidth, this.layerHeight)
		const exportCanvas = createEl('canvas')
		exportCanvas.width = sourceSize.width
		exportCanvas.height = sourceSize.height
		const exportCtx = exportCanvas.getContext('2d', { willReadFrequently: true })
		if (!exportCtx) throw new Error('Could not compose annotated image')
		const exportBaseCanvas = createEl('canvas')
		exportBaseCanvas.width = exportCanvas.width
		exportBaseCanvas.height = exportCanvas.height
		const exportBaseCtx = exportBaseCanvas.getContext('2d', { willReadFrequently: true })
		if (!exportBaseCtx) throw new Error('Could not compose annotated image')
		drawOriginalBase(exportBaseCtx, this.image)
		drawOriginalBase(exportCtx, this.image)
		for (const mark of this.marks) {
			drawMark(exportCtx, markToOriginal(mark, previewTransform), exportBaseCtx, sourceSize.width, sourceSize.height)
		}
		return exportCanvas
	}

	private async save(): Promise<void> {
		if (!this.canvasEl) return
		if (this.marks.length === 0) {
			new Notice('Add an annotation first')
			return
		}

		this.fadeOutAnnotationToolbar()
		try {
			this.render()
			const exportCanvas = this.buildExportCanvas()
			const outputPath = await saveAnnotatedPng(this.plugin, exportCanvas)
			addAnnotatedNode(this.sourceCanvas, this.sourceNode, outputPath, exportCanvas.width, exportCanvas.height)
			new Notice('Annotated image saved')
			this.close()
		} catch (err: unknown) {
			this.session?.setToolbarPhase('ready')
			this.syncToolState()
			this.refreshSelectionToolbar(true)
			console.error('Bragi annotation save failed', err)
			new Notice(err instanceof Error ? err.message : 'Could not save annotation')
		}
	}

	private fadeOutAnnotationToolbar(): void {
		this.session?.setToolbarPhase('hidden')
		this.syncToolState()
		this.session?.hideToolbarMenu()
	}

	close(): void {
		if (this.closed) return
		this.closed = true
		this.session?.close()
	}

	private cleanupAfterSessionClose(): void {
		closeAnnotationDropdown()
		const wrapper = this.session?.context?.wrapperEl
		if (wrapper) {
			delete wrapper.dataset.bragiAnnotationTool
			delete wrapper.dataset.bragiAnnotationColor
			delete wrapper.dataset.bragiAnnotationSize
			delete wrapper.dataset.bragiAnnotationCanUndo
			delete wrapper.dataset.bragiAnnotationCanRedo
		}
		this.resizeObserver?.disconnect()
		this.resizeObserver = null
		this.activePointerId = null
		this.cursorPoint = null
		this.draft = null
		this.canvasEl?.remove()
		this.canvasEl = null
		this.ctx = null
		this.baseCanvasEl = null
		this.baseCtx = null
	}
}

export function openImageAnnotationTool(
	plugin: BragiCanvas,
	canvas: Canvas,
	node: CanvasNode,
	initialTool: AnnotationTool,
): void {
	const filePath = readImagePath(node)
	if (!filePath) {
		new Notice('Select an image node first')
		return
	}
	new ImageAnnotationCanvasMode(plugin, canvas, node, filePath, initialTool).open()
}

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and modal canvas drawing use runtime-shaped data. */
import { Modal, Notice, Setting } from 'obsidian'
import type BragiCanvas from './main'
import type { Canvas, CanvasNode } from './types/canvas-internal'
import { getUpstreamInputs } from './edge-parser'
import { loadImageFromBinary } from './grid-split'

type ImageLike = HTMLImageElement
type AnnotationTool = 'box' | 'label' | 'mosaic'
type CutoutTool = 'keep' | 'erase'
type ComposeLayout = 'grid' | 'horizontal' | 'vertical'

type BoxAnnotation = {
	type: 'box'
	x: number
	y: number
	w: number
	h: number
	color: string
	lineWidth: number
}

type LabelAnnotation = {
	type: 'label'
	x: number
	y: number
	text: string
	color: string
	radius: number
}

type MosaicAnnotation = {
	type: 'mosaic'
	points: Array<{ x: number; y: number }>
	size: number
}

type Annotation = BoxAnnotation | LabelAnnotation | MosaicAnnotation

const IMAGE_RE = /\.(png|jpe?g|webp|gif)$/i

function generateId(): string {
	return Math.random().toString(36).substring(2, 18)
}

function imageMimeFromPath(path: string): string {
	const ext = (path.split('.').pop() || 'png').toLowerCase()
	if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
	if (ext === 'webp') return 'image/webp'
	if (ext === 'gif') return 'image/gif'
	return 'image/png'
}

function isImagePath(path: string): boolean {
	return IMAGE_RE.test(path)
}

function canvasPoint(canvasEl: HTMLCanvasElement, event: PointerEvent | MouseEvent): { x: number; y: number } {
	const rect = canvasEl.getBoundingClientRect()
	return {
		x: (event.clientX - rect.left) * canvasEl.width / rect.width,
		y: (event.clientY - rect.top) * canvasEl.height / rect.height,
	}
}

function normalizeBox(box: BoxAnnotation): BoxAnnotation {
	const x = box.w < 0 ? box.x + box.w : box.x
	const y = box.h < 0 ? box.y + box.h : box.y
	return { ...box, x, y, w: Math.abs(box.w), h: Math.abs(box.h) }
}

async function loadVaultImage(plugin: BragiCanvas, filePath: string): Promise<ImageLike> {
	const binary = await plugin.app.vault.adapter.readBinary(filePath)
	return loadImageFromBinary(binary, imageMimeFromPath(filePath))
}

function canvasToPngBlob(canvasEl: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvasEl.toBlob(blob => {
			if (blob) resolve(blob)
			else reject(new Error('Could not encode image'))
		}, 'image/png')
	})
}

async function ensureVaultFolder(plugin: BragiCanvas, dir: string): Promise<void> {
	const parts = dir.split('/').filter(Boolean)
	let current = ''
	for (const part of parts) {
		current = current ? `${current}/${part}` : part
		if (!await plugin.app.vault.adapter.exists(current)) {
			await plugin.app.vault.adapter.mkdir(current)
		}
	}
}

async function writeCanvasImage(plugin: BragiCanvas, canvasEl: HTMLCanvasElement, prefix: string): Promise<string> {
	const outputDir = plugin.getOutputDir()
	await ensureVaultFolder(plugin, outputDir)
	const filePath = `${outputDir}/${prefix}_${Date.now()}.png`
	const blob = await canvasToPngBlob(canvasEl)
	await plugin.app.vault.adapter.writeBinary(filePath, await blob.arrayBuffer())
	return filePath
}

function addFileNode(canvas: Canvas, sourceNode: CanvasNode, filePath: string, width: number, height: number): void {
	const sourceData = sourceNode.getData() as unknown
	const nodeId = generateId()
	const edgeId = generateId()
	const gap = 50
	const nodeWidth = Math.max(220, Math.min(480, sourceData.width || width))
	const nodeHeight = Math.max(140, Math.round(nodeWidth * height / Math.max(1, width)))
	const current = canvas.getData()

	canvas.importData({
		nodes: [...current.nodes, {
			id: nodeId,
			type: 'file',
			file: filePath,
			x: (sourceData.x || 0) + (sourceData.width || nodeWidth) + gap,
			y: sourceData.y || 0,
			width: nodeWidth,
			height: nodeHeight,
			color: '',
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
}

function drawImageBase(ctx: CanvasRenderingContext2D, image: ImageLike): void {
	ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
	ctx.drawImage(image, 0, 0, ctx.canvas.width, ctx.canvas.height)
}

function drawBox(ctx: CanvasRenderingContext2D, annotation: BoxAnnotation): void {
	const box = normalizeBox(annotation)
	ctx.save()
	ctx.strokeStyle = box.color
	ctx.lineWidth = box.lineWidth
	ctx.fillStyle = `${box.color}22`
	ctx.fillRect(box.x, box.y, box.w, box.h)
	ctx.strokeRect(box.x, box.y, box.w, box.h)
	ctx.restore()
}

function drawLabel(ctx: CanvasRenderingContext2D, annotation: LabelAnnotation): void {
	ctx.save()
	ctx.fillStyle = annotation.color
	ctx.strokeStyle = '#ffffff'
	ctx.lineWidth = Math.max(2, annotation.radius * 0.12)
	ctx.beginPath()
	ctx.arc(annotation.x, annotation.y, annotation.radius, 0, Math.PI * 2)
	ctx.fill()
	ctx.stroke()
	ctx.fillStyle = '#ffffff'
	ctx.font = `700 ${Math.round(annotation.radius * 1.1)}px sans-serif`
	ctx.textAlign = 'center'
	ctx.textBaseline = 'middle'
	ctx.fillText(annotation.text, annotation.x, annotation.y + annotation.radius * 0.04)
	ctx.restore()
}

function drawMosaic(ctx: CanvasRenderingContext2D, annotation: MosaicAnnotation): void {
	const radius = Math.max(4, annotation.size / 2)
	const cell = Math.max(6, Math.round(annotation.size / 4))
	for (const point of annotation.points) {
		const left = Math.max(0, Math.round(point.x - radius))
		const top = Math.max(0, Math.round(point.y - radius))
		const right = Math.min(ctx.canvas.width, Math.round(point.x + radius))
		const bottom = Math.min(ctx.canvas.height, Math.round(point.y + radius))
		for (let y = top; y < bottom; y += cell) {
			for (let x = left; x < right; x += cell) {
				const cx = x + cell / 2 - point.x
				const cy = y + cell / 2 - point.y
				if (Math.hypot(cx, cy) > radius) continue
				const sampleX = Math.min(ctx.canvas.width - 1, Math.max(0, Math.round(x + cell / 2)))
				const sampleY = Math.min(ctx.canvas.height - 1, Math.max(0, Math.round(y + cell / 2)))
				const rgba = ctx.getImageData(sampleX, sampleY, 1, 1).data
				ctx.fillStyle = `rgb(${rgba[0]}, ${rgba[1]}, ${rgba[2]})`
				ctx.fillRect(x, y, cell, cell)
			}
		}
	}
}

function drawAnnotations(ctx: CanvasRenderingContext2D, image: ImageLike, annotations: Annotation[], draft?: Annotation | null): void {
	drawImageBase(ctx, image)
	for (const annotation of [...annotations, ...(draft ? [draft] : [])]) {
		if (annotation.type === 'box') drawBox(ctx, annotation)
		else if (annotation.type === 'label') drawLabel(ctx, annotation)
		else drawMosaic(ctx, annotation)
	}
}

class ImageAnnotationModal extends Modal {
	private readonly annotations: Annotation[] = []
	private canvasEl!: HTMLCanvasElement
	private ctx!: CanvasRenderingContext2D
	private image!: ImageLike
	private tool: AnnotationTool
	private color = '#e03131'
	private lineWidth = 8
	private markerRadius = 28
	private mosaicSize = 34
	private labelCounter = 1
	private draft: Annotation | null = null
	private activePointerId: number | null = null

	constructor(
		private readonly plugin: BragiCanvas,
		private readonly canvas: Canvas,
		private readonly node: CanvasNode,
		private readonly filePath: string,
		initialTool: AnnotationTool,
	) {
		super(plugin.app)
		this.tool = initialTool
	}

	async onOpen(): Promise<void> {
		this.modalEl.classList.add('bragi-image-tool-modal')
		this.titleEl.setText('Annotate image')
		this.image = await loadVaultImage(this.plugin, this.filePath)

		const toolbar = this.contentEl.createDiv({ cls: 'bragi-image-tool-toolbar' })
		this.addToolButton(toolbar, 'Box', 'box')
		this.addToolButton(toolbar, 'Number', 'label')
		this.addToolButton(toolbar, 'Mosaic', 'mosaic')

		new Setting(toolbar)
			.setName('Color')
			.addColorPicker(picker => picker.setValue(this.color).onChange(value => {
				this.color = value
				this.render()
			}))
		new Setting(toolbar)
			.setName('Size')
			.addSlider(slider => slider.setLimits(8, 80, 1).setValue(this.mosaicSize).onChange(value => {
				this.lineWidth = Math.max(2, Math.round(value / 5))
				this.markerRadius = Math.max(14, Math.round(value * 0.8))
				this.mosaicSize = value
				this.render()
			}))

		const wrap = this.contentEl.createDiv({ cls: 'bragi-image-tool-canvas-wrap' })
		this.canvasEl = wrap.createEl('canvas', { cls: 'bragi-image-tool-canvas' })
		this.canvasEl.width = this.image.naturalWidth || this.image.width
		this.canvasEl.height = this.image.naturalHeight || this.image.height
		this.ctx = this.canvasEl.getContext('2d', { willReadFrequently: true })!
		this.bindPointerEvents()
		this.render()

		const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
		footer.createEl('button', { text: 'Undo' }).addEventListener('click', () => {
			this.annotations.pop()
			this.render()
		})
		footer.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close())
		footer.createEl('button', { text: 'Save', cls: 'mod-cta' }).addEventListener('click', () => {
			void this.save()
		})
	}

	private addToolButton(toolbar: HTMLElement, label: string, tool: AnnotationTool): void {
		const button = toolbar.createEl('button', { text: label })
		button.toggleClass('is-active', this.tool === tool)
		button.addEventListener('click', () => {
			this.tool = tool
			toolbar.querySelectorAll('button').forEach(el => el.removeClass('is-active'))
			button.addClass('is-active')
		})
	}

	private bindPointerEvents(): void {
		this.canvasEl.addEventListener('pointerdown', event => {
			event.preventDefault()
			this.activePointerId = event.pointerId
			this.canvasEl.setPointerCapture(event.pointerId)
			const point = canvasPoint(this.canvasEl, event)

			if (this.tool === 'label') {
				this.annotations.push({
					type: 'label',
					x: point.x,
					y: point.y,
					text: String(this.labelCounter++),
					color: this.color,
					radius: this.markerRadius,
				})
				this.render()
				return
			}

			if (this.tool === 'box') {
				this.draft = {
					type: 'box',
					x: point.x,
					y: point.y,
					w: 1,
					h: 1,
					color: this.color,
					lineWidth: this.lineWidth,
				}
				this.render()
				return
			}

			this.draft = {
				type: 'mosaic',
				points: [point],
				size: this.mosaicSize,
			}
			this.render()
		})

		this.canvasEl.addEventListener('pointermove', event => {
			if (this.activePointerId !== event.pointerId || !this.draft) return
			event.preventDefault()
			const point = canvasPoint(this.canvasEl, event)
			if (this.draft.type === 'box') {
				this.draft.w = point.x - this.draft.x
				this.draft.h = point.y - this.draft.y
			} else if (this.draft.type === 'mosaic') {
				this.draft.points.push(point)
			}
			this.render()
		})

		const finish = (event: PointerEvent) => {
			if (this.activePointerId !== event.pointerId) return
			if (this.draft) {
				if (this.draft.type !== 'box' || Math.abs(this.draft.w) > 4 && Math.abs(this.draft.h) > 4) {
					this.annotations.push(this.draft)
				}
				this.draft = null
			}
			this.activePointerId = null
			this.render()
		}
		this.canvasEl.addEventListener('pointerup', finish)
		this.canvasEl.addEventListener('pointercancel', finish)
	}

	private render(): void {
		drawAnnotations(this.ctx, this.image, this.annotations, this.draft)
	}

	private async save(): Promise<void> {
		try {
			if (this.annotations.length === 0) {
				new Notice('Add at least one annotation first')
				return
			}
			this.render()
			const filePath = await writeCanvasImage(this.plugin, this.canvasEl, 'annotation')
			addFileNode(this.canvas, this.node, filePath, this.canvasEl.width, this.canvasEl.height)
			new Notice('Annotated image saved')
			this.close()
		} catch (err: unknown) {
			console.error('Bragi annotation save failed', err)
			new Notice(`Annotation failed: ${err?.message || err}`)
		}
	}
}

class CutoutModal extends Modal {
	private image!: ImageLike
	private previewCanvas!: HTMLCanvasElement
	private previewCtx!: CanvasRenderingContext2D
	private maskCanvas!: HTMLCanvasElement
	private maskCtx!: CanvasRenderingContext2D
	private tool: CutoutTool = 'keep'
	private brushSize = 44
	private activePointerId: number | null = null
	private hasMask = false

	constructor(
		private readonly plugin: BragiCanvas,
		private readonly canvas: Canvas,
		private readonly node: CanvasNode,
		private readonly filePath: string,
	) {
		super(plugin.app)
	}

	async onOpen(): Promise<void> {
		this.modalEl.classList.add('bragi-image-tool-modal')
		this.titleEl.setText('Scene/material cutout')
		this.image = await loadVaultImage(this.plugin, this.filePath)

		const toolbar = this.contentEl.createDiv({ cls: 'bragi-image-tool-toolbar' })
		this.addToolButton(toolbar, 'Keep brush', 'keep')
		this.addToolButton(toolbar, 'Erase', 'erase')
		new Setting(toolbar)
			.setName('Brush')
			.addSlider(slider => slider.setLimits(10, 160, 1).setValue(this.brushSize).onChange(value => {
				this.brushSize = value
			}))

		const wrap = this.contentEl.createDiv({ cls: 'bragi-image-tool-canvas-wrap' })
		this.previewCanvas = wrap.createEl('canvas', { cls: 'bragi-image-tool-canvas' })
		this.previewCanvas.width = this.image.naturalWidth || this.image.width
		this.previewCanvas.height = this.image.naturalHeight || this.image.height
		this.previewCtx = this.previewCanvas.getContext('2d', { willReadFrequently: true })!

		this.maskCanvas = createEl('canvas')
		this.maskCanvas.width = this.previewCanvas.width
		this.maskCanvas.height = this.previewCanvas.height
		this.maskCtx = this.maskCanvas.getContext('2d', { willReadFrequently: true })!
		this.bindPointerEvents()
		this.render()

		const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
		footer.createEl('button', { text: 'Clear mask' }).addEventListener('click', () => {
			this.maskCtx.clearRect(0, 0, this.maskCanvas.width, this.maskCanvas.height)
			this.hasMask = false
			this.render()
		})
		footer.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close())
		footer.createEl('button', { text: 'Save cutout', cls: 'mod-cta' }).addEventListener('click', () => {
			void this.save()
		})
	}

	private addToolButton(toolbar: HTMLElement, label: string, tool: CutoutTool): void {
		const button = toolbar.createEl('button', { text: label })
		button.toggleClass('is-active', this.tool === tool)
		button.addEventListener('click', () => {
			this.tool = tool
			toolbar.querySelectorAll('button').forEach(el => el.removeClass('is-active'))
			button.addClass('is-active')
		})
	}

	private bindPointerEvents(): void {
		const paint = (event: PointerEvent): void => {
			const point = canvasPoint(this.previewCanvas, event)
			this.maskCtx.save()
			this.maskCtx.globalCompositeOperation = this.tool === 'keep' ? 'source-over' : 'destination-out'
			this.maskCtx.fillStyle = '#ffffff'
			this.maskCtx.beginPath()
			this.maskCtx.arc(point.x, point.y, this.brushSize / 2, 0, Math.PI * 2)
			this.maskCtx.fill()
			this.maskCtx.restore()
			this.hasMask = true
			this.render()
		}

		this.previewCanvas.addEventListener('pointerdown', event => {
			event.preventDefault()
			this.activePointerId = event.pointerId
			this.previewCanvas.setPointerCapture(event.pointerId)
			paint(event)
		})
		this.previewCanvas.addEventListener('pointermove', event => {
			if (this.activePointerId !== event.pointerId) return
			event.preventDefault()
			paint(event)
		})
		const finish = (event: PointerEvent) => {
			if (this.activePointerId === event.pointerId) this.activePointerId = null
		}
		this.previewCanvas.addEventListener('pointerup', finish)
		this.previewCanvas.addEventListener('pointercancel', finish)
	}

	private render(): void {
		drawImageBase(this.previewCtx, this.image)
		const overlay = this.previewCtx.getImageData(0, 0, this.previewCanvas.width, this.previewCanvas.height)
		const mask = this.maskCtx.getImageData(0, 0, this.maskCanvas.width, this.maskCanvas.height)
		for (let i = 0; i < overlay.data.length; i += 4) {
			const selected = mask.data[i + 3] > 0
			if (!selected) {
				overlay.data[i] = Math.round(overlay.data[i] * 0.42)
				overlay.data[i + 1] = Math.round(overlay.data[i + 1] * 0.42)
				overlay.data[i + 2] = Math.round(overlay.data[i + 2] * 0.42)
			}
		}
		this.previewCtx.putImageData(overlay, 0, 0)
		this.previewCtx.save()
		this.previewCtx.globalAlpha = 0.24
		this.previewCtx.fillStyle = '#2f9e44'
		this.previewCtx.drawImage(this.maskCanvas, 0, 0)
		this.previewCtx.restore()
	}

	private async save(): Promise<void> {
		try {
			if (!this.hasMask) {
				new Notice('Paint the area to keep first')
				return
			}
			const output = createEl('canvas')
			output.width = this.previewCanvas.width
			output.height = this.previewCanvas.height
			const ctx = output.getContext('2d', { willReadFrequently: true })!
			ctx.drawImage(this.image, 0, 0, output.width, output.height)
			const imageData = ctx.getImageData(0, 0, output.width, output.height)
			const mask = this.maskCtx.getImageData(0, 0, output.width, output.height)
			for (let i = 0; i < imageData.data.length; i += 4) {
				imageData.data[i + 3] = mask.data[i + 3]
			}
			ctx.putImageData(imageData, 0, 0)
			const filePath = await writeCanvasImage(this.plugin, output, 'cutout')
			addFileNode(this.canvas, this.node, filePath, output.width, output.height)
			new Notice('Cutout saved')
			this.close()
		} catch (err: unknown) {
			console.error('Bragi cutout failed', err)
			new Notice(`Cutout failed: ${err?.message || err}`)
		}
	}
}

class ReferenceComposeModal extends Modal {
	private images: ImageLike[] = []
	private layout: ComposeLayout = 'grid'
	private previewCanvas!: HTMLCanvasElement
	private previewCtx!: CanvasRenderingContext2D

	constructor(
		private readonly plugin: BragiCanvas,
		private readonly canvas: Canvas,
		private readonly node: CanvasNode,
		private readonly filePaths: string[],
	) {
		super(plugin.app)
	}

	async onOpen(): Promise<void> {
		this.modalEl.classList.add('bragi-image-tool-modal')
		this.titleEl.setText('Compose reference image')
		this.images = await Promise.all(this.filePaths.map(path => loadVaultImage(this.plugin, path)))

		const toolbar = this.contentEl.createDiv({ cls: 'bragi-image-tool-toolbar' })
		new Setting(toolbar)
			.setName('Layout')
			.addDropdown(dropdown => dropdown
				.addOption('grid', 'Grid')
				.addOption('horizontal', 'Horizontal')
				.addOption('vertical', 'Vertical')
				.setValue(this.layout)
				.onChange(value => {
					this.layout = value as ComposeLayout
					this.render()
				}))

		const wrap = this.contentEl.createDiv({ cls: 'bragi-image-tool-canvas-wrap' })
		this.previewCanvas = wrap.createEl('canvas', { cls: 'bragi-image-tool-canvas' })
		this.previewCtx = this.previewCanvas.getContext('2d')!
		this.render()

		const footer = this.contentEl.createDiv({ cls: 'modal-button-container' })
		footer.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close())
		footer.createEl('button', { text: 'Create reference', cls: 'mod-cta' }).addEventListener('click', () => {
			void this.save()
		})
	}

	private layoutInfo(): { cols: number; rows: number; cellW: number; cellH: number } {
		const maxW = Math.max(...this.images.map(img => img.naturalWidth || img.width))
		const maxH = Math.max(...this.images.map(img => img.naturalHeight || img.height))
		if (this.layout === 'horizontal') return { cols: this.images.length, rows: 1, cellW: maxW, cellH: maxH }
		if (this.layout === 'vertical') return { cols: 1, rows: this.images.length, cellW: maxW, cellH: maxH }
		const cols = Math.ceil(Math.sqrt(this.images.length))
		const rows = Math.ceil(this.images.length / cols)
		return { cols, rows, cellW: maxW, cellH: maxH }
	}

	private render(): void {
		if (!this.previewCanvas || this.images.length === 0) return
		const gap = 24
		const { cols, rows, cellW, cellH } = this.layoutInfo()
		this.previewCanvas.width = cols * cellW + (cols + 1) * gap
		this.previewCanvas.height = rows * cellH + (rows + 1) * gap
		this.previewCtx.fillStyle = '#ffffff'
		this.previewCtx.fillRect(0, 0, this.previewCanvas.width, this.previewCanvas.height)

		for (let i = 0; i < this.images.length; i++) {
			const img = this.images[i]
			const col = i % cols
			const row = Math.floor(i / cols)
			const w = img.naturalWidth || img.width
			const h = img.naturalHeight || img.height
			const scale = Math.min(cellW / w, cellH / h)
			const drawW = Math.round(w * scale)
			const drawH = Math.round(h * scale)
			const x = gap + col * (cellW + gap) + Math.round((cellW - drawW) / 2)
			const y = gap + row * (cellH + gap) + Math.round((cellH - drawH) / 2)
			this.previewCtx.drawImage(img, x, y, drawW, drawH)
		}
	}

	private async save(): Promise<void> {
		try {
			const filePath = await writeCanvasImage(this.plugin, this.previewCanvas, 'reference_compose')
			addFileNode(this.canvas, this.node, filePath, this.previewCanvas.width, this.previewCanvas.height)
			new Notice('Reference image created')
			this.close()
		} catch (err: unknown) {
			console.error('Bragi reference compose failed', err)
			new Notice(`Reference compose failed: ${err?.message || err}`)
		}
	}
}

function getImagePathFromNode(node: CanvasNode): string | null {
	const data = node.getData() as unknown
	const filePath = data.file || ''
	return typeof filePath === 'string' && isImagePath(filePath) ? filePath : null
}

function getSelectedImagePaths(canvas: Canvas): string[] {
	const paths: string[] = []
	for (const item of canvas.selection || []) {
		const path = getImagePathFromNode(item)
		if (path && !paths.includes(path)) paths.push(path)
	}
	return paths
}

function getComposePaths(canvas: Canvas, node: CanvasNode): string[] {
	const selected = getSelectedImagePaths(canvas)
	if (selected.length > 1) return selected
	const direct = getImagePathFromNode(node)
	const upstream = getUpstreamInputs(canvas, node).images
	return [...new Set([direct, ...upstream].filter((path): path is string => Boolean(path)))]
}

export function openImageAnnotationEditor(plugin: BragiCanvas, canvas: Canvas, node: CanvasNode, tool: AnnotationTool): void {
	const filePath = getImagePathFromNode(node)
	if (!filePath) {
		new Notice('Select an image node first')
		return
	}
	new ImageAnnotationModal(plugin, canvas, node, filePath, tool).open()
}

export function openImageCutoutEditor(plugin: BragiCanvas, canvas: Canvas, node: CanvasNode): void {
	const filePath = getImagePathFromNode(node)
	if (!filePath) {
		new Notice('Select an image node first')
		return
	}
	new CutoutModal(plugin, canvas, node, filePath).open()
}

export function openReferenceComposeEditor(plugin: BragiCanvas, canvas: Canvas, node: CanvasNode): void {
	const paths = getComposePaths(canvas, node)
	if (paths.length === 0) {
		new Notice('Select or connect at least one image')
		return
	}
	new ReferenceComposeModal(plugin, canvas, node, paths).open()
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after runtime-shaped drawing code. */

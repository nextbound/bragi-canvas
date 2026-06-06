import { Notice } from 'obsidian'
import type BragiCanvas from './main'
import type { Canvas, CanvasNode } from './types/canvas-internal'
import { DEFAULT_MEDIA_LONG_EDGE, findFreePosition } from './canvas-ops'
import { loadImageFromBinary } from './grid-split'

const IMAGE_FILE_PATTERN = /\.(png|jpe?g|webp|bmp|tiff?|gif|heic|heif)$/i
const MAX_OUTPUT_SIDE = 8192
const MAX_OUTPUT_PIXELS = 32000000
const PLACEMENT_GAP = 40

type CanvasImageNodeData = {
	id?: string
	type?: string
	file?: string
	x?: number
	y?: number
	width?: number
	height?: number
	zIndex?: number
}

type ComposeSource = {
	node: CanvasNode
	filePath: string
	x: number
	y: number
	width: number
	height: number
	zIndex: number
	selectionIndex: number
}

type LoadedSource = ComposeSource & {
	image: HTMLImageElement
}

type Side = 'left' | 'right' | 'top' | 'bottom'

export function isComposableImagePath(filePath: string): boolean {
	return IMAGE_FILE_PATTERN.test(filePath)
}

function generateId(): string {
	return Math.random().toString(36).substring(2, 18)
}

function finiteNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function extToMime(filePath: string): string {
	const ext = (filePath.split('.').pop() || '').toLowerCase()
	if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
	if (ext === 'webp') return 'image/webp'
	if (ext === 'gif') return 'image/gif'
	if (ext === 'bmp') return 'image/bmp'
	if (ext === 'tif' || ext === 'tiff') return 'image/tiff'
	if (ext === 'heic') return 'image/heic'
	if (ext === 'heif') return 'image/heif'
	return 'image/png'
}

function collectSources(nodes: CanvasNode[]): ComposeSource[] {
	return nodes.map((node, selectionIndex) => {
		const data = node.getData() as CanvasImageNodeData
		return {
			node,
			filePath: data.file || '',
			x: finiteNumber(data.x, node.x),
			y: finiteNumber(data.y, node.y),
			width: Math.max(1, finiteNumber(data.width, node.width)),
			height: Math.max(1, finiteNumber(data.height, node.height)),
			zIndex: finiteNumber(data.zIndex, node.zIndex || 0),
			selectionIndex,
		}
	})
}

function getBounds(sources: ComposeSource[]): { x: number; y: number; width: number; height: number } {
	const minX = Math.min(...sources.map(source => source.x))
	const minY = Math.min(...sources.map(source => source.y))
	const maxX = Math.max(...sources.map(source => source.x + source.width))
	const maxY = Math.max(...sources.map(source => source.y + source.height))
	return {
		x: minX,
		y: minY,
		width: Math.max(1, maxX - minX),
		height: Math.max(1, maxY - minY),
	}
}

function median(values: number[]): number | null {
	const sorted = values
		.filter(value => Number.isFinite(value) && value > 0)
		.sort((a, b) => a - b)
	if (sorted.length === 0) return null
	const mid = Math.floor(sorted.length / 2)
	if (sorted.length % 2 === 1) return sorted[mid]
	return (sorted[mid - 1] + sorted[mid]) / 2
}

function getNaturalLongEdge(img: HTMLImageElement): number {
	return Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height)
}

function getPixelScale(width: number, height: number, sources: LoadedSource[]): { scale: number; limited: boolean } {
	const naturalScales = sources.map(source => getNaturalLongEdge(source.image) / DEFAULT_MEDIA_LONG_EDGE)
	const targetScale = median(naturalScales) || 4
	const sideScale = MAX_OUTPUT_SIDE / Math.max(width, height)
	const pixelScale = Math.sqrt(MAX_OUTPUT_PIXELS / Math.max(1, width * height))
	const scale = Math.min(targetScale, sideScale, pixelScale)
	return { scale, limited: scale < targetScale }
}

function canvasToPngBlob(canvasEl: HTMLCanvasElement): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvasEl.toBlob((blob) => {
			if (blob) {
				resolve(blob)
			} else {
				reject(new Error('PNG export failed'))
			}
		}, 'image/png')
	})
}

function drawImageCover(
	ctx: CanvasRenderingContext2D,
	img: HTMLImageElement,
	x: number,
	y: number,
	width: number,
	height: number,
): void {
	const imgWidth = img.naturalWidth || img.width
	const imgHeight = img.naturalHeight || img.height
	const srcAspect = imgWidth / imgHeight
	const destAspect = width / height

	let sx = 0
	let sy = 0
	let sw = imgWidth
	let sh = imgHeight

	if (srcAspect > destAspect) {
		sw = imgHeight * destAspect
		sx = (imgWidth - sw) / 2
	} else if (srcAspect < destAspect) {
		sh = imgWidth / destAspect
		sy = (imgHeight - sh) / 2
	}

	ctx.drawImage(img, sx, sy, sw, sh, x, y, width, height)
}

function getEdgeSides(from: ComposeSource, target: { x: number; y: number; width: number; height: number }): { fromSide: Side; toSide: Side } {
	const fromCenterX = from.x + from.width / 2
	const fromCenterY = from.y + from.height / 2
	const targetCenterX = target.x + target.width / 2
	const targetCenterY = target.y + target.height / 2
	const dx = targetCenterX - fromCenterX
	const dy = targetCenterY - fromCenterY

	if (Math.abs(dx) >= Math.abs(dy)) {
		return dx >= 0
			? { fromSide: 'right', toSide: 'left' }
			: { fromSide: 'left', toSide: 'right' }
	}

	return dy >= 0
		? { fromSide: 'bottom', toSide: 'top' }
		: { fromSide: 'top', toSide: 'bottom' }
}

async function loadSources(plugin: BragiCanvas, sources: ComposeSource[]): Promise<LoadedSource[]> {
	const adapter = plugin.app.vault.adapter
	const loaded: LoadedSource[] = []
	for (const source of sources) {
		const binary = await adapter.readBinary(source.filePath)
		const image = await loadImageFromBinary(binary, extToMime(source.filePath))
		loaded.push({ ...source, image })
	}
	return loaded
}

export async function composeSelectedImageNodes(plugin: BragiCanvas, canvas: Canvas, nodes: CanvasNode[]): Promise<void> {
	if (nodes.length < 2) {
		new Notice('Select at least two image nodes')
		return
	}

	const sources = collectSources(nodes)
	if (!sources.every(source => source.filePath && isComposableImagePath(source.filePath))) {
		new Notice('Only image nodes can be composed')
		return
	}

	new Notice('Creating collage...')

	const loaded = await loadSources(plugin, sources)
	const bounds = getBounds(sources)
	const { scale: pixelScale, limited: wasScaleLimited } = getPixelScale(bounds.width, bounds.height, loaded)
	const pixelWidth = Math.max(1, Math.round(bounds.width * pixelScale))
	const pixelHeight = Math.max(1, Math.round(bounds.height * pixelScale))
	const canvasEl = createEl('canvas')
	canvasEl.width = pixelWidth
	canvasEl.height = pixelHeight
	const ctx = canvasEl.getContext('2d')
	if (!ctx) throw new Error('Canvas 2D context unavailable')
	ctx.imageSmoothingEnabled = true
	ctx.imageSmoothingQuality = 'high'
	ctx.clearRect(0, 0, pixelWidth, pixelHeight)

	loaded
		.sort((a, b) => {
			if (a.zIndex !== b.zIndex) return a.zIndex - b.zIndex
			return a.selectionIndex - b.selectionIndex
		})
		.forEach((source) => {
			drawImageCover(
				ctx,
				source.image,
				(source.x - bounds.x) * pixelScale,
				(source.y - bounds.y) * pixelScale,
				source.width * pixelScale,
				source.height * pixelScale,
			)
		})

	const blob = await canvasToPngBlob(canvasEl)
	const outputDir = plugin.getOutputDir()
	const adapter = plugin.app.vault.adapter
	if (!await adapter.exists(outputDir)) await adapter.mkdir(outputDir)

	const filePath = `${outputDir}/compose_${Date.now()}_${generateId()}.png`
	await adapter.writeBinary(filePath, await blob.arrayBuffer())
	plugin.rememberGeneratedAsset(filePath)

	const outputId = generateId()
	const targetPosition = findFreePosition(
		canvas,
		bounds.x + bounds.width + PLACEMENT_GAP,
		bounds.y,
		bounds.width,
		bounds.height,
	)
	const outputNode = {
		id: outputId,
		type: 'file' as const,
		file: filePath,
		x: targetPosition.x,
		y: targetPosition.y,
		width: bounds.width,
		height: bounds.height,
		color: '',
	}
	const outputBounds = {
		x: targetPosition.x,
		y: targetPosition.y,
		width: bounds.width,
		height: bounds.height,
	}
	const edges = sources.map((source) => {
		const { fromSide, toSide } = getEdgeSides(source, outputBounds)
		return {
			id: generateId(),
			fromNode: source.node.id,
			fromSide,
			toNode: outputId,
			toSide,
			toEnd: 'arrow',
		}
	})

	const current = canvas.getData()
	canvas.importData({
		nodes: [...current.nodes, outputNode],
		edges: [...current.edges, ...edges],
	})
	void canvas.requestSave()
	// importData mutates the data model but does not repaint on its own; without
	// a frame request the collage node is saved to disk yet never rendered.
	try {
		void canvas.requestFrame()
	} catch (err) {
		console.debug('Bragi collage: canvas frame refresh skipped', err)
	}

	const scaleNote = wasScaleLimited ? ` (${pixelScale.toFixed(2)}x)` : ''
	new Notice(`Collage ready${scaleNote}`)
}

import { App, Notice } from 'obsidian'
import type BragiCanvas from './main'
import type { Canvas, CanvasNode } from './types/canvas-internal'
import { detectGrid, splitGrid, loadImageFromBinary } from './grid-split'

function generateId(): string {
	return Math.random().toString(36).substring(2, 18)
}

function extToMime(ext: string): string {
	const e = ext.toLowerCase()
	if (e === 'jpg' || e === 'jpeg') return 'image/jpeg'
	if (e === 'webp') return 'image/webp'
	if (e === 'gif') return 'image/gif'
	return 'image/png'
}

export async function splitImageNodeIntoTiles(plugin: BragiCanvas, canvas: Canvas, node: CanvasNode): Promise<void> {
	const data = node.getData() as unknown
	const imgPath: string | undefined = data.file
	if (!imgPath) { new Notice('This node has no image file'); return }

	const ext = (imgPath.split('.').pop() || 'png').toLowerCase()
	if (!/^(png|jpe?g|webp|gif)$/.test(ext)) {
		new Notice('Not an image file')
		return
	}

	new Notice('Analyzing grid…')

	const adapter = plugin.app.vault.adapter
	const binary = await adapter.readBinary(imgPath)
	const img = await loadImageFromBinary(binary, extToMime(ext))
	const detection = await detectGrid(img)

	if (detection.rows * detection.cols <= 1) {
		new Notice('No grid detected')
		return
	}

	const tiles = await splitGrid(img, detection)

	// Save tiles to vault
	const outputDir = plugin.getOutputDir()
	if (!await adapter.exists(outputDir)) await adapter.mkdir(outputDir)
	const timestamp = Date.now()
	const tileFiles: string[] = []
	for (let i = 0; i < tiles.length; i++) {
		const t = tiles[i]
		const fileName = `tile_${timestamp}_${i}.png`
		const filePath = `${outputDir}/${fileName}`
		const buf = await t.blob.arrayBuffer()
		await adapter.writeBinary(filePath, buf)
		tileFiles.push(filePath)
	}

	// Place new nodes: vertically stacked, to the right of source, with uniform gap
	const src = data
	const srcX = src.x, srcY = src.y, srcW = src.width, srcH = src.height
	const gap = 40
	const targetW = Math.max(200, Math.round(srcW * 0.6))  // smaller so stack doesn't explode
	const aspect = tiles[0].width / tiles[0].height
	const targetH = Math.max(120, Math.round(targetW / aspect))

	const newX = srcX + srcW + gap
	let cursorY = srcY

	const current = canvas.getData()
	const newNodes: unknown[] = []
	const newEdges: unknown[] = []

	for (let i = 0; i < tileFiles.length; i++) {
		const nodeId = generateId()
		newNodes.push({
			id: nodeId,
			type: 'file' as const,
			file: tileFiles[i],
			x: newX,
			y: cursorY,
			width: targetW,
			height: targetH,
			color: '',
		})
		newEdges.push({
			id: generateId(),
			fromNode: node.id,
			fromSide: 'right',
			toNode: nodeId,
			toSide: 'left',
			toEnd: 'arrow',
		})
		cursorY += targetH + gap
	}

	canvas.importData({
		...current,
		nodes: [...current.nodes, ...newNodes],
		edges: [...current.edges, ...newEdges],
	})
	void canvas.requestSave()

	new Notice(`Split into ${tiles.length} tile${tiles.length === 1 ? '' : 's'}`)
}

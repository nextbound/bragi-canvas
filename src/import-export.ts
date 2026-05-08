import { App, Notice, TFile } from 'obsidian'
import { remote } from 'electron'
import * as fs from 'fs'
import type { BragiSettings } from './settings'
import type { Canvas } from './types/canvas-internal'
import JSZip from 'jszip'

const MANIFEST_VERSION = 1

function generateId(): string {
	return Math.random().toString(36).substring(2, 18)
}

function basename(path: string): string {
	return path.split('/').pop() || path
}

function dirname(path: string): string {
	const idx = path.lastIndexOf('/')
	return idx >= 0 ? path.substring(0, idx) : ''
}

function withoutExt(name: string): string {
	const idx = name.lastIndexOf('.')
	return idx > 0 ? name.substring(0, idx) : name
}

function ext(name: string): string {
	const idx = name.lastIndexOf('.')
	return idx > 0 ? name.substring(idx) : ''
}

// ── Export ──────────────────────────────────────────────────────────

export async function exportCanvas(app: App, settings: BragiSettings, canvas: Canvas): Promise<void> {
	const notice = new Notice('Exporting canvas…', 0)

	try {
		const canvasFilePath = getCanvasFilePath(app)
		if (!canvasFilePath) {
			notice.hide()
			new Notice('Open a canvas first')
			return
		}

		const canvasName = withoutExt(basename(canvasFilePath))
		const assetBase = '_bragi/assets'

		const data = canvas.getData() as unknown
		const cloned = JSON.parse(JSON.stringify(data))

		// Collect all file references
		const fileRefs = collectFileRefs(cloned)
		notice.setMessage(`Exporting ${fileRefs.length} assets…`)

		// Build path mapping: vaultPath → packagePath
		const pathMap = new Map<string, string>()
		const usedPackagePaths = new Set<string>()

		for (const vaultPath of fileRefs) {
			let pkgPath: string
			if (vaultPath.startsWith(assetBase + '/')) {
				pkgPath = 'assets/' + vaultPath.substring(assetBase.length + 1)
			} else {
				pkgPath = 'assets/' + basename(vaultPath)
			}
			// Handle collisions
			if (usedPackagePaths.has(pkgPath)) {
				const base = withoutExt(pkgPath)
				const extension = ext(pkgPath)
				let i = 2
				while (usedPackagePaths.has(`${base}_${i}${extension}`)) i++
				pkgPath = `${base}_${i}${extension}`
			}
			usedPackagePaths.add(pkgPath)
			pathMap.set(vaultPath, pkgPath)
		}

		// Rewrite paths in cloned data
		rewritePaths(cloned, pathMap)

		// Build zip
		const zip = new JSZip()

		// Manifest
		zip.file('manifest.json', JSON.stringify({
			version: MANIFEST_VERSION,
			bragiVersion: '1.1.0',
			exportDate: new Date().toISOString(),
			canvasName,
			nodeCount: cloned.nodes?.length || 0,
			assetCount: fileRefs.length,
		}, null, 2))

		zip.file('canvas.json', JSON.stringify(cloned, null, 2))

		// Add asset files
		let added = 0
		for (const [vaultPath, pkgPath] of pathMap) {
			try {
				if (await app.vault.adapter.exists(vaultPath)) {
					const binary = await app.vault.adapter.readBinary(vaultPath)
					zip.file(pkgPath, binary)
					added++
					notice.setMessage(`Reading assets… ${added}/${fileRefs.length}`)
				} else {
					new Notice(`Couldn't find ${basename(vaultPath)}, skipping`)
				}
			} catch {
				new Notice(`Couldn't read ${basename(vaultPath)}, skipping`)
			}
		}

		notice.setMessage('Compressing…')
		const buffer = await zip.generateAsync(
			{ type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } },
			(meta) => { notice.setMessage(`Compressing… ${Math.round(meta.percent)}%`) }
		)

		// Save dialog
		const result = await remote.dialog.showSaveDialog({
			title: 'Export Bragi Canvas',
			defaultPath: `${canvasName}.bragi`,
			filters: [
				{ name: 'Bragi Canvas Package', extensions: ['bragi'] },
				{ name: 'All Files', extensions: ['*'] },
			],
		})

		if (result.canceled || !result.filePath) {
			notice.hide()
			return
		}

		fs.writeFileSync(result.filePath, Buffer.from(buffer))

		notice.hide()
		const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(1)
		new Notice(`Exported ${basename(result.filePath)} — ${sizeMB} MB, ${added} file${added === 1 ? '' : 's'}`)
	} catch (err: unknown) {
		notice.hide()
		new Notice(`Export failed: ${err.message}`)
		console.error('Bragi export error:', err)
	}
}

// ── Import ─────────────────────────────────────────────────────────

export async function importCanvas(
	app: App,
	settings: BragiSettings,
	canvas: Canvas | null,
	mode: 'merge' | 'new'
): Promise<void> {
	const notice = new Notice('Importing…', 0)

	try {
		// Open dialog
		const openResult = await remote.dialog.showOpenDialog({
			title: 'Import Bragi Canvas Package',
			filters: [
				{ name: 'Bragi Canvas Package', extensions: ['bragi'] },
				{ name: 'All Files', extensions: ['*'] },
			],
			properties: ['openFile'],
		})

		if (openResult.canceled || openResult.filePaths.length === 0) {
			notice.hide()
			return
		}

		const fileBuffer = fs.readFileSync(openResult.filePaths[0])
		const zip = await JSZip.loadAsync(fileBuffer)

		const canvasJsonFile = zip.file('canvas.json')
		if (!canvasJsonFile) {
			notice.hide()
			new Notice("This doesn't look like a valid bragi package")
			return
		}

		const importedData = JSON.parse(await canvasJsonFile.async('string'))

		// Determine target asset directory
		let targetCanvasDir: string
		let targetCanvasPath: string | null = null

		if (mode === 'merge' && canvas) {
			const filePath = getCanvasFilePath(app)
			if (!filePath) {
				notice.hide()
				new Notice('Open a canvas first')
				return
			}
			targetCanvasDir = dirname(filePath)
		} else {
			// New canvas: place next to current canvas or in vault root
			const currentPath = getCanvasFilePath(app)
			targetCanvasDir = currentPath ? dirname(currentPath) : ''

			const bragiName = withoutExt(basename(openResult.filePaths[0]))
			targetCanvasPath = targetCanvasDir ? `${targetCanvasDir}/${bragiName}.canvas` : `${bragiName}.canvas`
			let counter = 1
			while (await app.vault.adapter.exists(targetCanvasPath)) {
				const suffixed = `${bragiName}_${counter}`
				targetCanvasPath = targetCanvasDir ? `${targetCanvasDir}/${suffixed}.canvas` : `${suffixed}.canvas`
				counter++
			}
		}

		const targetAssetDir = '_bragi/assets'

		// Extract assets
		notice.setMessage('Extracting assets…')
		const assetFiles = Object.keys(zip.files).filter(p => p.startsWith('assets/') && !zip.files[p].dir)
		const pathMap = new Map<string, string>()
		let extracted = 0

		if (!await app.vault.adapter.exists(targetAssetDir)) {
			await app.vault.adapter.mkdir(targetAssetDir)
		}

		for (const pkgPath of assetFiles) {
			try {
				const relativePart = pkgPath.substring('assets/'.length)
				let vaultPath = `${targetAssetDir}/${relativePart}`

				// Ensure subdirectory exists
				const parentDir = dirname(vaultPath)
				if (parentDir && !await app.vault.adapter.exists(parentDir)) {
					await app.vault.adapter.mkdir(parentDir)
				}

				// Handle filename collision
				if (await app.vault.adapter.exists(vaultPath)) {
					const base = withoutExt(vaultPath)
					const extension = ext(vaultPath)
					let i = 2
					while (await app.vault.adapter.exists(`${base}_${i}${extension}`)) i++
					vaultPath = `${base}_${i}${extension}`
				}

				const binary = await zip.files[pkgPath].async('arraybuffer')
				await app.vault.adapter.writeBinary(vaultPath, binary)
				pathMap.set(pkgPath, vaultPath)
				extracted++
				notice.setMessage(`Extracting assets… ${extracted}/${assetFiles.length}`)
			} catch (err: unknown) {
				new Notice(`Couldn't extract ${basename(pkgPath)}`)
			}
		}

		// Rewrite paths in imported data (package → vault)
		rewritePathsForImport(importedData, pathMap)

		if (mode === 'merge' && canvas) {
			// Collect existing IDs
			const existingData = canvas.getData() as unknown
			const existingIds = new Set<string>([
				...(existingData.nodes || []).map((n: unknown) => n.id),
				...(existingData.edges || []).map((e: unknown) => e.id),
			])

			// Regenerate IDs
			regenerateIds(importedData, existingIds)

			// Calculate offset
			const offset = calculateMergeOffset(existingData.nodes || [], importedData.nodes || [])
			for (const node of (importedData.nodes || [])) {
				node.x += offset.dx
				node.y += offset.dy
			}

			// Merge
			canvas.importData({
				nodes: [...(existingData.nodes || []), ...(importedData.nodes || [])],
				edges: [...(existingData.edges || []), ...(importedData.edges || [])],
			})
			void canvas.requestSave()

			notice.hide()
			new Notice(`Added ${importedData.nodes?.length || 0} node${(importedData.nodes?.length || 0) === 1 ? '' : 's'} and ${extracted} file${extracted === 1 ? '' : 's'}`)
		} else {
			// New canvas
			regenerateIds(importedData, new Set())
			const canvasJson = JSON.stringify(importedData, null, '\t')
			await app.vault.adapter.write(targetCanvasPath!, canvasJson)

			// Open the new canvas
			const file = app.vault.getAbstractFileByPath(targetCanvasPath!)
			if (file && file instanceof TFile) {
				const leaf = app.workspace.getLeaf(false)
				await leaf.openFile(file)
			}

			notice.hide()
			new Notice(`Opened ${basename(targetCanvasPath!)} — ${importedData.nodes?.length || 0} node${(importedData.nodes?.length || 0) === 1 ? '' : 's'}, ${extracted} file${extracted === 1 ? '' : 's'}`)
		}
	} catch (err: unknown) {
		notice.hide()
		new Notice(`Import failed: ${err.message}`)
		console.error('Bragi import error:', err)
	}
}

// ── Helpers ────────────────────────────────────────────────────────

function getCanvasFilePath(app: App): string | null {
	const leaf = app.workspace.getLeaf(false)
	const filePath = (leaf?.view as unknown)?.file?.path as string | undefined
	return filePath || null
}

function collectFileRefs(data: unknown): string[] {
	const refs = new Set<string>()
	for (const node of (data.nodes || [])) {
		if (node.type === 'file' && node.file) {
			refs.add(node.file)
		}
		if (node.type === 'group' && node.background) {
			refs.add(node.background)
		}
	}
	return [...refs]
}

function rewritePaths(data: unknown, pathMap: Map<string, string>): void {
	for (const node of (data.nodes || [])) {
		if (node.type === 'file' && node.file && pathMap.has(node.file)) {
			node.file = pathMap.get(node.file)
		}
		if (node.type === 'group' && node.background && pathMap.has(node.background)) {
			node.background = pathMap.get(node.background)
		}
	}
}

function rewritePathsForImport(data: unknown, pathMap: Map<string, string>): void {
	for (const node of (data.nodes || [])) {
		if (node.type === 'file' && node.file && pathMap.has(node.file)) {
			node.file = pathMap.get(node.file)
		}
		if (node.type === 'group' && node.background && pathMap.has(node.background)) {
			node.background = pathMap.get(node.background)
		}
	}
}

function regenerateIds(data: unknown, existingIds: Set<string>): void {
	const idMap = new Map<string, string>()
	const usedIds = new Set(existingIds)

	for (const node of (data.nodes || [])) {
		let newId: string
		do { newId = generateId() } while (usedIds.has(newId))
		idMap.set(node.id, newId)
		usedIds.add(newId)
		node.id = newId
	}

	for (const edge of (data.edges || [])) {
		let newId: string
		do { newId = generateId() } while (usedIds.has(newId))
		usedIds.add(newId)
		edge.id = newId
		if (idMap.has(edge.fromNode)) edge.fromNode = idMap.get(edge.fromNode)
		if (idMap.has(edge.toNode)) edge.toNode = idMap.get(edge.toNode)
	}
}

function calculateMergeOffset(
	existingNodes: unknown[],
	importedNodes: unknown[]
): { dx: number; dy: number } {
	if (existingNodes.length === 0 || importedNodes.length === 0) {
		return { dx: 0, dy: 0 }
	}

	const existingRight = Math.max(...existingNodes.map((n: unknown) => (n.x || 0) + (n.width || 0)))
	const existingTop = Math.min(...existingNodes.map((n: unknown) => n.y || 0))

	const importedLeft = Math.min(...importedNodes.map((n: unknown) => n.x || 0))
	const importedTop = Math.min(...importedNodes.map((n: unknown) => n.y || 0))

	return {
		dx: existingRight + 200 - importedLeft,
		dy: existingTop - importedTop,
	}
}

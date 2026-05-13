import { App, Notice, TFile } from 'obsidian'
import { remote } from 'electron'
import * as fs from 'fs'
import type { BragiSettings } from './settings'
import type { Canvas } from './types/canvas-internal'

const PACKAGE_FORMAT = 'bragi-canvas-package'
const PACKAGE_VERSION = 2
const TARGET_ASSET_DIR = '_bragi/assets'
const RESERVED_ASSET_BASENAMES = new Set([
	makeReservedAssetBasename('main', 'js'),
	makeReservedAssetBasename('manifest', 'json'),
	makeReservedAssetBasename('styles', 'css'),
])

type CanvasData = {
	nodes?: Record<string, unknown>[]
	edges?: Record<string, unknown>[]
	[key: string]: unknown
}

type BragiPackageAsset = {
	path: string
	encoding: 'base64'
	data: string
}

type BragiPackageFile = {
	format: typeof PACKAGE_FORMAT
	version: typeof PACKAGE_VERSION
	exportDate: string
	canvasName: string
	nodeCount: number
	assetCount: number
	canvas: CanvasData
	assets: BragiPackageAsset[]
}

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

function makeReservedAssetBasename(name: string, extension: string): string {
	return `${name}.${extension}`
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function asCanvasData(value: unknown): CanvasData {
	return value && typeof value === 'object' ? value as CanvasData : { nodes: [], edges: [] }
}

function toBase64(buffer: ArrayBuffer): string {
	return Buffer.from(buffer).toString('base64')
}

function fromBase64(data: string): ArrayBuffer {
	const bytes = Buffer.from(data, 'base64')
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

function downloadBlob(fileName: string, data: BlobPart, mimeType: string): void {
	const blob = new Blob([data], { type: mimeType })
	const url = URL.createObjectURL(blob)
	const link = createEl('a')
	link.href = url
	link.download = fileName
	link.classList.add('bragi-hidden-download-link')
	activeDocument.body.appendChild(link)
	link.click()
	window.setTimeout(() => {
		link.remove()
		URL.revokeObjectURL(url)
	}, 1000)
}

function safePackagePath(vaultPath: string, assetBase: string): string {
	const rawRelative = vaultPath.startsWith(assetBase + '/')
		? vaultPath.substring(assetBase.length + 1)
		: basename(vaultPath)
	const parts = rawRelative
		.split('/')
		.filter(part => part && part !== '.' && part !== '..')
	let fileName = parts.pop() || 'asset'
	if (RESERVED_ASSET_BASENAMES.has(fileName.toLowerCase())) {
		fileName = `asset-${fileName}`
	}
	parts.push(fileName)
	return `assets/${parts.join('/')}`
}

function validateAssetPackagePath(pkgPath: string): string {
	if (!pkgPath.startsWith('assets/')) {
		throw new Error('A bragi package asset points outside its assets folder')
	}
	if (pkgPath.includes('\\') || pkgPath.includes('\0') || pkgPath.startsWith('/') || /^[A-Za-z]:/.test(pkgPath)) {
		throw new Error('A bragi package contains an unsafe asset path')
	}

	const relativePart = pkgPath.substring('assets/'.length)
	const parts = relativePart.split('/')
	if (!relativePart || parts.some(part => !part || part === '.' || part === '..')) {
		throw new Error('A bragi package contains an unsafe asset path')
	}
	if (RESERVED_ASSET_BASENAMES.has(parts[parts.length - 1].toLowerCase())) {
		throw new Error('This package contains a file name Bragi does not import for safety')
	}
	return relativePart
}

async function readBragiPackage(filePath: string): Promise<{ canvas: CanvasData; assets: BragiPackageAsset[] }> {
	const raw = await fs.promises.readFile(filePath, 'utf8')
	const parsed = JSON.parse(raw) as unknown
	const pkg = asRecord(parsed)

	if (!pkg || pkg.format !== PACKAGE_FORMAT || pkg.version !== PACKAGE_VERSION) {
		throw new Error("This doesn't look like a valid bragi package")
	}

	const canvas = asCanvasData(pkg.canvas)
	if (!Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) {
		throw new Error('This bragi package has a damaged canvas')
	}

	const assetsValue = pkg.assets
	if (assetsValue !== undefined && !Array.isArray(assetsValue)) {
		throw new Error('This bragi package has a damaged asset list')
	}

	const assets: BragiPackageAsset[] = []
	for (const item of assetsValue || []) {
		const asset = asRecord(item)
		if (!asset || typeof asset.path !== 'string' || asset.encoding !== 'base64' || typeof asset.data !== 'string') {
			throw new Error('This bragi package has a damaged asset')
		}
		validateAssetPackagePath(asset.path)
		assets.push({ path: asset.path, encoding: 'base64', data: asset.data })
	}

	return { canvas: JSON.parse(JSON.stringify(canvas)) as CanvasData, assets }
}

async function ensureVaultFolder(app: App, dir: string): Promise<void> {
	if (!dir) return
	const parts = dir.split('/').filter(Boolean)
	let current = ''
	for (const part of parts) {
		current = current ? `${current}/${part}` : part
		if (!await app.vault.adapter.exists(current)) {
			await app.vault.adapter.mkdir(current)
		}
	}
}

// ── Export ──────────────────────────────────────────────────────────

export async function exportCanvas(app: App, _settings: BragiSettings, canvas: Canvas): Promise<void> {
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

		const data = asCanvasData(canvas.getData())
		const cloned = JSON.parse(JSON.stringify(data))

		// Collect all file references
		const fileRefs = collectFileRefs(cloned)
		notice.setMessage(`Exporting ${fileRefs.length} assets…`)

		// Build path mapping: vaultPath → packagePath
		const pathMap = new Map<string, string>()
		const usedPackagePaths = new Set<string>()

		for (const vaultPath of fileRefs) {
			let pkgPath = safePackagePath(vaultPath, assetBase)
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

		const packageData: BragiPackageFile = {
			format: PACKAGE_FORMAT,
			version: PACKAGE_VERSION,
			exportDate: new Date().toISOString(),
			canvasName,
			nodeCount: cloned.nodes?.length || 0,
			assetCount: fileRefs.length,
			canvas: cloned,
			assets: [],
		}

		// Add asset files
		let added = 0
		for (const [vaultPath, pkgPath] of pathMap) {
			try {
				if (await app.vault.adapter.exists(vaultPath)) {
					const binary = await app.vault.adapter.readBinary(vaultPath)
					packageData.assets.push({
						path: pkgPath,
						encoding: 'base64',
						data: toBase64(binary),
					})
					added++
					notice.setMessage(`Reading assets… ${added}/${fileRefs.length}`)
				} else {
					new Notice(`Couldn't find ${basename(vaultPath)}, skipping`)
				}
			} catch {
				new Notice(`Couldn't read ${basename(vaultPath)}, skipping`)
			}
		}

		packageData.assetCount = added
		notice.setMessage('Preparing package…')
		const buffer = Buffer.from(JSON.stringify(packageData, null, 2), 'utf8')
		const fileName = `${canvasName}.bragi`
		downloadBlob(fileName, buffer, 'application/octet-stream')

		notice.hide()
		const sizeMB = (buffer.byteLength / 1024 / 1024).toFixed(1)
		new Notice(`Exported ${fileName} — ${sizeMB} MB, ${added} file${added === 1 ? '' : 's'}`)
	} catch (err: unknown) {
		notice.hide()
		new Notice(`Export failed: ${err.message}`)
		console.error('Bragi export error:', err)
	}
}

// ── Import ─────────────────────────────────────────────────────────

export async function importCanvas(
	app: App,
	_settings: BragiSettings,
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

		const packageFile = await readBragiPackage(openResult.filePaths[0])
		const importedData = packageFile.canvas

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

		// Bragi packages are data files. Assets are only ever written into the vault-scoped _bragi/assets folder.
		notice.setMessage('Importing assets…')
		const pathMap = new Map<string, string>()
		let importedFileCount = 0

		await ensureVaultFolder(app, TARGET_ASSET_DIR)

		for (const asset of packageFile.assets) {
			try {
				const relativePart = validateAssetPackagePath(asset.path)
				let vaultPath = `${TARGET_ASSET_DIR}/${relativePart}`

				// Ensure subdirectory exists
				const parentDir = dirname(vaultPath)
				await ensureVaultFolder(app, parentDir)

				// Handle filename collision
				if (await app.vault.adapter.exists(vaultPath)) {
					const base = withoutExt(vaultPath)
					const extension = ext(vaultPath)
					let i = 2
					while (await app.vault.adapter.exists(`${base}_${i}${extension}`)) i++
					vaultPath = `${base}_${i}${extension}`
				}

				const binary = fromBase64(asset.data)
				await app.vault.adapter.writeBinary(vaultPath, binary)
				pathMap.set(asset.path, vaultPath)
				importedFileCount++
				notice.setMessage(`Importing assets… ${importedFileCount}/${packageFile.assets.length}`)
			} catch (err: unknown) {
				new Notice(`Couldn't import ${basename(asset.path)}: ${err.message}`)
			}
		}

		// Rewrite paths in imported data (package → vault)
		rewritePathsForImport(importedData, pathMap)

		if (mode === 'merge' && canvas) {
			// Collect existing IDs
			const existingData = asCanvasData(canvas.getData())
			const existingIds = new Set<string>([
				...(existingData.nodes || []).map((n: unknown) => n.id),
				...(existingData.edges || []).map((e: unknown) => e.id),
			])

			// Regenerate IDs
			regenerateIds(importedData, existingIds)

			// Calculate offset
			const offset = calculateMergeOffset(existingData.nodes || [], importedData.nodes || [])
			for (const node of (importedData.nodes || [])) {
				node.x = Number(node.x || 0) + offset.dx
				node.y = Number(node.y || 0) + offset.dy
			}

			// Merge
			canvas.importData({
				nodes: [...(existingData.nodes || []), ...(importedData.nodes || [])],
				edges: [...(existingData.edges || []), ...(importedData.edges || [])],
			})
			void canvas.requestSave()

			notice.hide()
			new Notice(`Added ${importedData.nodes?.length || 0} node${(importedData.nodes?.length || 0) === 1 ? '' : 's'} and ${importedFileCount} file${importedFileCount === 1 ? '' : 's'}`)
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
			new Notice(`Opened ${basename(targetCanvasPath!)} — ${importedData.nodes?.length || 0} node${(importedData.nodes?.length || 0) === 1 ? '' : 's'}, ${importedFileCount} file${importedFileCount === 1 ? '' : 's'}`)
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

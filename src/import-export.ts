/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import { App, Notice, TFile } from 'obsidian'
import { zip, unzipSync, strToU8, strFromU8 } from 'fflate'
import type { BragiSettings } from './settings'
import type { Canvas } from './types/canvas-internal'

const PACKAGE_FORMAT = 'bragi-canvas-package'
// v3 is a ZIP container (assets stored as raw binary entries); v2 is the legacy
// single-JSON format with base64-inlined assets. We write v3 and import both.
const PACKAGE_VERSION = 3
const PACKAGE_VERSION_LEGACY = 2
// Name of the JSON metadata+canvas entry inside a v3 ZIP package.
const PACKAGE_META_ENTRY = 'bragi-package.json'
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

// Unified, format-agnostic result of reading any bragi package: the canvas plus
// each asset's raw binary (decoded from base64 for v2, or read straight out of
// the ZIP for v3). Keeps the import pipeline identical across formats.
type LoadedAsset = {
	path: string
	binary: Uint8Array
}

type LoadedPackage = {
	canvas: CanvasData
	assets: LoadedAsset[]
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

// Kept for importing legacy (v2) packages whose assets are base64-inlined.
function fromBase64(data: string): Uint8Array {
	return new Uint8Array(Buffer.from(data, 'base64'))
}

// Obsidian's adapter.writeBinary wants an ArrayBuffer; copy out the exact bytes
// (the Uint8Array may be a view into a larger backing buffer).
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

// A v3 package is a ZIP, which always starts with the local-file-header magic
// "PK\x03\x04". A v2 package is JSON, starting with "{".
function isZipPackage(bytes: Uint8Array): boolean {
	return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

function zipAsync(files: Record<string, Uint8Array>): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		// level 0 = store. Assets are already-compressed media; re-deflating them
		// wastes CPU for ~no size gain.
		zip(files, { level: 0 }, (err, data) => {
			if (err) reject(err)
			else resolve(data)
		})
	})
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

/** Read any bragi package (v3 ZIP or legacy v2 JSON) into a unified shape. */
function loadBragiPackage(bytes: Uint8Array): LoadedPackage {
	return isZipPackage(bytes) ? loadZipPackage(bytes) : loadLegacyJsonPackage(bytes)
}

function validatePackageCanvas(pkg: Record<string, unknown> | null, allowedVersions: number[]): CanvasData {
	if (!pkg || pkg.format !== PACKAGE_FORMAT || typeof pkg.version !== 'number' || !allowedVersions.includes(pkg.version)) {
		throw new Error("This doesn't look like a valid bragi package")
	}
	const canvas = asCanvasData(pkg.canvas)
	if (!Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) {
		throw new Error('This bragi package has a damaged canvas')
	}
	return JSON.parse(JSON.stringify(canvas)) as CanvasData
}

/** v3: ZIP with a JSON metadata entry + raw binary asset entries. */
function loadZipPackage(bytes: Uint8Array): LoadedPackage {
	let entries: Record<string, Uint8Array>
	try {
		entries = unzipSync(bytes)
	} catch {
		throw new Error('This bragi package is a damaged archive')
	}

	const metaBytes = entries[PACKAGE_META_ENTRY]
	if (!metaBytes) {
		throw new Error("This doesn't look like a valid bragi package")
	}
	const pkg = asRecord(JSON.parse(strFromU8(metaBytes)) as unknown)
	const canvas = validatePackageCanvas(pkg, [PACKAGE_VERSION])

	const assets: LoadedAsset[] = []
	for (const name of Object.keys(entries)) {
		if (name === PACKAGE_META_ENTRY) continue
		validateAssetPackagePath(name)
		assets.push({ path: name, binary: entries[name] })
	}

	return { canvas, assets }
}

/** Legacy v2: a single JSON document with base64-inlined assets. */
function loadLegacyJsonPackage(bytes: Uint8Array): LoadedPackage {
	const pkg = asRecord(JSON.parse(strFromU8(bytes)) as unknown)
	const canvas = validatePackageCanvas(pkg, [PACKAGE_VERSION_LEGACY])

	const assetsValue = pkg!.assets
	if (assetsValue !== undefined && !Array.isArray(assetsValue)) {
		throw new Error('This bragi package has a damaged asset list')
	}

	const assets: LoadedAsset[] = []
	for (const item of (assetsValue as unknown[]) || []) {
		const asset = asRecord(item)
		if (!asset || typeof asset.path !== 'string' || asset.encoding !== 'base64' || typeof asset.data !== 'string') {
			throw new Error('This bragi package has a damaged asset')
		}
		validateAssetPackagePath(asset.path)
		assets.push({ path: asset.path, binary: fromBase64(asset.data) })
	}

	return { canvas, assets }
}

function chooseBragiPackageFile(): Promise<File | null> {
	return new Promise((resolve) => {
		const input = createEl('input')
		input.type = 'file'
		input.accept = '.bragi,application/zip,application/json'
		input.classList.add('bragi-hidden')
		activeDocument.body.appendChild(input)

		let done = false
		const finish = (file: File | null) => {
			if (done) return
			done = true
			window.removeEventListener('focus', onFocus)
			input.remove()
			resolve(file)
		}
		const onFocus = () => {
			window.setTimeout(() => {
				if (!input.files || input.files.length === 0) finish(null)
			}, 500)
		}

		input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true })
		window.addEventListener('focus', onFocus, { once: true })
		input.click()
	})
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

		// Build the ZIP entry map. Assets are stored as raw binary entries (no
		// base64), and the metadata+canvas is a single small JSON entry. This
		// avoids ever materializing the whole package as one JS string, which is
		// what overflowed V8's ~512MB string cap ("Invalid string length").
		const zipFiles: Record<string, Uint8Array> = {}
		let added = 0
		for (const [vaultPath, pkgPath] of pathMap) {
			try {
				if (await app.vault.adapter.exists(vaultPath)) {
					const binary = await app.vault.adapter.readBinary(vaultPath)
					zipFiles[pkgPath] = new Uint8Array(binary)
					added++
					notice.setMessage(`Reading assets… ${added}/${fileRefs.length}`)
				} else {
					new Notice(`Couldn't find ${basename(vaultPath)}, skipping`)
				}
			} catch {
				new Notice(`Couldn't read ${basename(vaultPath)}, skipping`)
			}
		}

		const metadata = {
			format: PACKAGE_FORMAT,
			version: PACKAGE_VERSION,
			exportDate: new Date().toISOString(),
			canvasName,
			nodeCount: cloned.nodes?.length || 0,
			assetCount: added,
			canvas: cloned,
		}
		zipFiles[PACKAGE_META_ENTRY] = strToU8(JSON.stringify(metadata))

		notice.setMessage('Preparing package…')
		const packed = await zipAsync(zipFiles)
		const fileName = `${canvasName}.bragi`
		downloadBlob(fileName, packed, 'application/zip')

		notice.hide()
		const sizeMB = (packed.byteLength / 1024 / 1024).toFixed(1)
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
		const selectedFile = await chooseBragiPackageFile()
		if (!selectedFile) {
			notice.hide()
			return
		}

		// Read as bytes (not text): a large package would overflow V8's string
		// cap if read via selectedFile.text(). loadBragiPackage detects ZIP (v3)
		// vs legacy JSON (v2) by magic bytes.
		const packageBytes = new Uint8Array(await selectedFile.arrayBuffer())
		const loaded = loadBragiPackage(packageBytes)
		const importedData = loaded.canvas

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

			const bragiName = withoutExt(basename(selectedFile.name))
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

		for (const asset of loaded.assets) {
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

				await app.vault.adapter.writeBinary(vaultPath, toArrayBuffer(asset.binary))
				pathMap.set(asset.path, vaultPath)
				importedFileCount++
				notice.setMessage(`Importing assets… ${importedFileCount}/${loaded.assets.length}`)
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

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Resume strict linting after the runtime-shaped data boundary. */

import { errorMessage } from './task-errors'
import type { CanvasView } from './types/canvas-internal'
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import { App, FileSystemAdapter, Modal, Notice, Setting, TFile } from 'obsidian'
import { Zip, ZipPassThrough, Unzip, UnzipInflate, unzipSync, strToU8, strFromU8 } from 'fflate'
import type { AsyncFlateStreamHandler } from 'fflate'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'fs'
import { dirname as fsDirname } from 'path'
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
	return new Uint8Array(bytes).buffer
}

// A v3 package is a ZIP, which always starts with the local-file-header magic
// "PK\x03\x04". A v2 package is JSON, starting with "{".
function isZipPackage(bytes: Uint8Array): boolean {
	return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

// Streaming export/import write straight to/from disk so we never hold the whole
// package (or its base64) in memory — sidestepping both V8's ~512MB string cap
// and the ~2GB single-Uint8Array cap, with no Worker dependency.
const STREAM_CHUNK = 8 * 1024 * 1024

function requireLocalAdapter(app: App): FileSystemAdapter {
	const adapter = app.vault.adapter
	if (adapter instanceof FileSystemAdapter) return adapter
	throw new Error('Bragi import/export requires a local (desktop) vault')
}

// Reveal a vault file in the OS file manager via Obsidian's built-in helper
// (the same one core uses for "Show in system explorer"). Undocumented, so
// guarded and best-effort.
function revealInSystemExplorer(app: App, vaultRelativePath: string): void {
	const reveal = (app as unknown as { showInFolder?: (path: string) => void }).showInFolder
	if (typeof reveal !== 'function') return
	try {
		reveal.call(app, vaultRelativePath)
	} catch (err) {
		console.debug('Bragi export: reveal in file manager skipped', err)
	}
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(typeof value === 'string' ? value : 'Unknown error')
}

function concatU8(chunks: Uint8Array[]): Uint8Array {
	let total = 0
	for (const c of chunks) total += c.length
	const out = new Uint8Array(total)
	let off = 0
	for (const c of chunks) { out.set(c, off); off += c.length }
	return out
}

function whenDrained(stream: NodeJS.WritableStream & { writableNeedDrain?: boolean }): Promise<void> {
	if (!stream.writableNeedDrain) return Promise.resolve()
	return new Promise(resolve => stream.once('drain', () => resolve()))
}

/** Add one stored (uncompressed) ZIP entry, slicing large data + honoring backpressure. */
async function pushStoreEntry(
	zipStream: Zip,
	out: NodeJS.WritableStream & { writableNeedDrain?: boolean },
	name: string,
	data: Uint8Array,
): Promise<void> {
	const entry = new ZipPassThrough(name)
	zipStream.add(entry)
	if (data.length === 0) {
		entry.push(new Uint8Array(0), true)
		return
	}
	for (let off = 0; off < data.length; off += STREAM_CHUNK) {
		const end = Math.min(off + STREAM_CHUNK, data.length)
		entry.push(data.subarray(off, end), end >= data.length)
		await whenDrained(out)
	}
}

type StreamImportResult = { canvas: CanvasData; pathMap: Map<string, string>; count: number }

/**
 * Stream-extract a v3 ZIP package directly from the picked file on disk, writing
 * each asset entry to the vault as it arrives and buffering only the small
 * metadata entry. Avoids reading the whole package into memory.
 */
async function streamImportZip(app: App, sourcePath: string, notice: Notice): Promise<StreamImportResult> {
	const adapter = requireLocalAdapter(app)
	mkdirSync(adapter.getFullPath(TARGET_ASSET_DIR), { recursive: true })

	const pathMap = new Map<string, string>()
	const metaChunks: Uint8Array[] = []
	const assetWrites: Promise<void>[] = []
	let count = 0
	let failure: Error | null = null

	const reserveAssetPath = (pkgName: string): string => {
		const relativePart = validateAssetPackagePath(pkgName)
		let vaultRel = `${TARGET_ASSET_DIR}/${relativePart}`
		mkdirSync(fsDirname(adapter.getFullPath(vaultRel)), { recursive: true })
		for (let i = 2; existsSync(adapter.getFullPath(vaultRel)); i++) {
			vaultRel = `${TARGET_ASSET_DIR}/${withoutExt(relativePart)}_${i}${ext(relativePart)}`
		}
		return vaultRel
	}

	await new Promise<void>((resolve, reject) => {
		const rs = createReadStream(sourcePath)
		const unzip = new Unzip()
		unzip.register(UnzipInflate)

		unzip.onfile = (file) => {
			if (file.name === PACKAGE_META_ENTRY) {
				const onMetadataChunk: AsyncFlateStreamHandler = (err, chunk) => {
					if (err) { failure = err; return }
					if (chunk && chunk.length) metaChunks.push(chunk.slice())
				}
				file.ondata = onMetadataChunk
				file.start()
				return
			}

			let vaultRel: string
			try {
				vaultRel = reserveAssetPath(file.name)
			} catch {
				// Unsafe/invalid entry: don't start() it, so fflate discards its data.
				new Notice(`Skipped unsafe entry ${basename(file.name)}`)
				return
			}

			const assetWs = createWriteStream(adapter.getFullPath(vaultRel))
			assetWrites.push(new Promise<void>((res, rej) => {
				assetWs.on('finish', () => res())
				assetWs.on('error', rej)
			}))
			file.ondata = (err, chunk, final) => {
				if (err) { failure = err; assetWs.destroy(err); return }
				if (chunk && chunk.length) assetWs.write(Buffer.from(chunk))
				if (final) assetWs.end()
			}
			pathMap.set(file.name, vaultRel)
			count++
			notice.setMessage(`Importing assets… ${count}`)
			file.start()
		}

		rs.on('data', (c: Buffer) => {
			try { unzip.push(new Uint8Array(c.buffer, c.byteOffset, c.byteLength), false) }
			catch (err) { reject(err as Error) }
		})
		rs.on('end', () => {
			try { unzip.push(new Uint8Array(0), true); resolve() }
			catch (err) { reject(err as Error) }
		})
		rs.on('error', reject)
	})

	await Promise.all(assetWrites)
	if (failure) throw toError(failure)

	const metaBytes = concatU8(metaChunks)
	if (metaBytes.length === 0) throw new Error("This doesn't look like a valid bragi package")
	const pkg = asRecord(JSON.parse(strFromU8(metaBytes)) as unknown)
	const canvas = validatePackageCanvas(pkg, [PACKAGE_VERSION])

	return { canvas, pathMap, count }
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

// ── Export confirmation + destination picker ────────────────────────

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`
	const units = ['KB', 'MB', 'GB', 'TB']
	let value = n / 1024
	let i = 0
	while (value >= 1024 && i < units.length - 1) { value /= 1024; i++ }
	return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}

function ensureBragiExt(path: string): string {
	return /\.bragi$/i.test(path) ? path : `${path}.bragi`
}

interface SaveDialogOptions {
	defaultPath?: string
	filters?: Array<{ name: string; extensions: string[] }>
}
interface ElectronRemoteDialog {
	showSaveDialogSync(options: SaveDialogOptions): string | undefined
}
interface ElectronShell {
	showItemInFolder(fullPath: string): void
}

function windowRequire(moduleName: string): unknown {
	const req = (window as unknown as { require?: (m: string) => unknown }).require
	if (typeof req !== 'function') return null
	try { return req(moduleName) } catch { return null }
}

/** Native Save dialog via Electron remote, if Obsidian exposes it (desktop). */
function getSaveDialog(): ElectronRemoteDialog | null {
	const remote = asRecord(windowRequire('@electron/remote'))
		?? asRecord(asRecord(windowRequire('electron'))?.remote)
	const dialog = remote?.dialog as ElectronRemoteDialog | undefined
	return dialog && typeof dialog.showSaveDialogSync === 'function' ? dialog : null
}

function getElectronShell(): ElectronShell | null {
	const shell = asRecord(windowRequire('electron'))?.shell as ElectronShell | undefined
	return shell && typeof shell.showItemInFolder === 'function' ? shell : null
}

type ExportStats = {
	canvasName: string
	assetCount: number
	missingCount: number
	totalAssetBytes: number
	estimatedZipBytes: number
}

type ExportDestination = { absPath: string; vaultRelative: string | null }

/** Reveal the exported package in the OS file manager (absolute path preferred). */
function revealExported(app: App, dest: ExportDestination): void {
	const shell = getElectronShell()
	if (shell) {
		try { shell.showItemInFolder(dest.absPath); return } catch { /* fall back below */ }
	}
	if (dest.vaultRelative) revealInSystemExplorer(app, dest.vaultRelative)
}

class ExportConfirmModal extends Modal {
	private resolved = false
	private dest: ExportDestination

	constructor(
		app: App,
		private stats: ExportStats,
		defaultDest: ExportDestination,
		private onResolve: (dest: ExportDestination | null) => void,
	) {
		super(app)
		this.dest = defaultDest
	}

	private destLabel(): string {
		return this.dest.vaultRelative ? `In vault: ${this.dest.vaultRelative}` : this.dest.absPath
	}

	override onOpen(): void {
		const { contentEl } = this
		contentEl.empty()
		contentEl.createEl('h3', { text: 'Export canvas package' })

		const info = contentEl.createDiv({ cls: 'bragi-export-summary' })
		const addRow = (label: string, value: string) => {
			const p = info.createEl('p')
			p.createEl('strong', { text: `${label}: ` })
			p.appendText(value)
		}
		addRow('Canvas', this.stats.canvasName)
		addRow('Assets', String(this.stats.assetCount))
		addRow('Assets size', formatBytes(this.stats.totalAssetBytes))
		addRow('Estimated package', `~${formatBytes(this.stats.estimatedZipBytes)}`)
		if (this.stats.missingCount > 0) {
			addRow('Missing (will be skipped)', String(this.stats.missingCount))
		}
		if (this.stats.estimatedZipBytes > 1024 * 1024 * 1024) {
			contentEl.createEl('p', {
				text: 'This is a large package — packing may take a while and cannot be interrupted once started.',
				cls: 'mod-warning',
			})
		}

		const destSetting = new Setting(contentEl).setName('Save to').setDesc(this.destLabel())
		const saveDialog = getSaveDialog()
		if (saveDialog) {
			destSetting.addButton(btn => btn
				.setButtonText('Change…')
				.onClick(() => {
					const picked = saveDialog.showSaveDialogSync({
						defaultPath: this.dest.absPath,
						filters: [{ name: 'Bragi package', extensions: ['bragi'] }],
					})
					if (picked) {
						this.dest = { absPath: ensureBragiExt(picked), vaultRelative: null }
						destSetting.setDesc(this.destLabel())
					}
				}))
		}

		new Setting(contentEl)
			.addButton(btn => btn.setButtonText('Cancel').onClick(() => this.finish(null)))
			.addButton(btn => btn.setButtonText('Export').setCta().onClick(() => this.finish(this.dest)))
	}

	private finish(dest: ExportDestination | null): void {
		if (this.resolved) return
		this.resolved = true
		this.onResolve(dest)
		this.close()
	}

	override onClose(): void {
		this.contentEl.empty()
		if (!this.resolved) {
			this.resolved = true
			this.onResolve(null)
		}
	}
}

function confirmExport(app: App, stats: ExportStats, defaultDest: ExportDestination): Promise<ExportDestination | null> {
	return new Promise(resolve => {
		new ExportConfirmModal(app, stats, defaultDest, resolve).open()
	})
}

// ── Export ──────────────────────────────────────────────────────────

export async function exportCanvas(app: App, _settings: BragiSettings, canvas: Canvas): Promise<void> {
	try {
		const canvasFilePath = getCanvasFilePath(app)
		if (!canvasFilePath) {
			new Notice('Open a canvas first')
			return
		}

		const canvasName = withoutExt(basename(canvasFilePath))
		const assetBase = '_bragi/assets'

		const data = asCanvasData(canvas.getData())
		const cloned = JSON.parse(JSON.stringify(data))

		// Collect all file references
		const fileRefs = collectFileRefs(cloned)

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

		// Pre-pass: stat assets (cheap, no reads) to summarize the package before
		// committing to a long, uninterruptible pack.
		let totalAssetBytes = 0
		let presentCount = 0
		for (const vaultPath of pathMap.keys()) {
			const stat = await app.vault.adapter.stat(vaultPath)
			if (stat && stat.type === 'file') {
				totalAssetBytes += stat.size
				presentCount++
			}
		}
		const canvasBytes = strToU8(JSON.stringify(cloned)).length
		// Stored ZIP: payload + small per-entry headers (~100 B) + EOCD.
		const estimatedZipBytes = totalAssetBytes + canvasBytes + (presentCount + 1) * 120 + 64

		// Default destination: collision-safe path next to the canvas in the vault.
		const adapter = requireLocalAdapter(app)
		const outDir = dirname(canvasFilePath)
		let defaultRel = outDir ? `${outDir}/${canvasName}.bragi` : `${canvasName}.bragi`
		for (let i = 2; await app.vault.adapter.exists(defaultRel); i++) {
			defaultRel = outDir ? `${outDir}/${canvasName}_${i}.bragi` : `${canvasName}_${i}.bragi`
		}
		const defaultDest: ExportDestination = { absPath: adapter.getFullPath(defaultRel), vaultRelative: defaultRel }

		const dest = await confirmExport(app, {
			canvasName,
			assetCount: presentCount,
			missingCount: pathMap.size - presentCount,
			totalAssetBytes,
			estimatedZipBytes,
		}, defaultDest)
		if (!dest) return

		const notice = new Notice('Exporting canvas…', 0)
		// Stream a ZIP straight to disk: assets are stored as raw binary entries
		// (no base64), the canvas+metadata is one small JSON entry, and nothing is
		// ever held whole in memory — sidestepping V8's ~512MB string cap (the
		// original "Invalid string length") and the ~2GB single-buffer cap.
		const outAbs = dest.absPath

		const ws = createWriteStream(outAbs)
		let streamError: Error | null = null
		const finished = new Promise<void>((resolve, reject) => {
			ws.on('finish', () => resolve())
			ws.on('error', (err) => reject(err))
		})
		const zipStream = new Zip((err, chunk, final) => {
			if (err) { streamError = err; ws.destroy(err); return }
			ws.write(Buffer.from(chunk))
			if (final) ws.end()
		})

		let added = 0
		try {
			for (const [vaultPath, pkgPath] of pathMap) {
				if (streamError) throw toError(streamError)
				if (!await app.vault.adapter.exists(vaultPath)) {
					new Notice(`Couldn't find ${basename(vaultPath)}, skipping`)
					continue
				}
				let binary: ArrayBuffer
				try {
					binary = await app.vault.adapter.readBinary(vaultPath)
				} catch {
					new Notice(`Couldn't read ${basename(vaultPath)}, skipping`)
					continue
				}
				await pushStoreEntry(zipStream, ws, pkgPath, new Uint8Array(binary))
				added++
				notice.setMessage(`Packing assets… ${added}/${presentCount}`)
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
			notice.setMessage('Finalizing package…')
			await pushStoreEntry(zipStream, ws, PACKAGE_META_ENTRY, strToU8(JSON.stringify(metadata)))
			zipStream.end()
			await finished
			if (streamError) throw toError(streamError)
		} catch (err) {
			try { ws.destroy() } catch { /* already closed */ }
			try { if (existsSync(outAbs)) unlinkSync(outAbs) } catch { /* best-effort cleanup */ }
			notice.hide()
			throw err
		}

		notice.hide()
		const sizeMB = (statSync(outAbs).size / 1024 / 1024).toFixed(1)
		new Notice(`Exported ${basename(outAbs)} — ${sizeMB} MB, ${added} file${added === 1 ? '' : 's'}`)
		revealExported(app, dest)
	} catch (err: unknown) {
		new Notice(`Export failed: ${toError(err).message}`)
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

		// Peek the first 4 bytes to detect a v3 ZIP vs legacy v2 JSON without
		// reading the whole file. A v3 ZIP picked from disk is stream-extracted
		// (no whole-file load); legacy JSON (always < the old ~512MB cap) falls
		// back to a bounded whole-file read.
		const head = new Uint8Array(await selectedFile.slice(0, 4).arrayBuffer())
		const sourcePath = (selectedFile as { path?: string }).path
		const canStream = isZipPackage(head) && !!sourcePath && app.vault.adapter instanceof FileSystemAdapter

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
		let importedData: CanvasData

		await ensureVaultFolder(app, TARGET_ASSET_DIR)

		if (canStream) {
			const result = await streamImportZip(app, sourcePath, notice)
			importedData = result.canvas
			for (const [pkgPath, vaultPath] of result.pathMap) pathMap.set(pkgPath, vaultPath)
			importedFileCount = result.count
		} else {
			// Whole-file fallback: legacy v2 JSON, or a v3 ZIP whose on-disk path
			// is unavailable (bounded by the same memory limits as before).
			const loaded = loadBragiPackage(new Uint8Array(await selectedFile.arrayBuffer()))
			importedData = loaded.canvas
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
					new Notice(`Couldn't import ${basename(asset.path)}: ${errorMessage(err)}`)
				}
			}
		}

		// Rewrite paths in imported data (package → vault)
		rewritePathsForImport(importedData, pathMap)

		if (mode === 'merge' && canvas) {
			// Collect existing IDs
			const existingData = asCanvasData(canvas.getData())
			const existingIds = new Set<string>([
				...(existingData.nodes || []).map(n => n.id).filter((id): id is string => typeof id === 'string'),
				...(existingData.edges || []).map(e => e.id).filter((id): id is string => typeof id === 'string'),
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
			// importData updates the data model but doesn't repaint on its own.
			try { void canvas.requestFrame() } catch (err) { console.debug('Bragi import: frame refresh skipped', err) }

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
		new Notice(`Import failed: ${errorMessage(err)}`)
		console.error('Bragi import error:', err)
	}
}

// ── Helpers ────────────────────────────────────────────────────────

function getCanvasFilePath(app: App): string | null {
	const leaf = app.workspace.getLeaf(false)
	const filePath = (leaf?.view as CanvasView)?.file?.path
	return filePath || null
}

function collectFileRefs(data: CanvasData): string[] {
	const refs = new Set<string>()
	for (const node of (data.nodes || [])) {
		if (node.type === 'file' && typeof node.file === 'string') {
			refs.add(node.file)
		}
		if (node.type === 'group' && typeof node.background === 'string') {
			refs.add(node.background)
		}
	}
	return [...refs]
}

function rewritePaths(data: CanvasData, pathMap: Map<string, string>): void {
	for (const node of (data.nodes || [])) {
		if (node.type === 'file' && typeof node.file === 'string' && pathMap.has(node.file)) {
			node.file = pathMap.get(node.file)
		}
		if (node.type === 'group' && typeof node.background === 'string' && pathMap.has(node.background)) {
			node.background = pathMap.get(node.background)
		}
	}
}

function rewritePathsForImport(data: CanvasData, pathMap: Map<string, string>): void {
	for (const node of (data.nodes || [])) {
		if (node.type === 'file' && typeof node.file === 'string' && pathMap.has(node.file)) {
			node.file = pathMap.get(node.file)
		}
		if (node.type === 'group' && typeof node.background === 'string' && pathMap.has(node.background)) {
			node.background = pathMap.get(node.background)
		}
	}
}

function regenerateIds(data: CanvasData, existingIds: Set<string>): void {
	const idMap = new Map<string, string>()
	const usedIds = new Set(existingIds)

	for (const node of (data.nodes || [])) {
		let newId: string
		do { newId = generateId() } while (usedIds.has(newId))
		if (typeof node.id === 'string') idMap.set(node.id, newId)
		usedIds.add(newId)
		node.id = newId
	}

	for (const edge of (data.edges || [])) {
		let newId: string
		do { newId = generateId() } while (usedIds.has(newId))
		usedIds.add(newId)
		edge.id = newId
		if (typeof edge.fromNode === 'string' && idMap.has(edge.fromNode)) edge.fromNode = idMap.get(edge.fromNode)
		if (typeof edge.toNode === 'string' && idMap.has(edge.toNode)) edge.toNode = idMap.get(edge.toNode)
	}
}

function calculateMergeOffset(
	existingNodes: Record<string, unknown>[],
	importedNodes: Record<string, unknown>[]
): { dx: number; dy: number } {
	if (existingNodes.length === 0 || importedNodes.length === 0) {
		return { dx: 0, dy: 0 }
	}

	const existingRight = Math.max(...existingNodes.map((n) => (typeof n.x === 'number' ? n.x : 0) + (typeof n.width === 'number' ? n.width : 0)))
	const existingTop = Math.min(...existingNodes.map((n) => (typeof n.y === 'number' ? n.y : 0)))

	const importedLeft = Math.min(...importedNodes.map((n) => (typeof n.x === 'number' ? n.x : 0)))
	const importedTop = Math.min(...importedNodes.map((n) => (typeof n.y === 'number' ? n.y : 0)))

	return {
		dx: existingRight + 200 - importedLeft,
		dy: existingTop - importedTop,
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Resume strict linting after the runtime-shaped data boundary. */

import { errorMessage } from './task-errors'
/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import { App, Modal, Notice, TFile, TFolder } from 'obsidian'
import type BragiCanvas from './main'

const NEW_ASSETS_DIR = '_bragi/assets'
const BACKUP_DIR_BASE = '_bragi/backup'

type FileView = { file?: { path?: string; basename?: string } }

function parentDir(path: string): string {
	const index = path.lastIndexOf('/')
	return index >= 0 ? path.slice(0, index) : ''
}

function basename(path: string): string {
	const name = path.split('/').pop() || path
	return name.endsWith('.canvas') ? name.slice(0, -7) : name
}

function activeCanvasPath(app: App): string | null {
	const view = app.workspace.getLeaf(false)?.view as unknown as FileView | undefined
	const path = view?.file?.path
	return typeof path === 'string' && path.endsWith('.canvas') ? path : null
}

/** Find legacy asset folders near the active canvas without enumerating the vault. */
function findLegacyAssetFolders(app: App, canvasPath: string, legacyName: string): TFolder[] {
	const candidates = new Set<string>()
	const dir = parentDir(canvasPath)
	if (dir) candidates.add(`${dir}/${legacyName}`)
	else candidates.add(legacyName)
	candidates.add(legacyName)

	const result: TFolder[] = []
	for (const path of candidates) {
		if (path === NEW_ASSETS_DIR) continue
		const folder = app.vault.getAbstractFileByPath(path)
		if (folder instanceof TFolder) result.push(folder)
	}
	return result
}

function collectCanvasReferencedPaths(canvasText: string): Set<string> {
	const referenced = new Set<string>()
	const data = JSON.parse(canvasText)
	for (const node of (data.nodes || [])) {
		if (typeof node.file === 'string') referenced.add(node.file)
		if (typeof node.background === 'string') referenced.add(node.background)
	}
	return referenced
}

function isInFolder(path: string, folder: TFolder): boolean {
	return path.startsWith(`${folder.path}/`)
}

function activeCanvasLegacyPaths(app: App, canvasText: string, folders: TFolder[]): string[] {
	const referenced = collectCanvasReferencedPaths(canvasText)
	const seen = new Set<string>()
	const result: string[] = []
	for (const path of referenced) {
		if (path.startsWith(`${NEW_ASSETS_DIR}/`)) continue
		if (!folders.some(folder => isInFolder(path, folder))) continue
		if (!(app.vault.getAbstractFileByPath(path) instanceof TFile)) continue
		if (seen.has(path)) continue
		seen.add(path)
		result.push(path)
	}
	return result
}

export async function checkMigration(plugin: BragiCanvas): Promise<void> {
	if (plugin.settings.migrationPrompted) return
	const canvasPath = activeCanvasPath(plugin.app)
	if (!canvasPath) return
	const legacyName = plugin.settings.outputDir || 'assets'
	const folders = findLegacyAssetFolders(plugin.app, canvasPath, legacyName)
	if (folders.length === 0) return
	const canvasFile = plugin.app.vault.getAbstractFileByPath(canvasPath)
	if (!(canvasFile instanceof TFile)) return
	const canvasText = await plugin.app.vault.read(canvasFile)
	const legacyPaths = activeCanvasLegacyPaths(plugin.app, canvasText, folders)
	if (legacyPaths.length === 0) return
	new AssetsMigrationModal(plugin, folders, canvasPath, legacyPaths).open()
}

class AssetsMigrationModal extends Modal {
	constructor(
		private plugin: BragiCanvas,
		private folders: TFolder[],
		private canvasPath: string,
		private legacyPaths: string[],
	) {
		super(plugin.app)
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this
		modalEl.classList.add('bragi-modal')
		titleEl.setText('Tidy up generated files')

		const totalFiles = this.legacyPaths.length
		contentEl.createEl('p', {
			text: `Bragi Canvas used to scatter generated images and videos next to each canvas. The active canvas references ${totalFiles} old file${totalFiles === 1 ? '' : 's'} in ${this.folders.length} nearby folder${this.folders.length === 1 ? '' : 's'}.`,
		})
		contentEl.createEl('p', {
			text: `We can copy them into a single folder so your vault stays clean. Your canvases will keep working — references in this canvas are updated, the original files remain available to other notes, and a backup is saved first.`,
		})

		const details = contentEl.createEl('details')
		details.createEl('summary', { text: 'Show affected folders' })
		const ul = details.createEl('ul')
		for (const f of this.folders.slice(0, 50)) {
			ul.createEl('li', { text: f.path })
		}
		if (this.folders.length > 50) {
			ul.createEl('li', { text: `… and ${this.folders.length - 50} more` })
		}

		const row = contentEl.createDiv({ cls: 'modal-button-container' })
		const later = row.createEl('button', { text: 'Not now' })
		later.addEventListener('click', () => this.close())

		const dontAsk = row.createEl('button', { text: "Keep them where they are" })
		dontAsk.addEventListener('click', () => {
			void (async () => {
				this.plugin.settings.migrationPrompted = true
				await this.plugin.saveSettings()
				this.close()
			})()
		})

		const migrate = row.createEl('button', { text: 'Tidy up', cls: 'mod-cta' })
		migrate.addEventListener('click', () => {
			void (async () => {
				migrate.disabled = true
				later.disabled = true
				dontAsk.disabled = true
				migrate.setText('Working…')
				try {
					await performMigration(this.plugin, this.folders, this.canvasPath, this.legacyPaths)
					this.plugin.settings.migrationPrompted = true
					await this.plugin.saveSettings()
					this.close()
				} catch (err: unknown) {
					new Notice(`Tidy up failed: ${errorMessage(err)}`)
					migrate.disabled = false
					later.disabled = false
					dontAsk.disabled = false
					migrate.setText('Tidy up')
				}
			})()
		})
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

function withoutExt(name: string): string {
	const i = name.lastIndexOf('.')
	return i > 0 ? name.substring(0, i) : name
}

function ext(name: string): string {
	const i = name.lastIndexOf('.')
	return i > 0 ? name.substring(i) : ''
}

export async function performMigration(plugin: BragiCanvas, _folders: TFolder[], canvasPath: string, legacyPaths: string[]): Promise<void> {
	const app = plugin.app
	const adapter = app.vault.adapter
	const notice = new Notice('Tidying up…', 0)
	const canvasFile = app.vault.getAbstractFileByPath(canvasPath)

	try {
		if (!(canvasFile instanceof TFile)) throw new Error('Active canvas file not found')

		// 1. Ensure target dirs exist
		if (!await adapter.exists('_bragi')) await adapter.mkdir('_bragi')
		if (!await adapter.exists(NEW_ASSETS_DIR)) await adapter.mkdir(NEW_ASSETS_DIR)

		// 2. Backup the active .canvas file
		const ts = new Date().toISOString().replace(/[:.]/g, '-')
		const backupDir = `${BACKUP_DIR_BASE}/${ts}`
		if (!await adapter.exists(BACKUP_DIR_BASE)) await adapter.mkdir(BACKUP_DIR_BASE)
		await adapter.mkdir(backupDir)

		const originalCanvasText = await app.vault.read(canvasFile)
		await adapter.write(`${backupDir}/${canvasPath.replace(/\//g, '__')}`, originalCanvasText)
		notice.setMessage(`Backed up ${basename(canvasPath)}…`)

		// 3. Copy files: oldPath → NEW_ASSETS_DIR/<name>, collision-safe. Build remap.
		const pathRemap = new Map<string, string>()  // oldVaultPath → newVaultPath
		let copied = 0
		let failed = 0
		const usedNames = new Set<string>()
		// Seed usedNames with existing files in _bragi/assets
		try {
			const existing = await adapter.list(NEW_ASSETS_DIR)
			for (const p of existing.files) usedNames.add(p.split('/').pop()!)
		} catch {
			// Existing asset dir may not be listable; continue with an empty seed.
		}

		for (const oldPath of legacyPaths) {
			const name = oldPath.split('/').pop()!
			let targetName = name
			if (usedNames.has(targetName) || await adapter.exists(`${NEW_ASSETS_DIR}/${targetName}`)) {
				const base = withoutExt(name)
				const e = ext(name)
				let i = 2
				while (usedNames.has(`${base}_${i}${e}`) || await adapter.exists(`${NEW_ASSETS_DIR}/${base}_${i}${e}`)) i++
				targetName = `${base}_${i}${e}`
			}
			usedNames.add(targetName)
			const newPath = `${NEW_ASSETS_DIR}/${targetName}`
			try {
				const bin = await adapter.readBinary(oldPath)
				await adapter.writeBinary(newPath, bin)
				// Preserve originals: other canvases and notes may still reference them.
				pathRemap.set(oldPath, newPath)
				plugin.rememberGeneratedAsset(newPath, canvasPath)
				copied++
			} catch (err: unknown) {
				failed++
				console.error(`Bragi: failed to migrate ${oldPath}:`, err)
			}
		}
		notice.setMessage(`Copied ${copied} file${copied === 1 ? '' : 's'}. Updating the active canvas…`)

		// 4. Rewrite active canvas JSON file references
		let rewroteCanvases = 0
		try {
			const data = JSON.parse(originalCanvasText)
			let changed = false
			for (const n of (data.nodes || [])) {
				if (n.file && pathRemap.has(n.file)) {
					n.file = pathRemap.get(n.file)!
					changed = true
				}
				if (n.background && pathRemap.has(n.background)) {
					n.background = pathRemap.get(n.background)!
					changed = true
				}
			}
			if (changed) {
				await app.vault.modify(canvasFile, JSON.stringify(data, null, '\t'))
				rewroteCanvases++
			}
		} catch (err: unknown) {
			throw new Error(`Files were copied, but the canvas could not be updated: ${err instanceof Error ? errorMessage(err) : String(err)}. Original files are unchanged.`)
		}


		if (failed) throw new Error(`Copied ${copied} files; ${failed} could not be copied. Successful references were updated. Original files are unchanged.`)
		notice.hide()
		new Notice(`Copied ${copied} file${copied === 1 ? '' : 's'} and updated ${rewroteCanvases} canvas. Originals and a canvas backup were preserved.`, 10000)
	} catch (err) {
		notice.hide()
		throw err
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

import { App, Modal, Notice, Plugin, TFolder } from 'obsidian'
import type BragiCanvas from './main'

const NEW_ASSETS_DIR = '_bragi/assets'
const BACKUP_DIR_BASE = '_bragi/backup'

/** Find legacy asset folders: any directory whose name matches settings.outputDir. */
function findLegacyAssetFolders(app: App, legacyName: string): TFolder[] {
	const result: TFolder[] = []
	const all = app.vault.getAllLoadedFiles()
	for (const f of all) {
		if ((f as any).children && f.name === legacyName && f.path !== NEW_ASSETS_DIR) {
			result.push(f as TFolder)
		}
	}
	return result
}

export async function checkMigration(plugin: BragiCanvas): Promise<void> {
	if (plugin.settings.migrationPrompted) return
	const legacyName = plugin.settings.outputDir || 'assets'
	const folders = findLegacyAssetFolders(plugin.app, legacyName)
	if (folders.length === 0) {
		plugin.settings.migrationPrompted = true
		await plugin.saveSettings()
		return
	}
	new AssetsMigrationModal(plugin, folders).open()
}

class AssetsMigrationModal extends Modal {
	constructor(private plugin: BragiCanvas, private folders: TFolder[]) {
		super(plugin.app)
	}

	onOpen(): void {
		const { contentEl, titleEl, modalEl } = this
		modalEl.classList.add('bragi-modal')
		titleEl.setText('Tidy up generated files')

		const totalFiles = this.folders.reduce((n, f) => n + countFiles(f), 0)
		contentEl.createEl('p', {
			text: `Bragi Canvas used to scatter generated images and videos next to each canvas. You have ${totalFiles} file${totalFiles === 1 ? '' : 's'} in ${this.folders.length} old folder${this.folders.length === 1 ? '' : 's'}.`,
		})
		contentEl.createEl('p', {
			text: `We can move them into a single hidden folder so your vault stays clean. Your canvases will keep working — references are updated automatically, and a backup is saved first.`,
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
		dontAsk.addEventListener('click', async () => {
			this.plugin.settings.migrationPrompted = true
			await this.plugin.saveSettings()
			this.close()
		})

		const migrate = row.createEl('button', { text: 'Tidy up', cls: 'mod-cta' })
		migrate.addEventListener('click', async () => {
			migrate.disabled = true
			later.disabled = true
			dontAsk.disabled = true
			migrate.setText('Working…')
			try {
				await performMigration(this.plugin, this.folders)
				this.plugin.settings.migrationPrompted = true
				await this.plugin.saveSettings()
				this.close()
			} catch (err: any) {
				new Notice(`Tidy up failed: ${err.message || err}`)
				migrate.disabled = false
				later.disabled = false
				dontAsk.disabled = false
				migrate.setText('Tidy up')
			}
		})
	}

	onClose(): void {
		this.contentEl.empty()
	}
}

function countFiles(folder: TFolder): number {
	let n = 0
	for (const c of folder.children) {
		if ((c as any).children) n += countFiles(c as TFolder)
		else n++
	}
	return n
}

function collectFiles(folder: TFolder, out: string[]): void {
	for (const c of folder.children) {
		if ((c as any).children) collectFiles(c as TFolder, out)
		else out.push(c.path)
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

async function performMigration(plugin: BragiCanvas, folders: TFolder[]): Promise<void> {
	const app = plugin.app
	const adapter = app.vault.adapter
	const notice = new Notice('Tidying up…', 0)

	try {
		// 1. Ensure target dirs exist
		if (!await adapter.exists('_bragi')) await adapter.mkdir('_bragi')
		if (!await adapter.exists(NEW_ASSETS_DIR)) await adapter.mkdir(NEW_ASSETS_DIR)

		// 2. Backup all .canvas files
		const ts = new Date().toISOString().replace(/[:.]/g, '-')
		const backupDir = `${BACKUP_DIR_BASE}/${ts}`
		if (!await adapter.exists(BACKUP_DIR_BASE)) await adapter.mkdir(BACKUP_DIR_BASE)
		await adapter.mkdir(backupDir)

		const canvases = app.vault.getFiles().filter(f => f.extension === 'canvas')
		for (const cv of canvases) {
			const content = await app.vault.read(cv)
			const safeName = cv.path.replace(/\//g, '__')
			await adapter.write(`${backupDir}/${safeName}`, content)
		}
		notice.setMessage(`Backed up ${canvases.length} canvas${canvases.length === 1 ? '' : 'es'}…`)

		// 3. Move files: oldPath → NEW_ASSETS_DIR/<name>, collision-safe. Build remap.
		const pathRemap = new Map<string, string>()  // oldVaultPath → newVaultPath
		let moved = 0
		const usedNames = new Set<string>()
		// Seed usedNames with existing files in _bragi/assets
		try {
			const existing = await adapter.list(NEW_ASSETS_DIR)
			for (const p of existing.files) usedNames.add(p.split('/').pop()!)
		} catch {}

		for (const folder of folders) {
			const files: string[] = []
			collectFiles(folder, files)
			for (const oldPath of files) {
				const name = oldPath.split('/').pop()!
				let targetName = name
				if (usedNames.has(targetName)) {
					const base = withoutExt(name)
					const e = ext(name)
					let i = 2
					while (usedNames.has(`${base}_${i}${e}`)) i++
					targetName = `${base}_${i}${e}`
				}
				usedNames.add(targetName)
				const newPath = `${NEW_ASSETS_DIR}/${targetName}`
				try {
					const bin = await adapter.readBinary(oldPath)
					await adapter.writeBinary(newPath, bin)
					await adapter.remove(oldPath)
					pathRemap.set(oldPath, newPath)
					moved++
				} catch (err: any) {
					console.error(`Bragi: failed to migrate ${oldPath}:`, err)
				}
			}
		}
		notice.setMessage(`Moved ${moved} file${moved === 1 ? '' : 's'}. Updating canvases…`)

		// 4. Rewrite canvas JSON file references
		let rewroteCanvases = 0
		for (const cv of canvases) {
			try {
				const text = await app.vault.read(cv)
				const data = JSON.parse(text)
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
					await app.vault.modify(cv, JSON.stringify(data, null, '\t'))
					rewroteCanvases++
				}
			} catch (err: any) {
				console.error(`Bragi: failed to rewrite ${cv.path}:`, err)
			}
		}

		// 5. Remove now-empty legacy folders
		let removedFolders = 0
		for (const folder of folders) {
			try {
				const entries = await adapter.list(folder.path)
				if (entries.files.length === 0 && entries.folders.length === 0) {
					await adapter.rmdir(folder.path, false)
					removedFolders++
				}
			} catch { /* leave it */ }
		}

		notice.hide()
		new Notice(`All tidied up — moved ${moved} file${moved === 1 ? '' : 's'}, updated ${rewroteCanvases} canvas${rewroteCanvases === 1 ? '' : 'es'}. A backup was saved in case anything needs fixing.`, 10000)
	} catch (err) {
		notice.hide()
		throw err
	}
}

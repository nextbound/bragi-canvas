import type { App } from 'obsidian'

/**
 * When a canvas view is active, redirect Obsidian's "attachment" save path to
 * `_bragi/assets/` so pasted/dropped files land there instead of the vault root.
 *
 * Strategy: watch `active-leaf-change`. On entering a canvas leaf, save the user's
 * current `attachmentFolderPath` (if we haven't already) and set it to our dir.
 * On leaving canvas leaves, restore the saved value.
 */

const OUR_DIR = '_bragi/assets'

let savedFolderPath: string | null = null  // the user's original setting
let currentlyRedirected = false

export function startAttachmentRedirect(app: App): () => void {
	const isCanvasLeaf = () => {
		const leaf = app.workspace.activeLeaf
		return (leaf?.view as any)?.getViewType?.() === 'canvas'
	}

	const apply = () => {
		const onCanvas = isCanvasLeaf()
		const vaultConfig = (app.vault as any)
		const currentPath = vaultConfig.getConfig?.('attachmentFolderPath') ?? ''

		if (onCanvas && !currentlyRedirected) {
			if (currentPath !== OUR_DIR) {
				savedFolderPath = currentPath
				vaultConfig.setConfig?.('attachmentFolderPath', OUR_DIR)
			}
			currentlyRedirected = true
		} else if (!onCanvas && currentlyRedirected) {
			if (savedFolderPath !== null) {
				vaultConfig.setConfig?.('attachmentFolderPath', savedFolderPath)
			}
			savedFolderPath = null
			currentlyRedirected = false
		}
	}

	const handler = () => apply()
	app.workspace.on('active-leaf-change', handler)
	// Also run once on install (in case a canvas is already active)
	apply()

	// Cleanup: restore + unsubscribe
	return () => {
		app.workspace.off('active-leaf-change', handler)
		if (currentlyRedirected && savedFolderPath !== null) {
			(app.vault as any).setConfig?.('attachmentFolderPath', savedFolderPath)
		}
		savedFolderPath = null
		currentlyRedirected = false
	}
}

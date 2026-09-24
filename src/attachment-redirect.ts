/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
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
		const leaf = app.workspace.getLeaf(false)
		return leaf?.view.getViewType?.() === 'canvas'
	}

	const apply = () => {
		const onCanvas = isCanvasLeaf()
		const vaultConfig = app.vault
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
			app.vault.setConfig?.('attachmentFolderPath', savedFolderPath)
		}
		savedFolderPath = null
		currentlyRedirected = false
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- Resume strict linting after the runtime-shaped data boundary. */

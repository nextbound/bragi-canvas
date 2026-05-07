import { Workspace, WorkspaceLeaf, TFile, App } from 'obsidian'
import { around } from 'monkey-around'

/**
 * Force all file-open actions to land in a new tab instead of replacing the
 * current one — with deduplication so an already-open file focuses its
 * existing tab instead of spawning a duplicate.
 *
 * Critical for Bragi because in-flight generation placeholders disappear the
 * moment a canvas is swapped out of the active leaf.
 *
 * Distilled from obsidian-open-tab-settings (MIT, Jesse Hines):
 *   https://github.com/jesse-r-s-hines/obsidian-open-tab-settings
 * We keep two patches:
 *   1. Workspace.getLeaf / getUnpinnedLeaf → default openMode to 'tab'
 *   2. WorkspaceLeaf.openFile            → if file is already open elsewhere,
 *                                           redirect openFile onto that leaf
 *                                           and detach the just-created empty one
 *
 * Returns the uninstaller; register it with `this.register(...)`.
 */
export function installAlwaysNewTab(app: App): () => void {
	const uninstallers: Array<() => void> = []

	uninstallers.push(around(Workspace.prototype, {
		getLeaf(oldMethod: unknown) {
			return function (this: Workspace, openMode?: unknown, ...args: unknown[]) {
				if (openMode == null || openMode === false) {
					return oldMethod.call(this, 'tab', ...args)
				}
				return oldMethod.call(this, openMode, ...args)
			}
		},
		getUnpinnedLeaf(oldMethod: unknown) {
			return function (this: Workspace, ...args: unknown[]) {
				return (this as unknown).getLeaf('tab')
			}
		},
	}))

	uninstallers.push(around(WorkspaceLeaf.prototype, {
		openFile(oldMethod: unknown) {
			return async function (this: WorkspaceLeaf, file: TFile, openState?: unknown, ...args: unknown[]) {
				// Find other main-area leaves already showing this file. Split panes, popouts,
				// sidebars, and different view types (outgoing-links, etc.) are skipped.
				const match = findExistingLeaf(app, this, file)
				if (!match) {
					return oldMethod.call(this, file, openState, ...args)
				}

				// Point openFile at the existing leaf, then drop the just-created blank one.
				const shouldActivate = openState?.active !== false
				const wasEmpty = isEmptyLeaf(this) && this !== match
				const result = await oldMethod.call(match, file, { ...openState, active: shouldActivate }, ...args)
				if (wasEmpty) {
					try { this.detach() } catch { /* noop */ }
				}
				return result
			}
		},
	}))

	return () => { for (const un of uninstallers) un() }
}

function findExistingLeaf(app: App, currentLeaf: WorkspaceLeaf, file: TFile): WorkspaceLeaf | null {
	const expectedViewType = (app as unknown).viewRegistry?.getTypeByExtension?.(file.extension)
	let found: WorkspaceLeaf | null = null
	app.workspace.iterateAllLeaves((leaf) => {
		if (found) return
		if (leaf === currentLeaf) return
		if (!isMainLeaf(leaf)) return
		const state = leaf.getViewState?.()
		if (state?.state?.file !== file.path) return
		const viewType = leaf.view?.getViewType?.()
		if (expectedViewType && viewType !== expectedViewType) return
		found = leaf
	})
	return found
}

function isMainLeaf(leaf: WorkspaceLeaf): boolean {
	const root = leaf.getRoot?.()
	const workspace = (leaf as unknown).app?.workspace
	// Main area = rootSplit (not sidebars, not popouts)
	return !!root && !!workspace && root === workspace.rootSplit
}

function isEmptyLeaf(leaf: WorkspaceLeaf): boolean {
	const viewType = leaf.view?.getViewType?.()
	return viewType === 'empty'
}

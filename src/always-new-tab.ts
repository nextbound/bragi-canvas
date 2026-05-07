import { WorkspaceLeaf, TFile, App } from 'obsidian'
import { around } from 'monkey-around'

/**
 * Protect active canvas views from being replaced when Obsidian opens another
 * file into the current leaf. Already-open files still focus their existing tab
 * instead of spawning a duplicate.
 *
 * Critical for Bragi because in-flight generation placeholders disappear the
 * moment a canvas is swapped out of the active leaf.
 *
 * Distilled from obsidian-open-tab-settings (MIT, Jesse Hines):
 *   https://github.com/jesse-r-s-hines/obsidian-open-tab-settings
 * We patch WorkspaceLeaf.openFile only. Patching Workspace.getLeaf globally is
 * too broad because Obsidian and this plugin also use getLeaf(false) as a read
 * of the active leaf; rewriting that path creates empty tabs.
 *
 * Returns the uninstaller; register it with `this.register(...)`.
 */
export function installAlwaysNewTab(app: App): () => void {
	const uninstallers: Array<() => void> = []

	uninstallers.push(around(WorkspaceLeaf.prototype, {
		openFile(oldMethod: unknown) {
			return async function (this: WorkspaceLeaf, file: TFile, openState?: unknown, ...args: unknown[]) {
				const openFile = oldMethod as OpenFileMethod

				// Find other main-area leaves already showing this file. Split panes, popouts,
				// sidebars, and different view types (outgoing-links, etc.) are skipped.
				const match = findExistingLeaf(app, this, file)
				if (match) {
					// Point openFile at the existing leaf, then drop the just-created blank one.
					const shouldActivate = readOpenState(openState).active !== false
					const wasEmpty = isEmptyLeaf(this) && this !== match
					const result = await openFile.call(match, file, { ...readOpenState(openState), active: shouldActivate }, ...args)
					if (wasEmpty) {
						try { this.detach() } catch { /* noop */ }
					}
					return result
				}

				if (isMainLeaf(this) && isCanvasLeaf(this) && getLeafFilePath(this) !== file.path) {
					const target = app.workspace.getLeaf('tab')
					return openFile.call(target, file, openState, ...args)
				}

				return openFile.call(this, file, openState, ...args)
			}
		},
	}))

	return () => { for (const un of uninstallers) un() }
}

type OpenState = { active?: boolean; [key: string]: unknown }
type OpenFileMethod = (this: WorkspaceLeaf, file: TFile, openState?: unknown, ...args: unknown[]) => Promise<unknown>

function readOpenState(openState: unknown): OpenState {
	if (openState && typeof openState === 'object') return openState as OpenState
	return {}
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

function isCanvasLeaf(leaf: WorkspaceLeaf): boolean {
	return leaf.view?.getViewType?.() === 'canvas'
}

function getLeafFilePath(leaf: WorkspaceLeaf): string | undefined {
	const statePath = leaf.getViewState?.().state?.file
	if (typeof statePath === 'string') return statePath
	const viewFilePath = (leaf.view as unknown)?.file?.path
	return typeof viewFilePath === 'string' ? viewFilePath : undefined
}

function isEmptyLeaf(leaf: WorkspaceLeaf): boolean {
	const viewType = leaf.view?.getViewType?.()
	return viewType === 'empty'
}

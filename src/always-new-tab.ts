import { Workspace } from 'obsidian'
import { around } from 'monkey-around'

/**
 * Force all file-open actions to land in a new tab instead of replacing the
 * current one. Critical for Bragi because in-flight generation placeholders
 * disappear the moment a canvas is swapped out of the active leaf.
 *
 * Distilled from obsidian-open-tab-settings (MIT, Jesse Hines):
 *   https://github.com/jesse-r-s-hines/obsidian-open-tab-settings
 * Only the two Workspace.prototype patches — we don't need dedup, placement, or settings.
 *
 * Returns the uninstaller; register it with `this.register(...)`.
 */
export function installAlwaysNewTab(): () => void {
	return around(Workspace.prototype, {
		getLeaf(oldMethod: any) {
			return function (this: Workspace, openMode?: any, ...args: any[]) {
				// If caller explicitly asked for something (tab / split / window), respect it.
				// If caller passed nothing (or `false` meaning "default"), force new tab.
				if (openMode == null || openMode === false) {
					return oldMethod.call(this, 'tab', ...args)
				}
				return oldMethod.call(this, openMode, ...args)
			}
		},
		// Deprecated but still called by Obsidian internals + older plugins.
		getUnpinnedLeaf(oldMethod: any) {
			return function (this: Workspace, ...args: any[]) {
				return (this as any).getLeaf('tab')
			}
		},
	})
}

/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian Canvas menu internals are runtime-shaped data narrowed at use sites. */
import { around } from 'monkey-around'
import type { Canvas, CanvasNode } from './types/canvas-internal'

let contextMenuUninstaller: (() => void) | null = null

function isBragiPlaceholderNode(node: CanvasNode): boolean {
	const d = node.getData() as {
		bragiGenerating?: boolean
		bragiGenerationFailed?: boolean
		ovidGenerating?: boolean
	}
	return (
		d.bragiGenerating === true ||
		d.bragiGenerationFailed === true ||
		d.ovidGenerating === true
	)
}

function shouldHideContextMenuItem(label: string): boolean {
	const lower = label.toLowerCase().trim()
	if (lower === 'edit') return true
	if (lower.startsWith('convert to file')) return true
	return false
}

function hidePlaceholderContextMenuItems(): void {
	for (const menu of activeDocument.querySelectorAll('.menu')) {
		menu.querySelectorAll('.menu-item').forEach(item => {
			const title =
				item.querySelector('.menu-item-title')?.textContent?.trim() ||
				item.textContent?.trim() ||
				''
			if (shouldHideContextMenuItem(title)) {
				item.classList.add('bragi-hidden')
			}
		})
	}
}

function scheduleHidePlaceholderContextMenuItems(): void {
	window.requestAnimationFrame(hidePlaceholderContextMenuItems)
	window.setTimeout(hidePlaceholderContextMenuItems, 0)
}

/** Hide Edit / Convert to file on generating + failed placeholder right-click menus. */
export function patchPlaceholderContextMenu(canvas: Canvas): void {
	if (contextMenuUninstaller) return

	const sample = canvas.nodes.values().next().value as CanvasNode | undefined
	if (!sample) return

	const proto = Object.getPrototypeOf(sample) as { showMenu?: (...args: unknown[]) => unknown }
	if (!proto?.showMenu) return

	contextMenuUninstaller = around(proto, {
		showMenu(next) {
			return function (this: CanvasNode, ...args: unknown[]) {
				const result = next.call(this, ...args)
				if (isBragiPlaceholderNode(this)) {
					scheduleHidePlaceholderContextMenuItems()
				}
				return result
			}
		},
	})
}

export function unpatchPlaceholderContextMenu(): void {
	if (contextMenuUninstaller) {
		contextMenuUninstaller()
		contextMenuUninstaller = null
	}
}

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Resume strict linting after the runtime-shaped data boundary. */

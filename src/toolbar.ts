import { setIcon, setTooltip, Notice, App, Modal } from 'obsidian'
import { around } from 'monkey-around'
import type { Canvas, CanvasNode } from './types/canvas-internal'

/**
 * Download a media file from the vault to the user's local filesystem.
 * Uses Electron's native save dialog.
 */
async function downloadMediaFile(vaultPath: string, node: CanvasNode): Promise<void> {
	try {
		const app = node.app
		const adapter = app.vault.adapter
		const fileName = vaultPath.split('/').pop() || 'download'
		const ext = fileName.split('.').pop() || ''

		// Read file from vault
		const data = await adapter.readBinary(vaultPath)

		// Use Electron's dialog to save
		const { remote } = require('electron')
		const result = await remote.dialog.showSaveDialog({
			defaultPath: fileName,
			filters: [
				{ name: ext.toUpperCase(), extensions: [ext] },
				{ name: 'All Files', extensions: ['*'] },
			],
		})

		if (result.canceled || !result.filePath) return

		// Write using Node.js fs
		const fs = require('fs')
		fs.writeFileSync(result.filePath, Buffer.from(data))
		new Notice(`Saved: ${result.filePath.split('/').pop()}`)
	} catch (err: any) {
		// Fallback: create a download link
		try {
			const app = node.app
			const resourcePath = app.vault.adapter.getResourcePath(vaultPath)
			const a = document.createElement('a')
			a.href = resourcePath
			a.download = vaultPath.split('/').pop() || 'download'
			document.body.appendChild(a)
			a.click()
			document.body.removeChild(a)
			new Notice('Download started')
		} catch {
			new Notice(`Download failed: ${err.message}`)
		}
	}
}

let menuUninstaller: (() => void) | null = null

/** Map from Obsidian's built-in icon tooltip keywords to our custom icon names */
const ICON_REPLACEMENTS: Record<string, string> = {
	'remove': 'bragi-delete',
	'delete': 'bragi-delete',
	'trash': 'bragi-delete',
	'color': 'bragi-color',
	'colour': 'bragi-color',
	'zoom': 'bragi-focus',
	'focus': 'bragi-focus',
	'fit': 'bragi-focus',
	'edit': 'bragi-edit',
	'bragi-edit': 'bragi-edit',
	'group': 'bragi-group',
	'align': 'bragi-align',
}

/**
 * Replace Obsidian's built-in canvas menu icons with Bragi custom icons.
 * Matches by aria-label / tooltip text (case-insensitive keyword matching).
 */
/**
 * Find the built-in menu button whose aria-label contains the given keyword (case-insensitive).
 * Excludes Bragi-injected buttons.
 */
function findBuiltinByLabel(menuEl: HTMLElement, keyword: string): HTMLElement | null {
	const btns = menuEl.querySelectorAll('.clickable-icon')
	const kw = keyword.toLowerCase()
	for (const el of Array.from(btns)) {
		const cls = el.className
		if (cls.includes('bragi-')) continue
		const label = (el.getAttribute('aria-label') || '').toLowerCase()
		if (label.includes(kw)) return el as HTMLElement
	}
	return null
}

/** Open the built-in align/arrange submenu and click "Arrange in a grid". */
function triggerArrangeInGrid(alignBtn: HTMLElement): void {
	alignBtn.click()
	// Submenu renders asynchronously; wait a frame then find the item.
	requestAnimationFrame(() => {
		const items = document.querySelectorAll('.menu-item, .menu .menu-item, [role="menuitem"]')
		for (const el of Array.from(items)) {
			const text = (el.textContent || '').toLowerCase()
			if (text.includes('grid')) {
				(el as HTMLElement).click()
				return
			}
		}
	})
}

function replaceBuiltinIcons(menuEl: HTMLElement): void {
	const icons = menuEl.querySelectorAll('.clickable-icon:not(.bragi-gen-image):not(.bragi-gen-video):not(.bragi-gen-text)')
	icons.forEach((el) => {
		const label = (el.getAttribute('aria-label') || '').toLowerCase()
		for (const [keyword, iconName] of Object.entries(ICON_REPLACEMENTS)) {
			if (label.includes(keyword)) {
				setIcon(el as HTMLElement, iconName)
				break
			}
		}
	})
}

// ── Native align menu hover control ────────────────────────────────────
let nativeAlignCloseTimer: ReturnType<typeof setTimeout> | null = null

function cancelNativeAlignClose(): void {
	if (nativeAlignCloseTimer) {
		clearTimeout(nativeAlignCloseTimer)
		nativeAlignCloseTimer = null
	}
}

function scheduleNativeAlignClose(): void {
	cancelNativeAlignClose()
	nativeAlignCloseTimer = setTimeout(() => closeNativeAlignMenu(), 150)
}

function getOpenAlignMenu(): HTMLElement | null {
	const menus = document.querySelectorAll('.menu')
	for (const el of Array.from(menus)) {
		if (el.querySelector('.menu-scroll')) return el as HTMLElement
	}
	return null
}

function closeNativeAlignMenu(): void {
	cancelNativeAlignClose()
	const existing = getOpenAlignMenu()
	if (existing) existing.remove()
}

function openNativeAlignMenu(alignBtn: HTMLElement): void {
	cancelNativeAlignClose()
	// Already open?
	if (getOpenAlignMenu()) return
	alignBtn.click()
	// Attach hover handlers once the native menu renders
	requestAnimationFrame(() => {
		const m = getOpenAlignMenu()
		if (!m) return
		m.addEventListener('mouseenter', cancelNativeAlignClose)
		m.addEventListener('mouseleave', scheduleNativeAlignClose)
	})
}

let bragiDropdownCloseTimer: ReturnType<typeof setTimeout> | null = null

function cancelBragiDropdownClose(): void {
	if (bragiDropdownCloseTimer) {
		clearTimeout(bragiDropdownCloseTimer)
		bragiDropdownCloseTimer = null
	}
}

function scheduleBragiDropdownClose(): void {
	cancelBragiDropdownClose()
	bragiDropdownCloseTimer = setTimeout(() => {
		closeBragiDropdown()
	}, 150)
}

/** Close any open Bragi dropdown. */
function closeBragiDropdown(): void {
	cancelBragiDropdownClose()
	document.querySelectorAll('.bragi-more-dropdown').forEach((el) => el.remove())
}

/** Render a hover-triggered dropdown anchored directly below the ellipsis button. */
function openBragiMoreDropdown(moreBtn: HTMLElement, menuEl: HTMLElement): void {
	cancelBragiDropdownClose()
	if (document.querySelector('.bragi-more-dropdown')) return

	const items = [
		{ label: 'Edit', icon: 'bragi-edit', btn: findBuiltinByLabel(menuEl, 'edit') },
		{ label: 'Set colour', icon: 'bragi-color', btn: findBuiltinByLabel(menuEl, 'colo') },
		{ label: 'Zoom to fit', icon: 'bragi-focus', btn: findBuiltinByLabel(menuEl, 'zoom') || findBuiltinByLabel(menuEl, 'focus') || findBuiltinByLabel(menuEl, 'fit') },
		{ label: 'Delete', icon: 'bragi-delete', btn: findBuiltinByLabel(menuEl, 'delete') || findBuiltinByLabel(menuEl, 'remove') },
	].filter((x) => x.btn) as Array<{ label: string; icon: string; btn: HTMLElement }>

	const btnRect = moreBtn.getBoundingClientRect()
	const toolbarRect = menuEl.getBoundingClientRect()
	const dropdown = document.createElement('div')
	dropdown.className = 'bragi-more-dropdown'
	dropdown.style.left = `${btnRect.left}px`
	dropdown.style.top = `${toolbarRect.bottom - 1}px`

	for (const { label, icon, btn } of items) {
		const item = dropdown.createDiv({ cls: 'bragi-more-dropdown-item' })
		const iconEl = item.createDiv({ cls: 'bragi-more-dropdown-icon' })
		setIcon(iconEl, icon)
		item.createDiv({ cls: 'bragi-more-dropdown-label', text: label })
		item.addEventListener('click', (e) => {
			e.stopPropagation()
			const prev = btn.style.display
			btn.style.display = ''
			btn.click()
			btn.style.display = prev
			closeBragiDropdown()
		})
	}

	dropdown.addEventListener('mouseenter', cancelBragiDropdownClose)
	dropdown.addEventListener('mouseleave', scheduleBragiDropdownClose)

	document.body.appendChild(dropdown)
}

/**
 * Patch the canvas popup menu's render() method to inject Bragi Canvas buttons
 * and restyle the entire menu.
 * Uses the "double render" trick from obsidian-advanced-canvas.
 */
export function patchCanvasMenu(
	canvas: Canvas,
	onGenerateImage: (node: CanvasNode) => void,
	onGenerateVideo: (node: CanvasNode) => void,
	onGenerateText?: (node: CanvasNode) => void,
	onGenerateAudio?: (node: CanvasNode) => void,
	onSTT?: (node: CanvasNode) => void,
	onIsolateAudio?: (node: CanvasNode) => void,
	onDuplicate?: (node: CanvasNode) => void,
	onBatchGenerate?: (type: 'image' | 'video' | 'text' | 'audio', nodes: CanvasNode[]) => void,
	onPanorama?: (node: CanvasNode) => void,
	onGridSplit?: (node: CanvasNode) => void,
): void {
	if (menuUninstaller) return

	const menu = (canvas as any).menu
	if (!menu) return

	menuUninstaller = around(menu.constructor.prototype, {
		render: (next: any) => function (this: any, ...args: any) {
			const result = next.call(this, ...args)

			const menuEl = this.menuEl as HTMLElement
			if (!menuEl) return result

			// Always add class and replace built-in icons (each render resets them)
			menuEl.classList.add('bragi-canvas-menu')
			replaceBuiltinIcons(menuEl)

			const canvas = this.canvas as Canvas
			const selSize = canvas?.selection?.size || 0

			// ── More dropdown — collapse delete / color / focus / edit into ellipsis menu ──
			if (selSize >= 1) {
				const deleteBtn = findBuiltinByLabel(menuEl, 'delete') || findBuiltinByLabel(menuEl, 'remove')
				const colorBtn = findBuiltinByLabel(menuEl, 'colo')
				const focusBtn = findBuiltinByLabel(menuEl, 'zoom') || findBuiltinByLabel(menuEl, 'focus') || findBuiltinByLabel(menuEl, 'fit')
				const editBtn = findBuiltinByLabel(menuEl, 'edit')
				const collapsed: Array<{ label: string; icon: string; btn: HTMLElement }> = []
				if (editBtn) collapsed.push({ label: 'Edit', icon: 'bragi-edit', btn: editBtn })
				if (colorBtn) collapsed.push({ label: 'Set colour', icon: 'bragi-color', btn: colorBtn })
				if (focusBtn) collapsed.push({ label: 'Zoom to fit', icon: 'bragi-focus', btn: focusBtn })
				if (deleteBtn) collapsed.push({ label: 'Delete', icon: 'bragi-delete', btn: deleteBtn })

				// Re-hide every render (builtins may be recreated on selection change)
				for (const { btn } of collapsed) btn.style.display = 'none'

				if (collapsed.length > 0 && !menuEl.querySelector('.bragi-more')) {
					const moreBtn = document.createElement('div')
					moreBtn.className = 'clickable-icon bragi-more'
					setIcon(moreBtn, 'bragi-more')
					setTooltip(moreBtn, 'More', { placement: 'top' })

					const anchor = collapsed[0].btn
					anchor.parentElement?.insertBefore(moreBtn, anchor)

					moreBtn.addEventListener('mouseenter', () => openBragiMoreDropdown(moreBtn, menuEl))
					moreBtn.addEventListener('mouseleave', () => scheduleBragiDropdownClose())
					moreBtn.addEventListener('click', (e) => {
						e.stopPropagation()
						openBragiMoreDropdown(moreBtn, menuEl)
					})
				}
			}

			// ── Pin (quick purple color) — insert before color palette button ──
			if (selSize >= 1 && !menuEl.querySelector('.bragi-pin')) {
				const colorBtn = findBuiltinByLabel(menuEl, 'colo')
				if (colorBtn) {
					const pinBtn = document.createElement('div')
					pinBtn.className = 'clickable-icon bragi-pin'
					setIcon(pinBtn, 'bragi-pin')
					setTooltip(pinBtn, 'Mark', { placement: 'top' })
					pinBtn.addEventListener('click', (e) => {
						e.stopPropagation()
						const nodes = Array.from(canvas.selection) as CanvasNode[]
						for (const n of nodes) {
							const d = n.getData() as any
							n.setData({ ...d, color: d.color === '6' ? '' : '6' })
						}
						canvas.requestSave()
					})
					colorBtn.parentElement?.insertBefore(pinBtn, colorBtn)
				}
			}

			// ── 360° viewer — single image node, insert before Mark (Pin) ──
			if (selSize === 1 && onPanorama && !menuEl.querySelector('.bragi-pano')) {
				const only = Array.from(canvas.selection)[0] as CanvasNode
				const d = only?.getData() as any
				const isImage = d?.type === 'file' && /\.(png|jpe?g|webp)$/i.test(d.file || '')
				if (isImage) {
					const pinBtn = menuEl.querySelector('.bragi-pin') as HTMLElement | null
					const anchor = pinBtn || findBuiltinByLabel(menuEl, 'colo')
					if (anchor) {
						const panoBtn = document.createElement('div')
						panoBtn.className = 'clickable-icon bragi-pano'
						setIcon(panoBtn, 'bragi-360')
						setTooltip(panoBtn, '360° viewer', { placement: 'top' })
						panoBtn.addEventListener('click', (e) => {
							e.stopPropagation()
							onPanorama(only)
						})
						anchor.parentElement?.insertBefore(panoBtn, anchor)
					}
				}
			}

			// ── Split grid — single image node, leftmost (before 360) ──
			if (selSize === 1 && onGridSplit && !menuEl.querySelector('.bragi-split')) {
				const only = Array.from(canvas.selection)[0] as CanvasNode
				const d = only?.getData() as any
				const isImage = d?.type === 'file' && /\.(png|jpe?g|webp|gif)$/i.test(d.file || '')
				if (isImage) {
					const panoBtn = menuEl.querySelector('.bragi-pano') as HTMLElement | null
					const pinBtn = menuEl.querySelector('.bragi-pin') as HTMLElement | null
					const anchor = panoBtn || pinBtn || findBuiltinByLabel(menuEl, 'colo')
					if (anchor) {
						const splitBtn = document.createElement('div')
						splitBtn.className = 'clickable-icon bragi-split'
						setIcon(splitBtn, 'bragi-split')
						setTooltip(splitBtn, 'Split grid', { placement: 'top' })
						splitBtn.addEventListener('click', (e) => {
							e.stopPropagation()
							onGridSplit(only)
						})
						anchor.parentElement?.insertBefore(splitBtn, anchor)
					}
				}
			}

			// ── Align button: hover-to-open (native menu) ──
			if (selSize > 1) {
				const alignBtn = findBuiltinByLabel(menuEl, 'align') || findBuiltinByLabel(menuEl, 'arrange')
				if (alignBtn && !(alignBtn as any)._bragiHoverBound) {
					(alignBtn as any)._bragiHoverBound = true
					alignBtn.addEventListener('mouseenter', () => openNativeAlignMenu(alignBtn))
					alignBtn.addEventListener('mouseleave', scheduleNativeAlignClose)
				}
			}

// Only inject Bragi generation/action buttons once
			if (menuEl.querySelector('.bragi-gen-image') || menuEl.querySelector('.bragi-gen-text') || menuEl.querySelector('.bragi-gen-audio') || menuEl.querySelector('.bragi-stt') || menuEl.querySelector('.bragi-download') || menuEl.querySelector('.bragi-duplicate')) {
				return result
			}

			if (!canvas?.selection || selSize === 0) return result

			// ── Multi-select: batch generate buttons ──
			if (selSize > 1) {
				if (!onBatchGenerate) return result
				const allNodes = Array.from(canvas.selection) as CanvasNode[]
				const promptNodes = allNodes.filter(n => {
					const d = n.getData() as any
					return d.type === 'text' || (d.type === 'file' && /\.md$/i.test(d.file || ''))
				})
				if (promptNodes.length === 0) return result

				menuEl.createEl('div', { cls: 'canvas-menu-separator bragi-separator' })

				for (const [type, icon, label] of [
					['image', 'bragi-gen-image', 'Generate Image'],
					['video', 'bragi-gen-video', 'Generate Video'],
					['text', 'bragi-gen-text', 'Generate Text'],
					['audio', 'bragi-gen-audio', 'Generate Audio'],
				] as const) {
					const btn = menuEl.createEl('div', { cls: `clickable-icon bragi-gen-${type}` })
					setIcon(btn, icon)
					setTooltip(btn, `${label} (${promptNodes.length})`, { placement: 'top' })
					btn.addEventListener('click', (e) => {
						e.stopPropagation()
						onBatchGenerate(type, promptNodes)
					})
				}

				next.call(this)
				return result
			}

			const selectedNode = canvas.selection.values().next().value as CanvasNode
			const nodeData = selectedNode.getData()

			const isTextNode = nodeData.type === 'text'
			const isNoteNode = nodeData.type === 'file' && (nodeData as any).file?.endsWith('.md')
			const filePath = (nodeData as any).file || ''
			const isAudioNode = nodeData.type === 'file' && /\.(mp3|wav|flac|m4a|ogg|aac)$/i.test(filePath)
			const isMediaNode = nodeData.type === 'file' && /\.(png|jpg|jpeg|webp|gif|mp4|mov|webm|mp3|wav|flac|m4a|ogg|aac)$/i.test(filePath)
			const isImageNode = nodeData.type === 'file' && /\.(png|jpg|jpeg|webp|gif)$/i.test(filePath)
			const isGenerating = (nodeData as any).bragiGenerating === true || (nodeData as any).ovidGenerating === true

			// Generating node: hide all menu items except focus/zoom
			if (isGenerating) {
				const items = menuEl.querySelectorAll('.clickable-icon')
				items.forEach((el) => {
					const label = (el.getAttribute('aria-label') || '').toLowerCase()
					if (!label.includes('zoom') && !label.includes('focus') && !label.includes('fit')) {
						(el as HTMLElement).style.display = 'none'
					}
				})
				// Also hide separators
				menuEl.querySelectorAll('.canvas-menu-separator').forEach((el) => {
					(el as HTMLElement).style.display = 'none'
				})
				next.call(this)
				return result
			}

			if (!isTextNode && !isNoteNode && !isAudioNode && !isMediaNode) return result

			// Duplicate with connections — right after the built-in edit icon
			if (onDuplicate) {
				const edges = canvas.getEdgesForNode(selectedNode)
				const hasIncoming = edges?.some(e => e.to.node.id === selectedNode.id)
				if (hasIncoming) {
					const dupBtn = menuEl.createEl('div', { cls: 'clickable-icon bragi-duplicate' })
					setIcon(dupBtn, 'bragi-duplicate')
					setTooltip(dupBtn, 'Duplicate with Connections', { placement: 'top' })
					dupBtn.addEventListener('click', (e) => {
						e.stopPropagation()
						onDuplicate(selectedNode)
					})
				}
			}

			// Separator between duplicate/built-in icons and generation icons
			menuEl.createEl('div', { cls: 'canvas-menu-separator bragi-separator' })

			if (isTextNode || isNoteNode) {
				// Text/note node: image, video, text, audio
				const imgBtn = menuEl.createEl('div', { cls: 'clickable-icon bragi-gen-image' })
				setIcon(imgBtn, 'bragi-gen-image')
				setTooltip(imgBtn, 'Generate Image', { placement: 'top' })
				imgBtn.addEventListener('click', (e) => {
					e.stopPropagation()
					onGenerateImage(selectedNode)
				})

				const vidBtn = menuEl.createEl('div', { cls: 'clickable-icon bragi-gen-video' })
				setIcon(vidBtn, 'bragi-gen-video')
				setTooltip(vidBtn, 'Generate Video', { placement: 'top' })
				vidBtn.addEventListener('click', (e) => {
					e.stopPropagation()
					onGenerateVideo(selectedNode)
				})

				if (onGenerateText) {
					const txtBtn = menuEl.createEl('div', { cls: 'clickable-icon bragi-gen-text' })
					setIcon(txtBtn, 'bragi-gen-text')
					setTooltip(txtBtn, 'Generate Text', { placement: 'top' })
					txtBtn.addEventListener('click', (e) => {
						e.stopPropagation()
						onGenerateText(selectedNode)
					})
				}

				if (onGenerateAudio) {
					const audioBtn = menuEl.createEl('div', { cls: 'clickable-icon bragi-gen-audio' })
					setIcon(audioBtn, 'bragi-gen-audio')
					setTooltip(audioBtn, 'Generate Audio', { placement: 'top' })
					audioBtn.addEventListener('click', (e) => {
						e.stopPropagation()
						onGenerateAudio(selectedNode)
					})
				}
			}

			if (isAudioNode) {
				// Audio file node: STT, isolate
				if (onSTT) {
					const sttBtn = menuEl.createEl('div', { cls: 'clickable-icon bragi-stt' })
					setIcon(sttBtn, 'bragi-stt')
					setTooltip(sttBtn, 'Speech to Text', { placement: 'top' })
					sttBtn.addEventListener('click', (e) => {
						e.stopPropagation()
						onSTT(selectedNode)
					})
				}

				if (onIsolateAudio) {
					const isolateBtn = menuEl.createEl('div', { cls: 'clickable-icon bragi-isolate' })
					setIcon(isolateBtn, 'bragi-isolate')
					setTooltip(isolateBtn, 'Isolate Audio', { placement: 'top' })
					isolateBtn.addEventListener('click', (e) => {
						e.stopPropagation()
						onIsolateAudio(selectedNode)
					})
				}
			}

			// Download button for all media nodes (image, video, audio)
			if (isMediaNode) {
				const downloadBtn = menuEl.createEl('div', { cls: 'clickable-icon bragi-download' })
				setIcon(downloadBtn, 'bragi-download')
				setTooltip(downloadBtn, 'Download', { placement: 'top' })
				downloadBtn.addEventListener('click', (e) => {
					e.stopPropagation()
					downloadMediaFile(filePath, selectedNode)
				})
			}

			// Re-render to recalculate position with new width
			next.call(this)

			return result
		},
	})
}

/** Map from canvas control aria-label keywords to Bragi control icon names.
 *  Matches actual Obsidian aria-labels: "Canvas settings", "Zoom in",
 *  "Reset zoom", "Zoom to fit\n(⇧ 1)", "Zoom out", "Undo", "Redo", "Canvas help". */
const CANVAS_CTRL_REPLACEMENTS: [string, string][] = [
	['zoom in', 'bragi-ctrl-zoom-in'],
	['zoom out', 'bragi-ctrl-zoom-out'],
	['zoom to fit', 'bragi-ctrl-zoom-fit'],
	['reset zoom', 'bragi-ctrl-reset'],
	['undo', 'bragi-ctrl-undo'],
	['redo', 'bragi-ctrl-redo'],
	['canvas settings', 'bragi-ctrl-settings'],
	['canvas help', 'bragi-ctrl-help'],
]

/**
 * Replace Obsidian's built-in canvas control icons (right-side toolbar)
 * with Bragi custom icons.
 */
export function replaceCanvasControlIcons(containerEl: HTMLElement): void {
	const icons = containerEl.querySelectorAll('.canvas-controls .canvas-control-item')
	icons.forEach((el) => {
		const label = (el.getAttribute('aria-label') || '').toLowerCase()
		if (label.includes('canvas settings')) {
			const group = (el as HTMLElement).closest('.canvas-control-group') as HTMLElement | null
			if (group) group.style.display = 'none'
			else (el as HTMLElement).style.display = 'none'
			return
		}
		for (const [keyword, iconName] of CANVAS_CTRL_REPLACEMENTS) {
			if (label.includes(keyword)) {
				setIcon(el as HTMLElement, iconName)
				break
			}
		}
	})
}

/** Map from bottom card menu aria-label keywords to Bragi card icon names.
 *  Matches actual Obsidian aria-labels: "Drag to add card",
 *  "Drag to add note from vault", "Drag to add media from vault". */
const CANVAS_CARD_REPLACEMENTS: [string, string][] = [
	['add note', 'bragi-card-clipboard'],
	['add media', 'bragi-card-file'],
	['add card', 'bragi-card-text'],
]

/**
 * Replace Obsidian's built-in canvas card menu icons (bottom toolbar)
 * with Bragi custom icons, and append export / import / settings buttons.
 */
export function replaceCanvasCardMenuIcons(containerEl: HTMLElement, app?: App, pluginId?: string): void {
	const menu = containerEl.querySelector('.canvas-card-menu') as HTMLElement | null
	if (!menu) return

	const icons = menu.querySelectorAll('.canvas-card-menu-button')
	icons.forEach((el) => {
		const label = (el.getAttribute('aria-label') || '').toLowerCase()
		for (const [keyword, iconName] of CANVAS_CARD_REPLACEMENTS) {
			if (label.includes(keyword)) {
				setIcon(el as HTMLElement, iconName)
				break
			}
		}
	})

	if (!app) return
	if (menu.querySelector('.bragi-card-separator')) return // already injected

	const makeBtn = (iconName: string, tooltip: string, onClick: () => void): HTMLElement => {
		const btn = document.createElement('div')
		btn.className = 'canvas-card-menu-button bragi-card-extra'
		setIcon(btn, iconName)
		setTooltip(btn, tooltip, { placement: 'top' })
		btn.addEventListener('click', (e) => {
			e.preventDefault()
			e.stopPropagation()
			onClick()
		})
		return btn
	}

	const sep = document.createElement('div')
	sep.className = 'bragi-card-separator'
	menu.appendChild(sep)

	menu.appendChild(makeBtn('bragi-card-export', 'Export canvas as .bragi package', () => {
		(app as any).commands.executeCommandById('bragi-canvas:bragi-export-canvas')
	}))

	menu.appendChild(makeBtn('bragi-card-import', 'Import .bragi package', () => {
		new BragiImportChoiceModal(app, (mode) => {
			const id = mode === 'merge' ? 'bragi-canvas:bragi-import-merge' : 'bragi-canvas:bragi-import-new'
			;(app as any).commands.executeCommandById(id)
		}).open()
	}))

	menu.appendChild(makeBtn('bragi-card-settings', 'Bragi Canvas settings', () => {
		const setting = (app as any).setting
		setting.open()
		setting.openTabById(pluginId || 'bragi-canvas')
	}))
}

class BragiImportChoiceModal extends Modal {
	constructor(app: App, private onChoose: (mode: 'merge' | 'new') => void) {
		super(app)
	}

	onOpen() {
		const { contentEl, titleEl, modalEl } = this
		modalEl.classList.add('bragi-modal')
		titleEl.setText('Import canvas')
		contentEl.createEl('p', { text: 'Where should the contents go?' })

		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' })

		const newBtn = btnRow.createEl('button', { text: 'Open as new canvas' })
		newBtn.addEventListener('click', () => {
			this.close()
			this.onChoose('new')
		})

		const mergeBtn = btnRow.createEl('button', { text: 'Add to this canvas', cls: 'mod-cta' })
		mergeBtn.addEventListener('click', () => {
			this.close()
			this.onChoose('merge')
		})
	}

	onClose() {
		this.contentEl.empty()
	}
}

export function unpatchCanvasMenu(): void {
	if (menuUninstaller) {
		menuUninstaller()
		menuUninstaller = null
	}
}

export function removeToolbarButtons(): void {
	document.querySelectorAll('.bragi-gen-image, .bragi-gen-video, .bragi-gen-text, .bragi-gen-audio, .bragi-stt, .bragi-isolate, .bragi-download, .bragi-duplicate, .bragi-pin, .bragi-pano, .bragi-split, .bragi-grid, .bragi-more').forEach(el => {
		el.previousElementSibling?.classList.contains('canvas-menu-separator') && el.previousElementSibling.remove()
		el.remove()
	})
	document.querySelectorAll('.canvas-card-menu .bragi-card-extra, .canvas-card-menu .bragi-card-separator').forEach(el => el.remove())
}

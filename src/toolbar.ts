/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import { setIcon, setTooltip, Notice, App, Modal } from 'obsidian'
import { around } from 'monkey-around'
import type { Canvas, CanvasNode } from './types/canvas-internal'
import { createPresetSlot } from './canvas-slots'

/**
 * Download a media file from the vault to the user's local filesystem.
 * Uses Electron's native save dialog.
 */
async function downloadMediaFile(vaultPath: string, node: CanvasNode): Promise<void> {
	try {
		const app = node.app
		const adapter = app.vault.adapter
		const fileName = vaultPath.split('/').pop() || 'download'

		const data = await adapter.readBinary(vaultPath)
		const url = URL.createObjectURL(new Blob([data], { type: guessMimeType(fileName) }))
		const link = createEl('a')
		link.href = url
		link.download = fileName
		link.classList.add('bragi-hidden-download-link')
		activeDocument.body.appendChild(link)
		link.click()
		window.setTimeout(() => {
			link.remove()
			URL.revokeObjectURL(url)
		}, 1000)
		new Notice(`Download started: ${fileName}`)
	} catch (err: unknown) {
		// Fallback: create a download link
		try {
			const app = node.app
			const resourcePath = app.vault.adapter.getResourcePath(vaultPath)
			const a = createEl('a')
			a.href = resourcePath
			a.download = vaultPath.split('/').pop() || 'download'
			activeDocument.body.appendChild(a)
			a.click()
			activeDocument.body.removeChild(a)
			new Notice('Download started')
		} catch {
			new Notice(`Download failed: ${err.message}`)
		}
	}
}

function guessMimeType(fileName: string): string {
	const extension = fileName.split('.').pop()?.toLowerCase() || ''
	if (extension === 'png') return 'image/png'
	if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
	if (extension === 'webp') return 'image/webp'
	if (extension === 'gif') return 'image/gif'
	if (extension === 'mp4') return 'video/mp4'
	if (extension === 'webm') return 'video/webm'
	if (extension === 'mov') return 'video/quicktime'
	if (extension === 'mp3') return 'audio/mpeg'
	if (extension === 'wav') return 'audio/wav'
	if (extension === 'flac') return 'audio/flac'
	return 'application/octet-stream'
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
	'pencil': 'bragi-edit',
	'group': 'bragi-group',
	'align': 'bragi-align',
	'background': 'bragi-background',
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
		const label = getButtonLabel(el as HTMLElement)
		if (label.includes(kw)) return el as HTMLElement
	}
	return null
}

type MoreDropdownItem = {
	label: string
	icon: string
	btn: HTMLElement
}

type CanvasDataLike = {
	type?: string
	file?: string
	color?: string
	bragiAssetId?: string
	bragiGenerating?: boolean
	ovidGenerating?: boolean
}

type ImageAnnotationTool = 'box' | 'label' | 'mosaic'

export type HardBindToolbarActions = {
	getActiveCanvas: () => Canvas | null
	openPanel: (type: 'image' | 'video' | 'text' | 'audio', node: CanvasNode) => void
	handleSTT?: (node: CanvasNode) => void
	handleAudioIsolation?: (node: CanvasNode) => void
	openAnnotation?: (node: CanvasNode, tool: ImageAnnotationTool) => void
	openCutout?: (node: CanvasNode) => void
	openReferenceCompose?: (node: CanvasNode) => void
}

function getButtonLabel(el: HTMLElement): string {
	return [
		el.getAttribute('aria-label'),
		el.getAttribute('data-tooltip'),
		el.getAttribute('title'),
		el.ariaLabel,
		el.textContent,
	]
		.filter((value): value is string => Boolean(value))
		.join(' ')
		.toLowerCase()
}

function getNativeMenuButtons(menuEl: HTMLElement): HTMLElement[] {
	return Array.from(menuEl.querySelectorAll('.clickable-icon'))
		.filter((el): el is HTMLElement => el.instanceOf(HTMLElement))
		.filter(el => !el.className.includes('bragi-'))
}

function insertMenuButton(menuEl: HTMLElement, button: HTMLElement, anchor?: Element | null): void {
	if (anchor?.parentElement) {
		anchor.parentElement.insertBefore(button, anchor)
		return
	}
	menuEl.appendChild(button)
}

function createMenuButton(
	className: string,
	iconName: string,
	tooltip: string,
	onClick: (event: MouseEvent) => void,
): HTMLElement {
	const btn = createDiv()
	btn.className = `clickable-icon ${className} bragi-menu-injected`
	setIcon(btn, iconName)
	setTooltip(btn, tooltip, { placement: 'top' })
	btn.addEventListener('click', (event) => {
		event.stopPropagation()
		onClick(event)
	})
	return btn
}

function getMoreItems(menuEl: HTMLElement): MoreDropdownItem[] {
	return Array.from(menuEl.querySelectorAll('[data-bragi-more-label]'))
		.filter((el): el is HTMLElement => el.instanceOf(HTMLElement))
		.sort((a, b) => Number(a.dataset.bragiMoreOrder || 0) - Number(b.dataset.bragiMoreOrder || 0))
		.map((btn) => ({
			label: btn.dataset.bragiMoreLabel || 'Action',
			icon: btn.dataset.bragiMoreIcon || 'bragi-more',
			btn,
		}))
}

function setMoreItem(btn: HTMLElement, label: string, icon: string, order: number, shouldHide = true): void {
	btn.dataset.bragiMoreLabel = label
	btn.dataset.bragiMoreIcon = icon
	btn.dataset.bragiMoreOrder = String(order)
	if (shouldHide) btn.classList.add('bragi-hidden')
}

function findFocusButton(menuEl: HTMLElement): HTMLElement | null {
	return findBuiltinByLabel(menuEl, 'focus') || findBuiltinByLabel(menuEl, 'zoom') || findBuiltinByLabel(menuEl, 'fit')
}

function findColorButton(menuEl: HTMLElement): HTMLElement | null {
	return findBuiltinByLabel(menuEl, 'colo')
}

function findDeleteButton(menuEl: HTMLElement): HTMLElement | null {
	for (const btn of getNativeMenuButtons(menuEl)) {
		const label = getButtonLabel(btn)
		if (label.includes('remove label')) continue
		if (label.includes('delete') || label.includes('remove') || label.includes('trash')) return btn
	}
	return null
}

function findRemoveLabelButton(menuEl: HTMLElement): HTMLElement | null {
	return findBuiltinByLabel(menuEl, 'remove label')
}

function reorderMenuButtons(menuEl: HTMLElement, buttons: Array<HTMLElement | null>): void {
	const firstButton = menuEl.querySelector('.clickable-icon')
	let anchor: HTMLElement | null = null

	for (const btn of buttons) {
		if (!btn) continue
		if (!btn.parentElement) menuEl.appendChild(btn)

		if (!anchor) {
			if (firstButton && firstButton !== btn) menuEl.insertBefore(btn, firstButton)
		} else if (anchor.nextSibling !== btn) {
			menuEl.insertBefore(btn, anchor.nextSibling)
		}

		anchor = btn
	}
}

function configureStandardMoreItems(menuEl: HTMLElement, startOrder: number): number {
	let order = startOrder
	const focusBtn = findFocusButton(menuEl)
	if (focusBtn) setMoreItem(focusBtn, 'Focus', 'bragi-focus', order++)
	const colorBtn = findColorButton(menuEl)
	if (colorBtn) setMoreItem(colorBtn, 'Set color', 'bragi-color', order++)
	const deleteBtn = findDeleteButton(menuEl)
	if (deleteBtn) setMoreItem(deleteBtn, 'Delete', 'bragi-delete', order++)
	return order
}

function configureEdgeMoreItems(menuEl: HTMLElement, startOrder: number): number {
	let order = configureStandardMoreItems(menuEl, startOrder)
	const removeLabelBtn = findRemoveLabelButton(menuEl)
	if (removeLabelBtn) setMoreItem(removeLabelBtn, 'Remove label', 'bragi-delete', order++)
	return order
}

function addMoreButton(menuEl: HTMLElement): void {
	if (getMoreItems(menuEl).length === 0) return
	const moreBtn = createMenuButton('bragi-more', 'bragi-more', 'More', () => {
		openBragiMoreDropdown(moreBtn, menuEl)
	})
	moreBtn.addEventListener('mouseenter', () => openBragiMoreDropdown(moreBtn, menuEl))
	moreBtn.addEventListener('mouseleave', () => scheduleBragiDropdownClose())
	menuEl.appendChild(moreBtn)
}

function clearMenuInjection(menuEl: HTMLElement): void {
	closeBragiDropdown()
	menuEl
		.querySelectorAll('.bragi-menu-injected, .bragi-gen-image, .bragi-gen-video, .bragi-gen-text, .bragi-gen-audio, .bragi-stt, .bragi-isolate, .bragi-download, .bragi-asset-btn, .bragi-duplicate, .bragi-pin, .bragi-pano, .bragi-split, .bragi-grid, .bragi-annotate-box, .bragi-annotate-label, .bragi-annotate-mosaic, .bragi-cutout, .bragi-compose-reference, .bragi-more, .bragi-actions-separator')
		.forEach((el) => el.remove())

	for (const btn of getNativeMenuButtons(menuEl)) {
		btn.classList.remove('bragi-hidden')
		delete btn.dataset.bragiMoreLabel
		delete btn.dataset.bragiMoreIcon
		delete btn.dataset.bragiMoreOrder
	}
}

function hasCanvasData(value: unknown): value is CanvasNode {
	if (!value || typeof value !== 'object') return false
	const candidate = value as { getData?: unknown; setData?: unknown }
	return typeof candidate.getData === 'function' && typeof candidate.setData === 'function'
}

function getCanvasData(node: CanvasNode): CanvasDataLike {
	return node.getData()
}

function isFileWithExtension(data: CanvasDataLike, pattern: RegExp): boolean {
	return data.type === 'file' && pattern.test(data.file || '')
}

function isPromptNode(data: CanvasDataLike): boolean {
	return data.type === 'text' || isFileWithExtension(data, /\.md$/i)
}

function createMarkButton(menuEl: HTMLElement, canvas: Canvas, nodes: CanvasNode[], anchor?: Element | null): HTMLElement | null {
	if (nodes.length === 0) return null
	const pinBtn = createMenuButton('bragi-pin', 'bragi-pin', 'Mark', () => {
		for (const node of nodes) {
			const data = getCanvasData(node)
			node.setData({ ...data, color: data.color === '6' ? '' : '6' })
		}
		void canvas.requestSave()
	})
	insertMenuButton(menuEl, pinBtn, anchor)
	return pinBtn
}

function replaceBuiltinIcons(menuEl: HTMLElement): void {
	const icons = menuEl.querySelectorAll('.clickable-icon:not(.bragi-gen-image):not(.bragi-gen-video):not(.bragi-gen-text)')
	icons.forEach((el) => {
		const label = getButtonLabel(el as HTMLElement)
		for (const [keyword, iconName] of Object.entries(ICON_REPLACEMENTS)) {
			if (label.includes(keyword)) {
				setIcon(el as HTMLElement, iconName)
				break
			}
		}
	})
}

// ── Native align menu hover control ────────────────────────────────────
let nativeAlignCloseTimer: ReturnType<typeof window.setTimeout> | null = null

function cancelNativeAlignClose(): void {
	if (nativeAlignCloseTimer) {
		window.clearTimeout(nativeAlignCloseTimer)
		nativeAlignCloseTimer = null
	}
}

function scheduleNativeAlignClose(): void {
	cancelNativeAlignClose()
	nativeAlignCloseTimer = window.setTimeout(() => closeNativeAlignMenu(), 150)
}

function getOpenAlignMenu(): HTMLElement | null {
	const menus = activeDocument.querySelectorAll('.menu')
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
	window.requestAnimationFrame(() => {
		const m = getOpenAlignMenu()
		if (!m) return
		m.classList.add('bragi-native-align-menu')
		m.addEventListener('mouseenter', cancelNativeAlignClose)
		m.addEventListener('mouseleave', scheduleNativeAlignClose)
	})
}

let bragiDropdownCloseTimer: ReturnType<typeof window.setTimeout> | null = null

function cancelBragiDropdownClose(): void {
	if (bragiDropdownCloseTimer) {
		window.clearTimeout(bragiDropdownCloseTimer)
		bragiDropdownCloseTimer = null
	}
}

function scheduleBragiDropdownClose(): void {
	cancelBragiDropdownClose()
	bragiDropdownCloseTimer = window.setTimeout(() => {
		closeBragiDropdown()
	}, 150)
}

/** Close any open Bragi dropdown. */
function closeBragiDropdown(): void {
	cancelBragiDropdownClose()
	activeDocument.querySelectorAll('.bragi-more-dropdown').forEach((el) => el.remove())
}

/** Render a hover-triggered dropdown anchored directly below the ellipsis button. */
function openBragiMoreDropdown(moreBtn: HTMLElement, menuEl: HTMLElement): void {
	cancelBragiDropdownClose()
	if (activeDocument.querySelector('.bragi-more-dropdown')) return

	const items = getMoreItems(menuEl)
	if (items.length === 0) return

	const btnRect = moreBtn.getBoundingClientRect()
	const toolbarRect = menuEl.getBoundingClientRect()
	const dropdown = createDiv()
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
			const wasHidden = btn.classList.contains('bragi-hidden')
			btn.classList.remove('bragi-hidden')
			btn.click()
			if (wasHidden) btn.classList.add('bragi-hidden')
			closeBragiDropdown()
		})
	}

	dropdown.addEventListener('mouseenter', cancelBragiDropdownClose)
	dropdown.addEventListener('mouseleave', scheduleBragiDropdownClose)

	activeDocument.body.appendChild(dropdown)
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
	onAnnotateImage?: (node: CanvasNode, tool: ImageAnnotationTool) => void,
	onCutoutImage?: (node: CanvasNode) => void,
	onComposeReference?: (node: CanvasNode) => void,
): void {
	if (menuUninstaller) return

	const menu = (canvas as unknown).menu
	if (!menu) return

	menuUninstaller = around(menu.constructor.prototype, {
		render: (next: unknown) => function (this: unknown, ...args: unknown) {
			const result = next.call(this, ...args)

			const menuEl = this.menuEl as HTMLElement
			if (!menuEl) return result

			// Always add class and replace built-in icons (each render resets them)
			menuEl.classList.add('bragi-canvas-menu')
			replaceBuiltinIcons(menuEl)

			const canvas = this.canvas as Canvas
			const selSize = canvas?.selection?.size || 0
			clearMenuInjection(menuEl)

			// ── Align button: hover-to-open (native menu) ──
			if (selSize > 1) {
				const alignBtn = findBuiltinByLabel(menuEl, 'align') || findBuiltinByLabel(menuEl, 'arrange')
				if (alignBtn && !(alignBtn as unknown)._bragiHoverBound) {
					(alignBtn as unknown)._bragiHoverBound = true
					alignBtn.addEventListener('mouseenter', () => openNativeAlignMenu(alignBtn))
					alignBtn.addEventListener('mouseleave', scheduleNativeAlignClose)
				}
			}

			if (!canvas?.selection || selSize === 0) return result

			const selectedItems = Array.from(canvas.selection)
			const selectedNodes = selectedItems.filter(hasCanvasData)

			if (selSize > 1) {
				createMarkButton(menuEl, canvas, selectedNodes)
				const isPurePromptSelection = selectedNodes.length === selSize && selectedNodes.every(node => isPromptNode(getCanvasData(node)))

				if (isPurePromptSelection && onBatchGenerate) {
					const separator = createDiv()
					separator.className = 'canvas-menu-separator bragi-separator bragi-actions-separator bragi-menu-injected'
					menuEl.appendChild(separator)

					for (const [type, icon, label] of [
						['image', 'bragi-gen-image', 'Generate image'],
						['video', 'bragi-gen-video', 'Generate video'],
						['text', 'bragi-gen-text', 'Generate text'],
						['audio', 'bragi-gen-audio', 'Generate audio'],
					] as const) {
						const btn = createMenuButton(`bragi-gen-${type}`, icon, `${label} (${selectedNodes.length})`, () => {
							onBatchGenerate(type, selectedNodes)
						})
						menuEl.appendChild(btn)
					}
				}

				configureStandardMoreItems(menuEl, 0)
				addMoreButton(menuEl)
				next.call(this)
				return result
			}

			const selectedNode = selectedNodes[0]
			const nodeData = selectedNode ? getCanvasData(selectedNode) : null
			const filePath = nodeData?.file || ''

			const isTextNode = nodeData?.type === 'text'
			const isNoteNode = Boolean(nodeData && isFileWithExtension(nodeData, /\.md$/i))
			const isImageNode = Boolean(nodeData && isFileWithExtension(nodeData, /\.(png|jpg|jpeg|webp|gif)$/i))
			const isPanoramaImageNode = Boolean(nodeData && isFileWithExtension(nodeData, /\.(png|jpe?g|webp)$/i))
			const isVideoNode = Boolean(nodeData && isFileWithExtension(nodeData, /\.(mp4|mov|webm)$/i))
			const isAudioNode = Boolean(nodeData && isFileWithExtension(nodeData, /\.(mp3|wav|flac|m4a|ogg|aac)$/i))
			const isMediaNode = isImageNode || isVideoNode || isAudioNode
			const isPromptNodeSelection = Boolean(nodeData && isPromptNode(nodeData))
			const isGenerating = nodeData?.bragiGenerating === true || nodeData?.ovidGenerating === true
			const isEdgeMenu = !isPromptNodeSelection && !isMediaNode && Boolean(
				findBuiltinByLabel(menuEl, 'arrow') || findBuiltinByLabel(menuEl, 'line direction'),
			)

			// Generating node: hide all menu items except focus/zoom
			if (isGenerating) {
				const items = menuEl.querySelectorAll('.clickable-icon')
				items.forEach((el) => {
					const label = getButtonLabel(el as HTMLElement)
					if (!label.includes('zoom') && !label.includes('focus') && !label.includes('fit')) {
						(el as HTMLElement).classList.add('bragi-hidden')
					}
				})
				// Also hide separators
				menuEl.querySelectorAll('.canvas-menu-separator').forEach((el) => {
					(el as HTMLElement).classList.add('bragi-hidden')
				})
				next.call(this)
				return result
			}

			if (isEdgeMenu) {
				const editLabelBtn = findBuiltinByLabel(menuEl, 'edit label')
				const lineDirectionBtn = findBuiltinByLabel(menuEl, 'line direction') || findBuiltinByLabel(menuEl, 'arrow')
				const markBtn = createMarkButton(menuEl, canvas, selectedNodes)
				configureEdgeMoreItems(menuEl, 0)
				addMoreButton(menuEl)
				const moreBtn = menuEl.querySelector<HTMLElement>('.bragi-more')
				reorderMenuButtons(menuEl, [
					editLabelBtn,
					lineDirectionBtn,
					markBtn,
					moreBtn,
				])
				next.call(this)
				return result
			}

			if (isImageNode) {
				if (onGridSplit) {
					const splitBtn = createMenuButton('bragi-split', 'bragi-split', 'Split grid', () => {
						onGridSplit(selectedNode)
					})
					menuEl.appendChild(splitBtn)
				}
				if (onPanorama && isPanoramaImageNode) {
					const panoBtn = createMenuButton('bragi-pano', 'bragi-360', '360° viewer', () => {
						onPanorama(selectedNode)
					})
					menuEl.appendChild(panoBtn)
				}
				if (onAnnotateImage) {
					const boxBtn = createMenuButton('bragi-annotate-box', 'box', 'Annotate with box', () => {
						onAnnotateImage(selectedNode, 'box')
					})
					menuEl.appendChild(boxBtn)

					const labelBtn = createMenuButton('bragi-annotate-label', 'badge', 'Add numbered marker', () => {
						onAnnotateImage(selectedNode, 'label')
					})
					labelBtn.textContent = '1'
					menuEl.appendChild(labelBtn)

					const mosaicBtn = createMenuButton('bragi-annotate-mosaic', 'grid', 'Mosaic brush', () => {
						onAnnotateImage(selectedNode, 'mosaic')
					})
					menuEl.appendChild(mosaicBtn)
				}
				if (onCutoutImage) {
					const cutoutBtn = createMenuButton('bragi-cutout', 'scissors', 'Scene/material cutout', () => {
						onCutoutImage(selectedNode)
					})
					menuEl.appendChild(cutoutBtn)
				}
				if (onComposeReference) {
					const composeBtn = createMenuButton('bragi-compose-reference', 'layers', 'Compose reference image', () => {
						onComposeReference(selectedNode)
					})
					menuEl.appendChild(composeBtn)
				}
				createMarkButton(menuEl, canvas, selectedNodes)
				const downloadBtn = createMenuButton('bragi-download', 'bragi-download', 'Download', () => {
					void downloadMediaFile(filePath, selectedNode)
				})
				menuEl.appendChild(downloadBtn)
				configureStandardMoreItems(menuEl, 0)
				addMoreButton(menuEl)
				next.call(this)
				return result
			}

			if (isVideoNode) {
				createMarkButton(menuEl, canvas, selectedNodes)
				const downloadBtn = createMenuButton('bragi-download', 'bragi-download', 'Download', () => {
					void downloadMediaFile(filePath, selectedNode)
				})
				menuEl.appendChild(downloadBtn)
				configureStandardMoreItems(menuEl, 0)
				addMoreButton(menuEl)
				next.call(this)
				return result
			}

			if (isAudioNode) {
				if (onSTT) {
					const sttBtn = createMenuButton('bragi-stt', 'bragi-stt', 'Speech to text', () => {
						onSTT(selectedNode)
					})
					menuEl.appendChild(sttBtn)
				}
				if (onIsolateAudio) {
					const isolateBtn = createMenuButton('bragi-isolate', 'bragi-isolate', 'Isolate audio', () => {
						onIsolateAudio(selectedNode)
					})
					menuEl.appendChild(isolateBtn)
				}
				createMarkButton(menuEl, canvas, selectedNodes)
				const downloadBtn = createMenuButton('bragi-download', 'bragi-download', 'Download', () => {
					void downloadMediaFile(filePath, selectedNode)
				})
				menuEl.appendChild(downloadBtn)
				configureStandardMoreItems(menuEl, 0)
				addMoreButton(menuEl)
				next.call(this)
				return result
			}

			if (isTextNode || isNoteNode) {
				const editBtn = findBuiltinByLabel(menuEl, 'edit')
				if (isTextNode) editBtn?.remove()
				const markBtn = createMarkButton(menuEl, canvas, selectedNodes)
				const edges = canvas.getEdgesForNode(selectedNode)
				const hasIncoming = edges?.some(e => e.to.node.id === selectedNode.id)
				let dupBtn: HTMLElement | null = null
				if (onDuplicate && hasIncoming) {
					dupBtn = createMenuButton('bragi-duplicate', 'bragi-duplicate', 'Duplicate with connections', () => {
						onDuplicate(selectedNode)
					})
					menuEl.appendChild(dupBtn)
				}

				const separator = createDiv()
				separator.className = 'canvas-menu-separator bragi-separator bragi-actions-separator bragi-menu-injected'
				menuEl.appendChild(separator)

				const generationButtons: HTMLElement[] = []
				const imageBtn = createMenuButton('bragi-gen-image', 'bragi-gen-image', 'Generate image', () => {
					onGenerateImage(selectedNode)
				})
				menuEl.appendChild(imageBtn)
				generationButtons.push(imageBtn)

				const videoBtn = createMenuButton('bragi-gen-video', 'bragi-gen-video', 'Generate video', () => {
					onGenerateVideo(selectedNode)
				})
				menuEl.appendChild(videoBtn)
				generationButtons.push(videoBtn)

				if (onGenerateText) {
					const textBtn = createMenuButton('bragi-gen-text', 'bragi-gen-text', 'Generate text', () => {
						onGenerateText(selectedNode)
					})
					menuEl.appendChild(textBtn)
					generationButtons.push(textBtn)
				}

				if (onGenerateAudio) {
					const audioBtn = createMenuButton('bragi-gen-audio', 'bragi-gen-audio', 'Generate audio', () => {
						onGenerateAudio(selectedNode)
					})
					menuEl.appendChild(audioBtn)
					generationButtons.push(audioBtn)
				}

				configureStandardMoreItems(menuEl, 0)
				addMoreButton(menuEl)
				const moreBtn = menuEl.querySelector<HTMLElement>('.bragi-more')
				reorderMenuButtons(menuEl, [
					...generationButtons,
					separator,
					isTextNode ? null : editBtn,
					markBtn,
					dupBtn,
					moreBtn,
				])
				next.call(this)
				return result
			}

			createMarkButton(menuEl, canvas, selectedNodes)
			configureStandardMoreItems(menuEl, 0)
			addMoreButton(menuEl)

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
			const group = (el as HTMLElement).closest('.canvas-control-group')
			if (group) group.classList.add('bragi-hidden')
			else (el as HTMLElement).classList.add('bragi-hidden')
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
	const menu = containerEl.querySelector('.canvas-card-menu')
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
		const btn = createDiv()
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

	const sep = createDiv()
	sep.className = 'bragi-card-separator'
	menu.appendChild(sep)

	menu.appendChild(makeBtn('box', 'Add preset slot', () => {
		createPresetSlot(app)
	}))

	menu.appendChild(makeBtn('bragi-card-export', 'Export canvas as .bragi package', () => {
		(app as unknown).commands.executeCommandById('bragi-canvas:bragi-export-canvas')
	}))

	menu.appendChild(makeBtn('bragi-card-import', 'Import .bragi package', () => {
		new BragiImportChoiceModal(app, (mode) => {
			const id = mode === 'merge' ? 'bragi-canvas:bragi-import-merge' : 'bragi-canvas:bragi-import-new'
			;(app as unknown).commands.executeCommandById(id)
		}).open()
	}))

	menu.appendChild(makeBtn('bragi-card-settings', 'Bragi Canvas settings', () => {
		const setting = (app as unknown).setting
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

let hardBindTimer: ReturnType<typeof window.setInterval> | null = null
let hardBindObserver: MutationObserver | null = null

export function startHardBindToolbar(actions: HardBindToolbarActions): () => void {
	stopHardBindToolbar()
	const ensure = () => ensureHardBindToolbar(actions)
	hardBindTimer = window.setInterval(ensure, 250)
	if (typeof MutationObserver !== 'undefined' && activeDocument.body) {
		hardBindObserver = new MutationObserver(ensure)
		hardBindObserver.observe(activeDocument.body, { childList: true, subtree: true })
	}
	ensure()
	return stopHardBindToolbar
}

export function stopHardBindToolbar(): void {
	if (hardBindTimer) {
		window.clearInterval(hardBindTimer)
		hardBindTimer = null
	}
	if (hardBindObserver) {
		hardBindObserver.disconnect()
		hardBindObserver = null
	}
}

function ensureHardBindToolbar(actions: HardBindToolbarActions): void {
	try {
		const canvas = actions.getActiveCanvas()
		if (!canvas?.selection || canvas.selection.size !== 1) return
		const menu = getVisibleCanvasMenu()
		if (!menu) return

		const selected = Array.from(canvas.selection)[0]
		if (!hasCanvasData(selected)) return
		const data = selected.getData() as CanvasDataLike
		const filePath = data.file || ''
		const isTextNode = data.type === 'text'
		const isNoteNode = data.type === 'file' && /\.md$/i.test(filePath)
		const isImageNode = data.type === 'file' && /\.(png|jpg|jpeg|webp|gif)$/i.test(filePath)
		const isAudioNode = data.type === 'file' && /\.(mp3|wav|flac|m4a|ogg|aac)$/i.test(filePath)

		if (!isTextNode && !isNoteNode && !isImageNode && !isAudioNode) return
		menu.classList.add('bragi-canvas-menu', 'bragi-hard-bound')

		if (isTextNode || isNoteNode || isImageNode) {
			addHardBindButton(menu, 'bragi-gen-image', 'bragi-gen-image', 'Generate image', () => {
				actions.openPanel('image', selected)
			})
			addHardBindButton(menu, 'bragi-gen-video', 'bragi-gen-video', 'Generate video', () => {
				actions.openPanel('video', selected)
			})
			addHardBindButton(menu, 'bragi-gen-text', 'bragi-gen-text', 'Generate text', () => {
				actions.openPanel('text', selected)
			})
			addHardBindButton(menu, 'bragi-gen-audio', 'bragi-gen-audio', 'Generate audio', () => {
				actions.openPanel('audio', selected)
			})
		}

		if (isImageNode) {
			addHardBindButton(menu, 'bragi-annotate-box', 'box', 'Annotate with box', () => {
				actions.openAnnotation?.(selected, 'box')
			})
			addHardBindButton(menu, 'bragi-annotate-label', '1', 'Add numbered marker', () => {
				actions.openAnnotation?.(selected, 'label')
			})
			addHardBindButton(menu, 'bragi-annotate-mosaic', 'grid', 'Mosaic brush', () => {
				actions.openAnnotation?.(selected, 'mosaic')
			})
			addHardBindButton(menu, 'bragi-cutout', 'scissors', 'Scene/material cutout', () => {
				actions.openCutout?.(selected)
			})
			addHardBindButton(menu, 'bragi-compose-reference', 'layers', 'Compose reference image', () => {
				actions.openReferenceCompose?.(selected)
			})
		}

		if (isAudioNode) {
			addHardBindButton(menu, 'bragi-stt', 'bragi-stt', 'Speech to text', () => {
				actions.handleSTT?.(selected)
			})
			addHardBindButton(menu, 'bragi-isolate', 'bragi-isolate', 'Isolate audio', () => {
				actions.handleAudioIsolation?.(selected)
			})
		}
	} catch (err) {
		console.error('Bragi: hard toolbar bind failed', err)
	}
}

function getVisibleCanvasMenu(): HTMLElement | null {
	const menus = activeDocument.querySelectorAll('.canvas-menu')
	for (const menu of Array.from(menus)) {
		const rect = menu.getBoundingClientRect()
		if (rect.width > 40 && rect.height > 20) return menu as HTMLElement
	}
	return null
}

function addHardBindButton(
	menu: HTMLElement,
	className: string,
	iconName: string,
	tooltip: string,
	onClick: () => void,
): void {
	if (menu.querySelector(`.${className}`)) return
	const button = createDiv()
	button.className = `clickable-icon ${className} bragi-menu-injected bragi-hard-bound-action`
	if (iconName === '1') button.textContent = '1'
	else setIcon(button, iconName)
	setTooltip(button, tooltip, { placement: 'top' })
	button.addEventListener('click', (event) => {
		event.stopPropagation()
		onClick()
	})
	menu.insertBefore(button, menu.firstChild)
}

export function unpatchCanvasMenu(): void {
	if (menuUninstaller) {
		menuUninstaller()
		menuUninstaller = null
	}
}

export function removeToolbarButtons(): void {
	stopHardBindToolbar()
	activeDocument.querySelectorAll('.bragi-gen-image, .bragi-gen-video, .bragi-gen-text, .bragi-gen-audio, .bragi-stt, .bragi-isolate, .bragi-download, .bragi-asset-btn, .bragi-duplicate, .bragi-pin, .bragi-pano, .bragi-split, .bragi-grid, .bragi-annotate-box, .bragi-annotate-label, .bragi-annotate-mosaic, .bragi-cutout, .bragi-compose-reference, .bragi-more').forEach(el => {
		if (el.previousElementSibling?.classList.contains('canvas-menu-separator')) {
			el.previousElementSibling.remove()
		}
		el.remove()
	})
	activeDocument.querySelectorAll('.canvas-card-menu .bragi-card-extra, .canvas-card-menu .bragi-card-separator').forEach(el => el.remove())
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Resume strict linting after the runtime-shaped data boundary. */

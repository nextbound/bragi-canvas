/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas file nodes are runtime-shaped internals. */
import { around } from 'monkey-around'
import type { App, TFile } from 'obsidian'
import type { Canvas, CanvasNode } from './types/canvas-internal'

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg|bmp|avif)$/i
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i
const AUDIO_EXT = /\.(mp3|wav|flac|m4a|ogg|aac|opus)$/i

const MEDIA_NODE_CLASS = 'bragi-media-node'
const META_LABEL_CLASS = 'bragi-media-meta-label'

type MediaKind = 'image' | 'video' | 'audio'

interface MediaNodeInternals extends CanvasNode {
	labelEl?: HTMLElement
	metaLabelEl?: HTMLElement
	file?: TFile
}

let renderPatchUninstall: (() => void) | null = null
let refreshInterval: ReturnType<typeof window.setInterval> | null = null
let activeApp: App | null = null

function getFilePath(node: CanvasNode): string {
	const data = node.getData()
	if (data.type !== 'file') return ''
	return data.file || ''
}

function getMediaKind(filePath: string): MediaKind | null {
	if (IMAGE_EXT.test(filePath)) return 'image'
	if (VIDEO_EXT.test(filePath)) return 'video'
	if (AUDIO_EXT.test(filePath)) return 'audio'
	return null
}

function formatExtensionLabel(filePath: string): string {
	const ext = filePath.split('.').pop()
	return ext ? ext.toUpperCase() : ''
}

function formatFileSize(bytes: number | null | undefined): string {
	if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return ''
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) {
		const kb = bytes / 1024
		return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
	}
	const mb = bytes / (1024 * 1024)
	return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

function formatDimensions(width: number, height: number): string {
	if (!width || !height) return ''
	return `${width}×${height}`
}

function formatMetaLabel(kind: MediaKind, dimensions: string, size: string): string {
	if (kind === 'audio') return size
	if (dimensions && size) return `${dimensions} · ${size}`
	return dimensions || size
}

async function getFileSize(app: App, node: MediaNodeInternals, filePath: string): Promise<number | null> {
	const fromNode = node.file?.stat?.size
	if (typeof fromNode === 'number') return fromNode

	const abstract = app.vault.getAbstractFileByPath(filePath)
	if (abstract && 'stat' in abstract && abstract.stat) {
		return abstract.stat.size
	}

	try {
		const stat = await app.vault.adapter.stat(filePath)
		return stat?.size ?? null
	} catch {
		return null
	}
}

function findMediaElement(node: CanvasNode, kind: MediaKind): HTMLImageElement | HTMLVideoElement | null {
	const root = node.contentEl || node.containerEl || node.nodeEl
	if (!root) return null
	if (kind === 'image') return root.querySelector('img')
	if (kind === 'video') return root.querySelector('video')
	return null
}

function probeImageDimensions(app: App, filePath: string): Promise<string> {
	const url = app.vault.adapter.getResourcePath(filePath)
	return new Promise((resolve) => {
		const img = new Image()
		let settled = false
		const finish = () => {
			if (settled) return
			settled = true
			resolve(formatDimensions(img.naturalWidth, img.naturalHeight))
		}
		img.addEventListener('load', finish, { once: true })
		img.addEventListener('error', () => {
			if (settled) return
			settled = true
			resolve('')
		}, { once: true })
		window.setTimeout(finish, 5000)
		img.src = url
	})
}

function probeVideoDimensions(app: App, filePath: string): Promise<string> {
	const url = app.vault.adapter.getResourcePath(filePath)
	return new Promise((resolve) => {
		const video = document.createElement('video')
		video.preload = 'metadata'
		let settled = false
		const finish = () => {
			if (settled) return
			settled = true
			resolve(formatDimensions(video.videoWidth, video.videoHeight))
		}
		video.addEventListener('loadedmetadata', finish, { once: true })
		video.addEventListener('error', () => {
			if (settled) return
			settled = true
			resolve('')
		}, { once: true })
		window.setTimeout(finish, 5000)
		video.src = url
	})
}

function readImageDimensions(node: CanvasNode, app: App, filePath: string): Promise<string> {
	const img = findMediaElement(node, 'image') as HTMLImageElement | null
	if (!img) return probeImageDimensions(app, filePath)

	if (img.naturalWidth > 0 && img.naturalHeight > 0) {
		return Promise.resolve(formatDimensions(img.naturalWidth, img.naturalHeight))
	}

	return new Promise((resolve) => {
		let settled = false
		const finish = async () => {
			if (settled) return
			settled = true
			const fromDom = formatDimensions(img.naturalWidth, img.naturalHeight)
			if (fromDom) {
				resolve(fromDom)
				return
			}
			resolve(await probeImageDimensions(app, filePath))
		}
		if (img.complete) {
			void finish()
			return
		}
		img.addEventListener('load', () => { void finish() }, { once: true })
		img.addEventListener('error', () => { void finish() }, { once: true })
		window.setTimeout(() => { void finish() }, 5000)
	})
}

function readVideoDimensions(node: CanvasNode, app: App, filePath: string): Promise<string> {
	const video = findMediaElement(node, 'video') as HTMLVideoElement | null
	if (!video) return probeVideoDimensions(app, filePath)

	if (video.videoWidth > 0 && video.videoHeight > 0) {
		return Promise.resolve(formatDimensions(video.videoWidth, video.videoHeight))
	}

	return new Promise((resolve) => {
		let settled = false
		const finish = async () => {
			if (settled) return
			settled = true
			const fromDom = formatDimensions(video.videoWidth, video.videoHeight)
			if (fromDom) {
				resolve(fromDom)
				return
			}
			resolve(await probeVideoDimensions(app, filePath))
		}
		if (video.readyState >= 1) {
			void finish()
			return
		}
		video.addEventListener('loadedmetadata', () => { void finish() }, { once: true })
		video.addEventListener('error', () => { void finish() }, { once: true })
		window.setTimeout(() => { void finish() }, 5000)
	})
}

async function resolveMediaMeta(app: App, node: CanvasNode, kind: MediaKind, filePath: string): Promise<string> {
	const size = formatFileSize(await getFileSize(app, node as MediaNodeInternals, filePath))
	let dimensions = ''
	if (kind === 'image') dimensions = await readImageDimensions(node, app, filePath)
	if (kind === 'video') dimensions = await readVideoDimensions(node, app, filePath)
	return formatMetaLabel(kind, dimensions, size)
}

function metaIsComplete(kind: MediaKind, metaText: string): boolean {
	if (kind === 'audio') return Boolean(metaText)
	return metaText.includes('×')
}

function ensureMetaLabel(node: MediaNodeInternals): HTMLElement | null {
	const nodeEl = node.nodeEl
	if (!nodeEl) return null

	if (node.metaLabelEl?.isConnected) return node.metaLabelEl

	const existing = nodeEl.querySelector(`.${META_LABEL_CLASS}`) as HTMLElement | null
	if (existing) {
		node.metaLabelEl = existing
		return existing
	}

	const metaEl = nodeEl.createDiv({
		cls: `canvas-node-label ${META_LABEL_CLASS} mod-hover-label`,
	})
	node.metaLabelEl = metaEl
	return metaEl
}

function getLabelEl(node: MediaNodeInternals): HTMLElement | null {
	if (node.labelEl?.isConnected) return node.labelEl
	return node.nodeEl?.querySelector('.canvas-node-label:not(.bragi-media-meta-label)') as HTMLElement | null
}

async function syncMediaNode(node: CanvasNode): Promise<void> {
	const app = activeApp
	if (!app) return

	const filePath = getFilePath(node)
	const kind = getMediaKind(filePath)
	const nodeEl = node.nodeEl
	if (!kind || !nodeEl) {
		nodeEl?.classList.remove(MEDIA_NODE_CLASS)
		return
	}

	nodeEl.classList.add(MEDIA_NODE_CLASS)

	const extLabel = formatExtensionLabel(filePath)
	const labelEl = getLabelEl(node as MediaNodeInternals)
	if (labelEl && labelEl.textContent !== extLabel) {
		labelEl.empty()
		labelEl.setText(extLabel)
	}

	const metaEl = ensureMetaLabel(node as MediaNodeInternals)
	if (!metaEl) return

	const cacheKey = `${node.id}:${filePath}:${kind}`
	const cached = metaEl.getAttribute('data-meta-key')
	const metaComplete = metaEl.getAttribute('data-meta-complete') === '1'
	if (cached === cacheKey && metaEl.textContent && metaComplete) return

	const metaText = await resolveMediaMeta(app, node, kind, filePath)
	if (!metaText) return

	const complete = metaIsComplete(kind, metaText)
	metaEl.setAttribute('data-meta-key', cacheKey)
	metaEl.setAttribute('data-meta-complete', complete ? '1' : '0')
	metaEl.empty()
	metaEl.setText(metaText)
}

function syncAllMediaNodes(canvas: Canvas): void {
	for (const node of canvas.nodes.values()) {
		const kind = getMediaKind(getFilePath(node))
		if (kind) void syncMediaNode(node)
	}
}

function findFileNodePrototype(canvas: Canvas): object | null {
	for (const node of canvas.nodes.values()) {
		if (node.getData().type === 'file') {
			return Object.getPrototypeOf(node) as object
		}
	}
	return null
}

function tryInstallRenderPatch(canvas: Canvas): boolean {
	if (renderPatchUninstall) return true

	const proto = findFileNodePrototype(canvas) as { render?: (...args: unknown[]) => unknown } | null
	if (!proto?.render) return false

	renderPatchUninstall = around(proto, {
		render(next) {
			return function (this: CanvasNode, ...args: unknown[]) {
				const result = next.call(this, ...args)
				const filePath = getFilePath(this)
				if (getMediaKind(filePath)) {
					void syncMediaNode(this)
				}
				return result
			}
		},
		updateNodeLabel(next) {
			return function (this: CanvasNode, text: unknown, ...args: unknown[]) {
				const filePath = getFilePath(this)
				const kind = getMediaKind(filePath)
				if (kind) {
					const result = next.call(this, formatExtensionLabel(filePath), ...args)
					void syncMediaNode(this)
					return result
				}
				return next.call(this, text, ...args)
			}
		},
	})

	return true
}

export function startMediaNodeHover(canvas: Canvas, app: App): void {
	activeApp = app
	tryInstallRenderPatch(canvas)
	syncAllMediaNodes(canvas)

	if (refreshInterval) window.clearInterval(refreshInterval)
	refreshInterval = window.setInterval(() => {
		tryInstallRenderPatch(canvas)
		syncAllMediaNodes(canvas)
	}, 1000)
}

export function stopMediaNodeHover(): void {
	if (refreshInterval) {
		window.clearInterval(refreshInterval)
		refreshInterval = null
	}

	renderPatchUninstall?.()
	renderPatchUninstall = null
	activeApp = null

	activeDocument.querySelectorAll(`.${META_LABEL_CLASS}`).forEach((el) => el.remove())
	activeDocument.querySelectorAll(`.${MEDIA_NODE_CLASS}`).forEach((el) => {
		el.classList.remove(MEDIA_NODE_CLASS)
	})
}

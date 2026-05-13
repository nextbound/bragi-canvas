import { Modal, Notice, App, setIcon } from 'obsidian'
import type { Canvas, CanvasNode } from './types/canvas-internal'
// @ts-ignore — esbuild text loader
import pannellumJs from 'pannellum-raw'

let pannellumLoaded = false

function loadPannellum(): void {
	if (pannellumLoaded) return
	pannellumLoaded = true
	const script = createEl('script')
	script.textContent = pannellumJs
	activeDocument.head.appendChild(script)
}

function generateId(): string {
	return Math.random().toString(36).substring(2, 18)
}

export class PanoramaViewerModal extends Modal {
	private sourceNode: CanvasNode
	private canvas: Canvas
	private outputDir: string
	private imagePath: string
	private viewer: unknown = null
	private viewerEl: HTMLElement | null = null
	private mirrored = false
	private originalUrl: string | null = null
	private mirroredUrl: string | null = null

	constructor(app: App, canvas: Canvas, sourceNode: CanvasNode, imagePath: string, outputDir: string) {
		super(app)
		this.canvas = canvas
		this.sourceNode = sourceNode
		this.imagePath = imagePath
		this.outputDir = outputDir
	}

	async onOpen() {
		loadPannellum()

		this.modalEl.classList.add('bragi-pano-modal')
		this.modalEl.parentElement?.classList.add('bragi-pano-modal-container')
		const { contentEl } = this
		contentEl.empty()
		// Hide modal title bar (empty) so close button sits flush on black background
		this.viewerEl = contentEl.createDiv({ cls: 'bragi-pano-container' })

		// Floating bottom action bar (mirrors .canvas-card-menu)
		const bar = contentEl.createDiv({ cls: 'bragi-pano-bar' })
		const mirrorBtn = bar.createDiv({ cls: 'bragi-pano-bar-btn' })
		setIcon(mirrorBtn, 'bragi-pano-flip')
		bar.createDiv({ cls: 'bragi-pano-bar-sep' })
		const captureBtn = bar.createDiv({ cls: 'bragi-pano-bar-btn' })
		setIcon(captureBtn, 'bragi-pano-camera')

		captureBtn.setAttribute('aria-label', 'Capture')
		mirrorBtn.setAttribute('aria-label', 'Mirror')

		captureBtn.addEventListener('click', () => {
			if (captureBtn.classList.contains('is-disabled')) return
			captureBtn.classList.add('is-disabled')
			void (async () => {
				try {
					await this.captureScreenshot()
					this.close()
				} catch (err: unknown) {
					new Notice(`Couldn't capture: ${err.message || err}`)
					captureBtn.classList.remove('is-disabled')
				}
			})()
		})

		mirrorBtn.addEventListener('click', () => {
			if (mirrorBtn.classList.contains('is-disabled')) return
			mirrorBtn.classList.add('is-disabled')
			void (async () => {
				try {
					this.mirrored = !this.mirrored
					mirrorBtn.classList.toggle('is-active', this.mirrored)
					await this.rebuildViewer()
				} finally {
					mirrorBtn.classList.remove('is-disabled')
				}
			})()
		})

		try {
			this.originalUrl = await this.loadImageUrl()
			await this.rebuildViewer()
		} catch (err: unknown) {
			this.viewerEl.setText(`Couldn't load this image: ${err.message || err}`)
		}
	}

	onClose() {
		this.modalEl.parentElement?.classList.remove('bragi-pano-modal-container')
		try {
			this.viewer?.destroy?.()
		} catch {
			// Viewer teardown is best-effort.
		}
		this.viewer = null
		if (this.originalUrl) {
			try {
				URL.revokeObjectURL(this.originalUrl)
			} catch {
				// Blob URLs can already be revoked by the browser.
			}
			this.originalUrl = null
		}
		if (this.mirroredUrl) {
			try {
				URL.revokeObjectURL(this.mirroredUrl)
			} catch {
				// Blob URLs can already be revoked by the browser.
			}
			this.mirroredUrl = null
		}
		this.contentEl.empty()
	}

	/** Preserve camera pose across reloads. */
	private async rebuildViewer(): Promise<void> {
		const p = (window as unknown).pannellum
		if (!p || !this.viewerEl) return

		let yaw = 0, pitch = 0, hfov = 100
		const hadViewer = !!this.viewer
		if (this.viewer) {
			try {
				yaw = this.viewer.getYaw()
				pitch = this.viewer.getPitch()
				hfov = this.viewer.getHfov()
				this.viewer.destroy()
			} catch {
				// Preserve the default camera pose if the previous viewer cannot report it.
			}
		}

		let url = this.originalUrl!
		if (this.mirrored) {
			if (!this.mirroredUrl) {
				this.mirroredUrl = await this.buildMirroredUrl(this.originalUrl!)
			}
			url = this.mirroredUrl
		}

		// When toggling mirror on or off, flip yaw so the same direction stays on-screen
		if (hadViewer) yaw = -yaw

		this.viewer = p.viewer(this.viewerEl, {
			type: 'equirectangular',
			panorama: url,
			autoLoad: true,
			showControls: false,
			showFullscreenCtrl: false,
			showZoomCtrl: false,
			mouseZoom: true,
			draggable: true,
			compass: false,
			yaw,
			pitch,
			hfov,
		})
		window.setTimeout(() => {
			try {
				this.viewer?.resize?.()
			} catch {
				// Resize is opportunistic; pannellum may have already torn down.
			}
		}, 50)
		window.setTimeout(() => {
			try {
				this.viewer?.resize?.()
			} catch {
				// Resize is opportunistic; pannellum may have already torn down.
			}
		}, 250)
	}

	/** Horizontally flip an image URL and return a new blob: URL. */
	private async buildMirroredUrl(srcUrl: string): Promise<string> {
		const img = await new Promise<HTMLImageElement>((resolve, reject) => {
			const i = new Image()
			i.onload = () => resolve(i)
			i.onerror = () => reject(new Error('mirror: image load failed'))
			i.src = srcUrl
		})
		const c = createEl('canvas')
		c.width = img.naturalWidth
		c.height = img.naturalHeight
		const ctx = c.getContext('2d')!
		ctx.translate(c.width, 0)
		ctx.scale(-1, 1)
		ctx.drawImage(img, 0, 0)
		return new Promise<string>((resolve, reject) => {
			c.toBlob(b => b ? resolve(URL.createObjectURL(b)) : reject(new Error('mirror: toBlob failed')), 'image/png')
		})
	}

	/** Read the vault file into a blob: URL that pannellum will fetch. */
	private async loadImageUrl(): Promise<string> {
		const binary = await this.app.vault.adapter.readBinary(this.imagePath)
		const ext = this.imagePath.split('.').pop()?.toLowerCase() || 'png'
		const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
		const blob = new Blob([binary], { type: mime })
		return URL.createObjectURL(blob)
	}

	private async captureScreenshot() {
		if (!this.viewer) throw new Error('viewer not ready')

		const yaw = this.viewer.getYaw()
		const pitch = this.viewer.getPitch()
		const hfov = this.viewer.getHfov()

		const url = this.mirrored && this.mirroredUrl ? this.mirroredUrl : this.originalUrl!

		const offscreen = createDiv()
		offscreen.classList.add('bragi-pano-offscreen-shot')
		activeDocument.body.appendChild(offscreen)

		const p = (window as unknown).pannellum
		const shotViewer: unknown = p.viewer(offscreen, {
			type: 'equirectangular',
			panorama: url,
			autoLoad: true,
			showControls: false,
			showFullscreenCtrl: false,
			showZoomCtrl: false,
			compass: false,
			yaw,
			pitch,
			hfov,
		})

		// Wait for load + render
		await new Promise<void>((resolve, reject) => {
			let settled = false
			const timer = window.setTimeout(() => {
				if (!settled) { settled = true; reject(new Error('timeout waiting for panorama render')) }
			}, 8000)
			shotViewer.on('load', () => {
				if (settled) return
				settled = true
				window.clearTimeout(timer)
				// Give the renderer a frame to paint
				window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))
			})
		})

		const canvasEl = offscreen.querySelector('canvas')
		if (!canvasEl) { shotViewer.destroy(); offscreen.remove(); throw new Error('no canvas in viewer') }

		const shotDataUrl = canvasEl.toDataURL('image/png')
		try {
			shotViewer.destroy()
		} catch {
			// Capture viewer cleanup is best-effort.
		}
		offscreen.remove()

		const b64 = shotDataUrl.split(',')[1]
		const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0))

		const adapter = this.app.vault.adapter
		if (!await adapter.exists(this.outputDir)) await adapter.mkdir(this.outputDir)
		const fileName = `pano_${Date.now()}.png`
		const filePath = `${this.outputDir}/${fileName}`
		await adapter.writeBinary(filePath, buf.buffer)

		this.addNodeRightOf(filePath)
		new Notice('Captured')
	}

	private addNodeRightOf(filePath: string) {
		const src = this.sourceNode.getData() as unknown
		const newId = generateId()
		const edgeId = generateId()
		const w = src.width || 500
		const h = Math.round(w / 2) // 2:1 panorama
		const currentData = this.canvas.getData()
		this.canvas.importData({
			nodes: [...currentData.nodes, {
				id: newId,
				type: 'file' as const,
				file: filePath,
				x: src.x + (src.width || 500) + 80,
				y: src.y,
				width: w,
				height: h,
				color: '',
			}],
			edges: [...currentData.edges, {
				id: edgeId,
				fromNode: this.sourceNode.id,
				fromSide: 'right',
				toNode: newId,
				toSide: 'left',
				toEnd: 'arrow',
			}],
		})
		void this.canvas.requestSave()
	}
}

/** Entry point called from toolbar. */
export function openPanoramaViewer(app: App, canvas: Canvas, node: CanvasNode, outputDir: string): void {
	const data = node.getData() as unknown
	const filePath = data.file
	if (!filePath) {
		new Notice('This node has no image file')
		return
	}
	new PanoramaViewerModal(app, canvas, node, filePath, outputDir).open()
}

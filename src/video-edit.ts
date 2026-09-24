import { errorMessage } from './task-errors'
import { Notice, setIcon, setTooltip } from 'obsidian'
import type BragiCanvas from './main'
import { findFreePosition } from './canvas-ops'
import { CanvasInlineToolSession, type CanvasInlineToolContext } from './canvas-inline-tool'
import { findMediaElement } from './media-node-hover'
import type { Canvas, CanvasNode } from './types/canvas-internal'

export const VIDEO_EDIT_ACTION_EVENT = 'bragi-video-edit-action'

const VIDEO_PATH_RE = /\.(mp4|mov|webm|mkv|m4v)$/i
const FRAME_PREFIX = 'frame'
const CLIP_PREFIX = 'clip'
/** Shortest selectable segment. Clamped down to the clip's own duration for very short videos. */
const MIN_TRIM_DURATION_SEC = 1
const THUMB_COUNT = 12
const SEEK_TIMEOUT_MS = 4000

type VideoEditAction = { type: 'exit' }

type CanvasFileData = {
	type?: string
	file?: string
	x?: number
	y?: number
	width?: number
	height?: number
	color?: string
}

type CaptureStreamVideo = HTMLVideoElement & { captureStream(): MediaStream }

function createId(): string {
	return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10)
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value))
}

function videoMime(path: string): string {
	const ext = path.split('.').pop()?.toLowerCase()
	if (ext === 'webm') return 'video/webm'
	if (ext === 'mov') return 'video/quicktime'
	if (ext === 'mkv') return 'video/x-matroska'
	return 'video/mp4'
}

function isVideoFile(path: string | undefined): path is string {
	return typeof path === 'string' && VIDEO_PATH_RE.test(path)
}

function readVideoPath(node: CanvasNode): string | null {
	const data = node.getData() as CanvasFileData
	return data.type === 'file' && isVideoFile(data.file) ? data.file : null
}

function formatTime(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds))
	const mins = Math.floor(total / 60)
	const secs = total % 60
	return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function setInstantTopTooltip(el: HTMLElement, text: string): void {
	setTooltip(el, text, { placement: 'top' })
	el.setAttribute('data-tooltip-delay', '0')
	el.setAttribute('data-tooltip-position', 'top')
}

function isVideoEditEventTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false
	return Boolean(target.closest('.bragi-video-edit-bar, .bragi-canvas-menu'))
}

/** Resolve {@link currentTime} on a video element, settling on the `seeked` event (with a timeout guard). */
function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
	const target = clamp(time, 0, Number.isFinite(video.duration) ? video.duration : time)
	return new Promise((resolve) => {
		if (Math.abs(video.currentTime - target) < 0.001) {
			resolve()
			return
		}
		let settled = false
		const finish = (): void => {
			if (settled) return
			settled = true
			video.removeEventListener('seeked', finish)
			resolve()
		}
		video.addEventListener('seeked', finish, { once: true })
		window.setTimeout(finish, SEEK_TIMEOUT_MS)
		video.currentTime = target
	})
}

function pickClipMimeType(): string | undefined {
	const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
	for (const type of candidates) {
		if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type
	}
	return undefined
}

class VideoEditMode {
	private session: CanvasInlineToolSession<VideoEditAction> | null = null
	private previewVideo: HTMLVideoElement | null = null
	private workVideo: HTMLVideoElement | null = null
	private thumbVideo: HTMLVideoElement | null = null
	private objectUrl: string | null = null
	private duration = 0
	private inPoint = 0
	private outPoint = 0

	private barEl: HTMLElement | null = null
	private trackEl: HTMLElement | null = null
	private selectionEl: HTMLElement | null = null
	private dimLeftEl: HTMLElement | null = null
	private dimRightEl: HTMLElement | null = null
	private inHandleEl: HTMLElement | null = null
	private outHandleEl: HTMLElement | null = null
	private playheadEl: HTMLElement | null = null
	private playBtn: HTMLElement | null = null
	private durationLabel: HTMLElement | null = null

	private playing = false
	private rafId: number | null = null
	private busy = false
	private originalControls: boolean | null = null
	private closed = false

	constructor(
		private readonly plugin: BragiCanvas,
		private readonly sourceCanvas: Canvas,
		private readonly sourceNode: CanvasNode,
		private readonly filePath: string,
	) {}

	open(): void {
		void this.load().catch((err) => {
			console.error('Bragi video editor failed to open', err)
			new Notice(err instanceof Error ? errorMessage(err) : 'Could not open video editor')
			this.close()
		})
	}

	private async load(): Promise<void> {
		await this.loadWorkVideos()
		if (!Number.isFinite(this.duration) || this.duration <= 0) {
			throw new Error('Could not read video duration')
		}
		this.inPoint = 0
		this.outPoint = this.duration

		this.session = new CanvasInlineToolSession<VideoEditAction>({
			id: 'video-edit',
			canvas: this.sourceCanvas,
			node: this.sourceNode,
			actionEvent: VIDEO_EDIT_ACTION_EVENT,
			renderToolbar: (menuEl, context) => this.renderToolbar(menuEl, context),
			onAction: action => this.handleAction(action),
			bottomToolbar: { className: 'bragi-video-edit-bar', render: bar => this.buildBar(bar) },
			isToolEventTarget: isVideoEditEventTarget,
			onKeyDown: event => this.handleKeyDown(event),
			onClose: () => this.cleanup(),
			focusOptions: { maxZoom: 1 },
		})
		this.session.open()
		this.setupPreviewVideo()
		void this.generateThumbnails()
	}

	private async loadWorkVideos(): Promise<void> {
		const binary = await this.plugin.app.vault.adapter.readBinary(this.filePath)
		this.objectUrl = URL.createObjectURL(new Blob([binary], { type: videoMime(this.filePath) }))

		this.workVideo = createEl('video')
		this.workVideo.muted = true
		this.workVideo.preload = 'auto'
		this.workVideo.crossOrigin = 'anonymous'
		this.workVideo.src = this.objectUrl

		this.thumbVideo = createEl('video')
		this.thumbVideo.muted = true
		this.thumbVideo.preload = 'auto'
		this.thumbVideo.src = this.objectUrl

		// Keep the work videos attached but off-screen so frames keep flowing during capture/record.
		const stash = createDiv({ cls: 'bragi-video-edit-offscreen' })
		stash.appendChild(this.workVideo)
		stash.appendChild(this.thumbVideo)
		activeDocument.body.appendChild(stash)

		this.duration = await this.readDuration(this.workVideo)
	}

	private readDuration(video: HTMLVideoElement): Promise<number> {
		if (Number.isFinite(video.duration) && video.duration > 0) return Promise.resolve(video.duration)
		return new Promise((resolve) => {
			let settled = false
			const finish = (): void => {
				if (settled) return
				settled = true
				resolve(video.duration)
			}
			video.addEventListener('loadedmetadata', finish, { once: true })
			video.addEventListener('error', () => { if (!settled) { settled = true; resolve(NaN) } }, { once: true })
			window.setTimeout(finish, SEEK_TIMEOUT_MS)
		})
	}

	// ── Top toolbar (Exit | capture frames | Save) ─────────────────────────
	private renderToolbar(menuEl: HTMLElement, context: CanvasInlineToolContext<VideoEditAction>): void {
		const exitBtn = createDiv()
		exitBtn.className = 'clickable-icon bragi-video-edit-exit bragi-labeled-menu-button bragi-menu-injected'
		setIcon(exitBtn, 'bragi-annotation-exit-icon')
		exitBtn.setAttribute('aria-label', 'Exit')
		setInstantTopTooltip(exitBtn, 'Exit video editor')
		exitBtn.createSpan({ cls: 'bragi-menu-button-label', text: 'Exit' })
		exitBtn.addEventListener('click', (event) => {
			event.stopPropagation()
			context.dispatchAction({ type: 'exit' })
		})
		menuEl.appendChild(exitBtn)

		menuEl.createDiv({ cls: 'bragi-annotation-separator bragi-menu-injected' })

		// Capture buttons, mapped out from the old dropdown: current / first / last frame.
		menuEl.appendChild(this.createCaptureButton('bragi-video-capture', 'Capture current frame', () => {
			void this.captureFrame(this.currentPreviewTime())
		}))
		menuEl.appendChild(this.createCaptureButton('bragi-video-capture-first', 'Capture first frame', () => {
			void this.captureFrame(0)
		}))
		menuEl.appendChild(this.createCaptureButton('bragi-video-capture-last', 'Capture last frame', () => {
			void this.captureFrame(Math.max(0, this.duration - 0.04))
		}))

		const saveBtn = createDiv()
		saveBtn.className = 'clickable-icon bragi-video-edit-save bragi-labeled-menu-button bragi-menu-injected'
		saveBtn.setAttribute('aria-label', 'Save')
		setInstantTopTooltip(saveBtn, 'Save the selected segment as a new clip')
		saveBtn.createSpan({ cls: 'bragi-menu-button-label', text: 'Save' })
		saveBtn.addEventListener('click', (event) => {
			event.stopPropagation()
			void this.exportClip()
		})
		menuEl.appendChild(saveBtn)
	}

	private createCaptureButton(icon: string, tooltip: string, onClick: () => void): HTMLElement {
		const btn = createDiv()
		btn.className = 'clickable-icon bragi-video-edit-capture bragi-menu-injected'
		setIcon(btn, icon)
		btn.setAttribute('aria-label', tooltip)
		setInstantTopTooltip(btn, tooltip)
		btn.addEventListener('click', (event) => {
			event.stopPropagation()
			onClick()
		})
		return btn
	}

	private handleAction(action: VideoEditAction): void {
		if (action.type === 'exit') this.close()
	}

	private handleKeyDown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault()
			event.stopPropagation()
			this.close()
			return
		}
		if (event.key === ' ') {
			event.preventDefault()
			event.stopPropagation()
			this.togglePlay()
		}
	}

	// ── Bottom toolbar ─────────────────────────────────────────────────────
	private buildBar(bar: HTMLElement): void {
		this.playBtn = bar.createDiv({ cls: 'bragi-video-edit-btn bragi-video-edit-play' })
		setIcon(this.playBtn, 'bragi-video-play')
		setInstantTopTooltip(this.playBtn, 'Play / pause')
		this.playBtn.addEventListener('click', () => this.togglePlay())

		const timeline = bar.createDiv({ cls: 'bragi-video-edit-timeline' })
		const track = timeline.createDiv({ cls: 'bragi-video-edit-track' })
		this.trackEl = track
		track.createDiv({ cls: 'bragi-video-edit-thumbs' })
		this.dimLeftEl = track.createDiv({ cls: 'bragi-video-edit-dim is-left' })
		this.dimRightEl = track.createDiv({ cls: 'bragi-video-edit-dim is-right' })
		this.selectionEl = track.createDiv({ cls: 'bragi-video-edit-selection' })
		this.playheadEl = track.createDiv({ cls: 'bragi-video-edit-playhead' })
		this.inHandleEl = track.createDiv({ cls: 'bragi-video-edit-handle is-in' })
		this.outHandleEl = track.createDiv({ cls: 'bragi-video-edit-handle is-out' })

		track.addEventListener('pointerdown', event => this.handleTrackPointerDown(event))
		this.inHandleEl.addEventListener('pointerdown', event => this.beginHandleDrag('in', event))
		this.outHandleEl.addEventListener('pointerdown', event => this.beginHandleDrag('out', event))
		this.playheadEl.addEventListener('pointerdown', event => this.beginPlayheadDrag(event))

		this.durationLabel = bar.createDiv({ cls: 'bragi-video-edit-duration' })

		// Capture and Save now live in the top toolbar (see renderToolbar).
		// The framework owns the bar element: it mounts it inside the canvas wrapper,
		// positions it node-relative, and removes it on close.
		this.barEl = bar
		this.renderSelection()
		this.updateTimeLabel(this.currentPreviewTime())
	}

	private setupPreviewVideo(): void {
		const video = this.getPreviewVideo()
		if (!video) return
		this.originalControls = video.controls
		video.controls = false
		video.pause()
	}

	private getPreviewVideo(): HTMLVideoElement | null {
		if (this.previewVideo && this.previewVideo.isConnected) return this.previewVideo
		this.previewVideo = findMediaElement(this.sourceNode, 'video') as HTMLVideoElement | null
		return this.previewVideo
	}

	private currentPreviewTime(): number {
		const video = this.getPreviewVideo()
		const time = video ? video.currentTime : this.inPoint
		return clamp(time, 0, this.duration)
	}

	// ── Timeline interaction ───────────────────────────────────────────────
	private timeFromClientX(clientX: number): number {
		if (!this.trackEl) return 0
		const rect = this.trackEl.getBoundingClientRect()
		const pct = rect.width > 0 ? (clientX - rect.left) / rect.width : 0
		return clamp(pct, 0, 1) * this.duration
	}

	private handleTrackPointerDown(event: PointerEvent): void {
		if (event.target === this.inHandleEl || event.target === this.outHandleEl || event.target === this.playheadEl) return
		event.preventDefault()
		event.stopPropagation()
		// Clicking the track jumps the playhead there, then lets you scrub by dragging.
		this.beginPlayheadDrag(event)
	}

	private beginPlayheadDrag(event: PointerEvent): void {
		event.preventDefault()
		event.stopPropagation()
		const playhead = this.playheadEl
		if (!playhead) return
		this.pausePreview()
		playhead.setPointerCapture(event.pointerId)
		this.seekPreview(this.timeFromClientX(event.clientX))

		const onMove = (moveEvent: PointerEvent): void => {
			this.seekPreview(this.timeFromClientX(moveEvent.clientX))
		}
		const onUp = (upEvent: PointerEvent): void => {
			if (playhead.hasPointerCapture(upEvent.pointerId)) playhead.releasePointerCapture(upEvent.pointerId)
			playhead.removeEventListener('pointermove', onMove)
			playhead.removeEventListener('pointerup', onUp)
			playhead.removeEventListener('pointercancel', onUp)
		}
		playhead.addEventListener('pointermove', onMove)
		playhead.addEventListener('pointerup', onUp)
		playhead.addEventListener('pointercancel', onUp)
	}

	private beginHandleDrag(which: 'in' | 'out', event: PointerEvent): void {
		event.preventDefault()
		event.stopPropagation()
		const handle = which === 'in' ? this.inHandleEl : this.outHandleEl
		if (!handle) return
		// Pause while dragging so the preview doesn't keep restarting on every seek; if we were
		// playing, resume looping from the selection start once the drag ends.
		const wasPlaying = this.playing
		this.pausePreview()
		handle.setPointerCapture(event.pointerId)
		const minSpan = Math.min(MIN_TRIM_DURATION_SEC, this.duration)

		const onMove = (moveEvent: PointerEvent): void => {
			const time = this.timeFromClientX(moveEvent.clientX)
			if (which === 'in') this.inPoint = clamp(time, 0, this.outPoint - minSpan)
			else this.outPoint = clamp(time, this.inPoint + minSpan, this.duration)
			this.renderSelection()
			this.seekPreview(which === 'in' ? this.inPoint : this.outPoint)
		}
		const onUp = (upEvent: PointerEvent): void => {
			handle.releasePointerCapture(upEvent.pointerId)
			handle.removeEventListener('pointermove', onMove)
			handle.removeEventListener('pointerup', onUp)
			handle.removeEventListener('pointercancel', onUp)
			if (wasPlaying) this.playPreview()
		}
		handle.addEventListener('pointermove', onMove)
		handle.addEventListener('pointerup', onUp)
		handle.addEventListener('pointercancel', onUp)
	}

	private renderSelection(): void {
		if (this.duration <= 0) return
		const inPct = (this.inPoint / this.duration) * 100
		const outPct = (this.outPoint / this.duration) * 100
		if (this.inHandleEl) this.inHandleEl.style.left = `${inPct}%`
		if (this.outHandleEl) this.outHandleEl.style.left = `${outPct}%`
		if (this.selectionEl) {
			this.selectionEl.style.left = `${inPct}%`
			this.selectionEl.style.width = `${Math.max(0, outPct - inPct)}%`
		}
		if (this.dimLeftEl) this.dimLeftEl.style.width = `${inPct}%`
		if (this.dimRightEl) {
			this.dimRightEl.style.left = `${outPct}%`
			this.dimRightEl.style.width = `${Math.max(0, 100 - outPct)}%`
		}
	}

	private updateTimeLabel(time: number): void {
		if (!this.durationLabel) return
		// Show progress within the selected segment: current position (relative to the in point)
		// over the selection's total length.
		const selectionLength = this.outPoint - this.inPoint
		const elapsed = clamp(time - this.inPoint, 0, selectionLength)
		this.durationLabel.setText(`${formatTime(elapsed)} / ${formatTime(selectionLength)}`)
	}

	private updatePlayhead(time: number): void {
		this.updateTimeLabel(time)
		if (!this.playheadEl || this.duration <= 0) return
		this.playheadEl.style.left = `${clamp(time / this.duration, 0, 1) * 100}%`
	}

	private seekPreview(time: number): void {
		const video = this.getPreviewVideo()
		const target = clamp(time, 0, this.duration)
		if (video) video.currentTime = target
		this.updatePlayhead(target)
	}

	// ── Playback ───────────────────────────────────────────────────────────
	private togglePlay(): void {
		if (this.playing) this.pausePreview()
		else this.playPreview()
	}

	private playPreview(): void {
		const video = this.getPreviewVideo()
		if (!video) return
		if (video.currentTime < this.inPoint || video.currentTime >= this.outPoint - 0.02) {
			video.currentTime = this.inPoint
		}
		void video.play()
		this.playing = true
		if (this.playBtn) setIcon(this.playBtn, 'bragi-video-pause')
		this.startPlayheadLoop()
	}

	private pausePreview(): void {
		const video = this.getPreviewVideo()
		if (video) video.pause()
		this.playing = false
		if (this.playBtn) setIcon(this.playBtn, 'bragi-video-play')
		this.stopPlayheadLoop()
	}

	private startPlayheadLoop(): void {
		this.stopPlayheadLoop()
		const tick = (): void => {
			const video = this.getPreviewVideo()
			if (video) {
				if (!video.paused && video.currentTime >= this.outPoint - 0.02) {
					video.currentTime = this.inPoint
				}
				this.updatePlayhead(video.currentTime)
				if (video.paused && this.playing) this.pausePreview()
			}
			if (this.playing) this.rafId = window.requestAnimationFrame(tick)
		}
		this.rafId = window.requestAnimationFrame(tick)
	}

	private stopPlayheadLoop(): void {
		if (this.rafId !== null) {
			window.cancelAnimationFrame(this.rafId)
			this.rafId = null
		}
	}

	// ── Thumbnails ─────────────────────────────────────────────────────────
	private async generateThumbnails(): Promise<void> {
		const video = this.thumbVideo
		const thumbsEl = this.trackEl?.querySelector<HTMLElement>('.bragi-video-edit-thumbs')
		if (!video || !thumbsEl) return
		await this.readDuration(video)

		const aspect = video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 9
		// Render the thumbnails at a higher pixel density than the 44px track so they stay crisp
		// on hi-dpi displays instead of looking blurry.
		const scale = Math.max(2, Math.min(3, window.devicePixelRatio || 1))
		const thumbHeight = Math.round(44 * scale)
		const thumbWidth = Math.max(8, Math.round(thumbHeight * aspect))
		const canvas = createEl('canvas')
		canvas.width = thumbWidth
		canvas.height = thumbHeight
		const ctx = canvas.getContext('2d')
		if (!ctx) return
		ctx.imageSmoothingQuality = 'high'

		for (let i = 0; i < THUMB_COUNT; i++) {
			if (this.closed) return
			const time = this.duration * ((i + 0.5) / THUMB_COUNT)
			await seekTo(video, time)
			if (this.closed) return
			try {
				ctx.drawImage(video, 0, 0, thumbWidth, thumbHeight)
			} catch (err) {
				console.debug('Bragi video editor: thumbnail draw skipped', err)
				continue
			}
			const cell = thumbsEl.createDiv({ cls: 'bragi-video-edit-thumb' })
			cell.style.backgroundImage = `url("${canvas.toDataURL('image/jpeg', 0.85)}")`
		}
	}

	// ── Frame capture (PNG → connected node) ───────────────────────────────
	private async captureFrame(time: number): Promise<void> {
		if (this.busy || !this.workVideo) return
		this.setBusy(true)
		try {
			await seekTo(this.workVideo, time)
			const width = this.workVideo.videoWidth
			const height = this.workVideo.videoHeight
			if (width <= 0 || height <= 0) throw new Error('Video frame is not ready yet')
			const canvas = createEl('canvas')
			canvas.width = width
			canvas.height = height
			const ctx = canvas.getContext('2d')
			if (!ctx) throw new Error('Could not capture frame')
			ctx.drawImage(this.workVideo, 0, 0, width, height)
			const buffer = await this.canvasToPng(canvas)
			const filePath = await this.saveBinary(FRAME_PREFIX, 'png', buffer)
			this.addResultNode(filePath, width, height)
			new Notice('Frame captured')
		} catch (err: unknown) {
			console.error('Bragi video editor: frame capture failed', err)
			new Notice(err instanceof Error ? errorMessage(err) : 'Could not capture frame')
		} finally {
			this.setBusy(false)
		}
	}

	private canvasToPng(canvas: HTMLCanvasElement): Promise<ArrayBuffer> {
		return new Promise((resolve, reject) => {
			canvas.toBlob((blob) => {
				if (!blob) {
					reject(new Error('Could not encode frame'))
					return
				}
				void blob.arrayBuffer().then(resolve, reject)
			}, 'image/png')
		})
	}

	// ── Trim export (WebM → connected node) ────────────────────────────────
	private async exportClip(): Promise<void> {
		if (this.busy || !this.workVideo) return
		if (typeof MediaRecorder === 'undefined') {
			new Notice('Clip export is not supported in this environment')
			return
		}
		this.pausePreview()
		this.setBusy(true)
		const notice = new Notice('Exporting clip…', 0)
		try {
			const buffer = await this.recordSegment(this.inPoint, this.outPoint)
			const filePath = await this.saveBinary(CLIP_PREFIX, 'webm', buffer)
			const data = this.sourceNode.getData() as CanvasFileData
			this.addResultNode(filePath, data.width ?? this.sourceNode.width, data.height ?? this.sourceNode.height)
			notice.hide()
			new Notice('Clip exported')
		} catch (err: unknown) {
			notice.hide()
			console.error('Bragi video editor: clip export failed', err)
			new Notice(err instanceof Error ? errorMessage(err) : 'Could not export clip')
		} finally {
			this.setBusy(false)
		}
	}

	private async recordSegment(start: number, end: number): Promise<ArrayBuffer> {
		const video = this.workVideo
		if (!video) throw new Error('Video is not ready')
		await seekTo(video, start)
		const stream = (video as CaptureStreamVideo).captureStream()
		const recorder = new MediaRecorder(stream, { mimeType: pickClipMimeType() })
		const chunks: BlobPart[] = []
		recorder.addEventListener('dataavailable', (event) => {
			if (event.data && event.data.size > 0) chunks.push(event.data)
		})

		const stopped = new Promise<void>((resolve) => recorder.addEventListener('stop', () => resolve(), { once: true }))

		let stopping = false
		let safetyTimer = 0
		const finish = (): void => {
			if (stopping) return
			stopping = true
			window.clearTimeout(safetyTimer)
			video.removeEventListener('timeupdate', onProgress)
			video.removeEventListener('ended', finish)
			video.pause()
			if (recorder.state !== 'inactive') recorder.stop()
		}
		const onProgress = (): void => {
			if (video.currentTime >= end - 0.01) finish()
		}
		video.addEventListener('timeupdate', onProgress)
		video.addEventListener('ended', finish)
		// Safety net: never let a stalled element keep the recorder running forever.
		safetyTimer = window.setTimeout(finish, Math.max(1000, (end - start) * 1000 + 1500))

		recorder.start()
		await video.play()
		await stopped
		window.clearTimeout(safetyTimer)
		video.removeEventListener('timeupdate', onProgress)
		video.removeEventListener('ended', finish)

		const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' })
		if (blob.size === 0) throw new Error('No video data was recorded')
		return blob.arrayBuffer()
	}

	// ── Saving + node creation ─────────────────────────────────────────────
	private async saveBinary(prefix: string, ext: string, buffer: ArrayBuffer): Promise<string> {
		const outputDir = this.plugin.getOutputDir()
		await this.ensureFolder(outputDir)
		const filePath = `${outputDir}/${prefix}_${Date.now()}_${createId().slice(0, 6)}.${ext}`
		await this.plugin.app.vault.adapter.writeBinary(filePath, buffer)
		this.plugin.rememberGeneratedAsset(filePath)
		return filePath
	}

	private async ensureFolder(folderPath: string): Promise<void> {
		const adapter = this.plugin.app.vault.adapter
		const parts = folderPath.split('/').filter(Boolean)
		let current = ''
		for (const part of parts) {
			current = current ? `${current}/${part}` : part
			if (!await adapter.exists(current)) await adapter.mkdir(current)
		}
	}

	private addResultNode(filePath: string, contentWidth: number, contentHeight: number): void {
		const data = this.sourceNode.getData() as CanvasFileData
		const sourceX = data.x ?? this.sourceNode.x
		const sourceY = data.y ?? this.sourceNode.y
		const sourceWidth = data.width ?? this.sourceNode.width ?? 360
		const nodeWidth = clamp(sourceWidth, 180, 520)
		const nodeHeight = Math.max(120, Math.round(nodeWidth * contentHeight / Math.max(1, contentWidth)))
		const position = findFreePosition(this.sourceCanvas, sourceX + sourceWidth + 40, sourceY, nodeWidth, nodeHeight, this.sourceNode.id)
		const nodeId = createId()
		const edgeId = createId()
		const current = this.sourceCanvas.getData() as unknown as { nodes: object[]; edges: object[] }
		this.sourceCanvas.importData({
			nodes: [...current.nodes, {
				id: nodeId,
				type: 'file',
				file: filePath,
				x: position.x,
				y: position.y,
				width: nodeWidth,
				height: nodeHeight,
				color: data.color || '',
			}],
			edges: [...current.edges, {
				id: edgeId,
				fromNode: this.sourceNode.id,
				fromSide: 'right',
				toNode: nodeId,
				toSide: 'left',
				toEnd: 'arrow',
			}],
		})
		void this.sourceCanvas.requestSave()
		try {
			void this.sourceCanvas.requestFrame()
		} catch (err) {
			console.debug('Bragi video editor: canvas frame refresh skipped', err)
		}
	}

	private setBusy(busy: boolean): void {
		this.busy = busy
		this.barEl?.classList.toggle('is-busy', busy)
	}

	// ── Teardown ───────────────────────────────────────────────────────────
	close(): void {
		if (this.closed) return
		this.closed = true
		this.session?.close()
	}

	private cleanup(): void {
		this.stopPlayheadLoop()
		this.playing = false

		const preview = this.previewVideo
		if (preview) {
			preview.pause()
			if (this.originalControls !== null) preview.controls = this.originalControls
		}
		this.previewVideo = null

		for (const video of [this.workVideo, this.thumbVideo]) {
			if (!video) continue
			try {
				video.pause()
				video.removeAttribute('src')
				video.load()
			} catch (err) {
				console.debug('Bragi video editor: work video teardown skipped', err)
			}
		}
		activeDocument.querySelectorAll('.bragi-video-edit-offscreen').forEach(el => el.remove())
		this.workVideo = null
		this.thumbVideo = null

		if (this.objectUrl) {
			URL.revokeObjectURL(this.objectUrl)
			this.objectUrl = null
		}

		// The framework owns the bottom bar element and removes it on close.
		this.barEl = null
	}
}

/** Entry point called from the canvas toolbar for a selected video node. */
export function openVideoEditTool(plugin: BragiCanvas, canvas: Canvas, node: CanvasNode): void {
	const filePath = readVideoPath(node)
	if (!filePath) {
		new Notice('Select a video node first')
		return
	}
	new VideoEditMode(plugin, canvas, node, filePath).open()
}

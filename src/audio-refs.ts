import type { App } from 'obsidian'
import type { Canvas, CanvasNode } from './types/canvas-internal'
import { getUpstreamInputs } from './edge-parser'

const STRIP_CLASS = 'bragi-audio-ref-strip'
const NODE_HAS_AUDIO_REFS_CLASS = 'bragi-has-audio-refs'

let isDragging = false

export function getOrderedAudios(canvas: Canvas, node: CanvasNode): string[] {
	const upstream = getUpstreamInputs(canvas, node)
	const uniqueAudios = [...new Set(upstream.audios)]

	const nodeData = node.getData() as unknown
	const savedOrder: string[] | undefined = nodeData.bragiAudioOrder

	if (savedOrder && savedOrder.length > 0) {
		const ordered: string[] = []
		for (const path of savedOrder) {
			if (uniqueAudios.includes(path)) ordered.push(path)
		}
		for (const path of uniqueAudios) {
			if (!ordered.includes(path)) ordered.push(path)
		}
		return ordered
	}

	return uniqueAudios
}

function formatDuration(seconds: number): string {
	const total = Math.round(seconds)
	const h = Math.floor(total / 3600)
	const m = Math.floor((total % 3600) / 60)
	const s = total % 60
	const pad = (n: number) => String(n).padStart(2, '0')
	if (total >= 6000) return `${pad(h)}:${pad(m)}:${pad(s)}`
	return `${pad(m)}:${pad(s)}`
}

async function getAudioDuration(app: App, filePath: string): Promise<number> {
	try {
		const url = app.vault.adapter.getResourcePath(filePath)
		return new Promise((resolve) => {
			const audio = new Audio(url)
			audio.addEventListener('loadedmetadata', () => resolve(audio.duration))
			audio.addEventListener('error', () => resolve(0))
			window.setTimeout(() => resolve(0), 3000)
		})
	} catch {
		return 0
	}
}

export function updateAudioRefStrip(canvas: Canvas, node: CanvasNode, app: App): void {
	if (isDragging) return

	const nodeData = node.getData() as unknown
	if (nodeData.type !== 'text' && !(nodeData.type === 'file' && /\.md$/i.test(nodeData.file || ''))) {
		return
	}

	const contentEl = node.contentEl
	const nodeEl = node.nodeEl || node.containerEl
	if (!contentEl) return

	const existing = contentEl.querySelector(`.${STRIP_CLASS}`)
	const orderedAudios = getOrderedAudios(canvas, node)

	if (orderedAudios.length === 0) {
		if (existing) {
			existing.remove()
			nodeEl?.classList.remove(NODE_HAS_AUDIO_REFS_CLASS)
		}
		return
	}

	const fingerprint = orderedAudios.join('|')
	if (existing?.getAttribute('data-fingerprint') === fingerprint) return

	existing?.remove()

	const strip = createDiv()
	strip.className = STRIP_CLASS
	strip.setAttribute('data-fingerprint', fingerprint)

	for (let i = 0; i < orderedAudios.length; i++) {
		const audioPath = orderedAudios[i]

		const wrapper = createDiv()
		wrapper.className = 'bragi-audio-ref-wrapper'
		wrapper.setAttribute('data-audio-path', audioPath)
		wrapper.draggable = true

		const leading = createDiv()
		leading.className = 'bragi-ref-leading'

		const handle = createSpan()
		handle.className = 'bragi-text-ref-handle'
		handle.textContent = '⠿'
		leading.appendChild(handle)

		const badge = createSpan()
		badge.className = 'bragi-ref-badge bragi-ref-badge-inline'
		badge.textContent = String(i + 1)
		leading.appendChild(badge)

		wrapper.appendChild(leading)

		const label = createSpan()
		label.className = 'bragi-audio-ref-label'
		label.textContent = '...'
		wrapper.appendChild(label)

		const basename = audioPath.split('/').pop() || audioPath
		wrapper.title = `#${i + 1} — ${basename}`

		void getAudioDuration(app, audioPath).then(dur => {
			label.textContent = dur > 0 ? formatDuration(dur) : basename.replace(/\.[^.]+$/, '')
		}).catch(() => {
			label.textContent = basename.replace(/\.[^.]+$/, '')
		})

		wrapper.addEventListener('dragstart', (e) => {
			isDragging = true
			e.dataTransfer!.setData('text/plain', `bragi-audio-ref:${audioPath}`)
			wrapper.classList.add('is-dragging')
		})
		wrapper.addEventListener('dragend', () => {
			isDragging = false
			wrapper.classList.remove('is-dragging')
		})
		wrapper.addEventListener('dragover', (e) => {
			e.preventDefault()
			wrapper.classList.add('drag-over')
		})
		wrapper.addEventListener('dragleave', () => {
			wrapper.classList.remove('drag-over')
		})
		wrapper.addEventListener('drop', (e) => {
			e.preventDefault()
			wrapper.classList.remove('drag-over')
			const payload = e.dataTransfer!.getData('text/plain') || ''
			if (!payload.startsWith('bragi-audio-ref:')) return
			const draggedPath = payload.substring('bragi-audio-ref:'.length)
			if (!draggedPath || draggedPath === audioPath) return

			const newOrder = [...orderedAudios]
			const fromIdx = newOrder.indexOf(draggedPath)
			const toIdx = newOrder.indexOf(audioPath)
			if (fromIdx === -1 || toIdx === -1) return
			newOrder.splice(fromIdx, 1)
			newOrder.splice(toIdx, 0, draggedPath)

			const data = node.getData() as unknown
			node.setData({ ...data, bragiAudioOrder: newOrder })

			isDragging = false
			updateAudioRefStrip(canvas, node, app)
		})

		strip.appendChild(wrapper)
	}

	// Insert after image strip, before text strip
	const imageStrip = contentEl.querySelector('.bragi-ref-strip')
	const textStrip = contentEl.querySelector('.bragi-text-ref-strip')
	if (imageStrip && imageStrip.parentElement === contentEl) {
		imageStrip.insertAdjacentElement('afterend', strip)
	} else if (textStrip && textStrip.parentElement === contentEl) {
		textStrip.insertAdjacentElement('beforebegin', strip)
	} else {
		contentEl.prepend(strip)
	}
	nodeEl?.classList.add(NODE_HAS_AUDIO_REFS_CLASS)
}

export function refreshAllAudioRefs(canvas: Canvas, app: App): void {
	if (isDragging) return
	if (!canvas.nodes) return
	const nodes = canvas.nodes instanceof Map
		? Array.from(canvas.nodes.values())
		: (canvas.nodes as unknown[])
	for (const node of nodes) {
		const data = node.getData()
		if (data.type === 'text' || (data.type === 'file' && /\.md$/i.test((data).file || ''))) {
			updateAudioRefStrip(canvas, node, app)
		}
	}
}

export function removeAllAudioRefs(): void {
	activeDocument.querySelectorAll(`.${STRIP_CLASS}`).forEach(el => el.remove())
	activeDocument.querySelectorAll(`.${NODE_HAS_AUDIO_REFS_CLASS}`).forEach(el => el.classList.remove(NODE_HAS_AUDIO_REFS_CLASS))
}

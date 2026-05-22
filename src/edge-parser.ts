/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import type { Canvas, CanvasNode } from './types/canvas-internal'
import type { App } from 'obsidian'

export interface UpstreamInputs {
	prompts: string[]        // text from upstream text/note nodes
	images: string[]         // vault-relative file paths of upstream images
	videos: string[]         // vault-relative file paths of upstream videos
	audios: string[]         // vault-relative file paths of upstream audio files
	pdfs: string[]           // vault-relative file paths of upstream PDF files
}

/**
 * Read all upstream nodes connected to the given node via edges.
 * "Upstream" = edges where edge.to.node === this node (arrows pointing into it).
 */
export function getUpstreamInputs(canvas: Canvas, node: CanvasNode): UpstreamInputs {
	const result: UpstreamInputs = {
		prompts: [],
		images: [],
		videos: [],
		audios: [],
		pdfs: [],
	}

	const edges = canvas.getEdgesForNode(node)
	if (!edges) return result

	for (const edge of edges) {
		// Only edges pointing TO this node with a unidirectional arrow (→)
		// Skip nondirectional (—) and bidirectional (↔) edges
		if (edge.to.node.id !== node.id) continue

		const edgeData = (edge as unknown).getData?.() || edge
		const toEnd = edgeData.toEnd ?? 'arrow'  // default is arrow
		const fromEnd = edgeData.fromEnd ?? 'none'

		// Must have arrow pointing TO this node, and NOT arrow from this node (that would be bidirectional)
		if (toEnd !== 'arrow') continue
		if (fromEnd === 'arrow') continue  // bidirectional = not a directed input

		const sourceNode = edge.from.node
		const sourceData = sourceNode.getData()

		if (sourceData.type === 'text') {
			// Text card — read inline text
			const text = sourceNode.text?.trim()
			if (text) result.prompts.push(text)
		} else if (sourceData.type === 'file') {
			const filePath = (sourceData as unknown).file || ''

			if (/\.md$/i.test(filePath)) {
				// Note node — will need to read file content later (async)
				// For now, store the path; caller resolves it
				result.prompts.push(`__md__:${filePath}`)
			} else if (/\.pdf$/i.test(filePath)) {
				result.pdfs.push(filePath)
			} else if (/\.(png|jpg|jpeg|webp|gif)$/i.test(filePath)) {
				result.images.push(filePath)
			} else if (/\.(mp4|mov|webm)$/i.test(filePath)) {
				result.videos.push(filePath)
			} else if (/\.(mp3|wav|m4a|mp4|aac|flac|ogg|opus)$/i.test(filePath)) {
				result.audios.push(filePath)
			}
		}
	}

	return result
}

/**
 * Resolve any __md__: entries in prompts by reading the actual file content.
 */
export async function resolvePrompts(prompts: string[], app: App): Promise<string[]> {
	const resolved: string[] = []
	for (const p of prompts) {
		if (p.startsWith('__md__:')) {
			const filePath = p.slice(7)
			const file = app.vault.getAbstractFileByPath(filePath)
			if (file) {
				const content = await app.vault.read(file as unknown)
				if (content.trim()) resolved.push(content.trim())
			}
		} else {
			resolved.push(p)
		}
	}
	return resolved
}

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

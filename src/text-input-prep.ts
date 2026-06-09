import type { App } from 'obsidian'
import type { Canvas, CanvasNode } from './types/canvas-internal'
import type { UpstreamInputs } from './edge-parser'
import { getOrderedImages } from './ref-thumbnails'
import { uploadRef } from './providers/upload'
import { getTextInputCapability, textInputKindSupported } from './models/text-input-capabilities'

const RELAY_UPLOAD_MAX_BYTES = 15 * 1024 * 1024
const ANTHROPIC_PDF_MAX_BYTES = 32 * 1024 * 1024

export interface PreparedTextInputs {
	refImages: string[]
	refPdfs: string[]
	refVideos: string[]
	refAudios: string[]
}

interface PrepContext {
	app: App
	modelId: string
	providerId: string
	apiModelId?: string
}

function getFileExtension(filePath: string, fallback: string): string {
	return filePath.split('.').pop()?.toLowerCase() || fallback
}

function audioMimeType(filePath: string): string {
	const ext = getFileExtension(filePath, 'mp3')
	if (ext === 'wav') return 'audio/wav'
	if (ext === 'm4a' || ext === 'mp4') return 'audio/mp4'
	if (ext === 'aac') return 'audio/aac'
	if (ext === 'flac') return 'audio/flac'
	if (ext === 'ogg') return 'audio/ogg'
	if (ext === 'opus') return 'audio/opus'
	return 'audio/mpeg'
}

function videoMimeType(filePath: string): string {
	const ext = getFileExtension(filePath, 'mp4')
	if (ext === 'mov') return 'video/quicktime'
	if (ext === 'webm') return 'video/webm'
	return 'video/mp4'
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer)
	let binary = ''
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i])
	}
	return btoa(binary)
}

async function readVaultFileAsDataUri(app: App, filePath: string, mimeType: string): Promise<string> {
	const binary = await app.vault.adapter.readBinary(filePath)
	return `data:${mimeType};base64,${arrayBufferToBase64(binary)}`
}

async function readVaultFileSize(app: App, filePath: string): Promise<number> {
	const stat = await app.vault.adapter.stat(filePath)
	return stat?.size || 0
}

function shouldUploadForProvider(providerId: string, byteSize: number): boolean {
	// Gemini is intentionally excluded: its API-key endpoint rejects arbitrary
	// relay URLs in fileData.fileUri (verified live → HTTP 500). The Gemini text
	// provider re-hosts large/non-image refs via the Files API instead, so it must
	// receive the raw bytes (data URI) here rather than a relay URL.
	if (providerId === 'dashscope' || providerId === 'tokenrouter') {
		return byteSize > RELAY_UPLOAD_MAX_BYTES
	}
	return false
}

async function prepareMediaRef(
	ctx: PrepContext,
	filePath: string,
	mimeType: string,
	label: string,
): Promise<string> {
	const byteSize = await readVaultFileSize(ctx.app, filePath)
	if (ctx.providerId === 'anthropic' || ctx.providerId === 'bedrock') {
		if (mimeType === 'application/pdf' && byteSize > ANTHROPIC_PDF_MAX_BYTES) {
			throw new Error('PDF is too large for Claude (max 32 MB per request). Split the document and try again.')
		}
	}

	if (shouldUploadForProvider(ctx.providerId, byteSize)) {
		const binary = await ctx.app.vault.adapter.readBinary(filePath)
		const ext = getFileExtension(filePath, label)
		return uploadRef(undefined, binary, `ref.${ext}`, mimeType)
	}

	return readVaultFileAsDataUri(ctx.app, filePath, mimeType)
}

export async function prepareTextInputs(
	app: App,
	canvas: Canvas,
	node: CanvasNode,
	modelId: string,
	providerId: string,
	upstream: UpstreamInputs,
	apiModelId?: string,
): Promise<PreparedTextInputs> {
	const capability = getTextInputCapability(modelId, providerId, apiModelId)
	const ctx: PrepContext = { app, modelId, providerId, apiModelId }

	const refImages: string[] = []
	if (textInputKindSupported(capability, 'image')) {
		const imagePaths = getOrderedImages(canvas, node)
		for (const imgPath of imagePaths) {
			const ext = getFileExtension(imgPath, 'png')
			const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
			if (shouldUploadForProvider(providerId, await readVaultFileSize(app, imgPath))) {
				const binary = await app.vault.adapter.readBinary(imgPath)
				refImages.push(await uploadRef(undefined, binary, `ref.${ext}`, mime))
			} else {
				refImages.push(await readVaultFileAsDataUri(app, imgPath, mime))
			}
		}
	}

	const refPdfs: string[] = []
	if (textInputKindSupported(capability, 'pdf')) {
		for (const pdfPath of [...new Set(upstream.pdfs)]) {
			refPdfs.push(await prepareMediaRef(ctx, pdfPath, 'application/pdf', 'pdf'))
		}
	}

	const refVideos: string[] = []
	if (textInputKindSupported(capability, 'video')) {
		for (const videoPath of [...new Set(upstream.videos)]) {
			refVideos.push(await prepareMediaRef(ctx, videoPath, videoMimeType(videoPath), 'mp4'))
		}
	}

	const refAudios: string[] = []
	if (textInputKindSupported(capability, 'audio')) {
		for (const audioPath of [...new Set(upstream.audios)]) {
			refAudios.push(await prepareMediaRef(ctx, audioPath, audioMimeType(audioPath), 'mp3'))
		}
	}

	return { refImages, refPdfs, refVideos, refAudios }
}

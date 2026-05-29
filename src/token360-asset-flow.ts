import type BragiCanvas from './main'
import type { Canvas, CanvasNode } from './types/canvas-internal'
import {
	type Token360AssetCreds,
	getToken360Asset,
	isToken360AssetNotFound,
	uploadToken360Asset,
	waitForToken360AssetActive,
} from './providers/token360-assets'
import { imageMimeTypeFromFileName, prepareReferenceUpload } from './providers/image-upload-prep'

const PROVIDER_KEY = 'token360'

async function prepareUploadImage(filePath: string, bytes: ArrayBuffer): Promise<{ bytes: ArrayBuffer; mime: string; filename: string }> {
	const originalName = filePath.split('/').pop() || 'ref'
	const contentType = imageMimeTypeFromFileName(originalName)
	if (!contentType) throw new Error(`Token360 assets support image files only: ${originalName}`)
	const prepared = await prepareReferenceUpload(bytes, originalName, contentType, 'Token360 asset upload')
	return {
		bytes: prepared.bytes,
		mime: prepared.contentType,
		filename: prepared.fileName,
	}
}

function findNodeByPath(canvas: Canvas, filePath: string): CanvasNode | null {
	for (const node of canvas.nodes.values()) {
		const d = node.getData() as { type?: string; file?: string }
		if (d.type === 'file' && d.file === filePath) return node
	}
	return null
}

export function getToken360AssetCreds(plugin: BragiCanvas): Token360AssetCreds | null {
	const providers = plugin.settings.providers
	const apiKey = (providers.token360 || '').trim()
	const groupId = (providers.token360AssetGroupId || '').trim()
	if (!apiKey || !groupId) return null
	return { apiKey, groupId }
}

function getCachedAssetId(node: CanvasNode): string | null {
	const d = node.getData() as { bragiAssetIds?: Record<string, string> }
	return d.bragiAssetIds?.[PROVIDER_KEY] || null
}

function setCachedAssetId(node: CanvasNode, assetId: string): void {
	const d = node.getData() as { bragiAssetIds?: Record<string, string> }
	const map = { ...(d.bragiAssetIds || {}), [PROVIDER_KEY]: assetId }
	node.setData({ ...d, bragiAssetIds: map })
}

function clearCachedAssetId(node: CanvasNode): void {
	const d = node.getData() as { bragiAssetIds?: Record<string, string> }
	if (!d.bragiAssetIds) return
	const rest = { ...d.bragiAssetIds }
	delete rest[PROVIDER_KEY]
	node.setData({ ...d, bragiAssetIds: rest })
}

export async function ensureToken360Asset(
	plugin: BragiCanvas,
	canvas: Canvas,
	filePath: string,
	creds: Token360AssetCreds,
): Promise<string> {
	const binary = await plugin.app.vault.adapter.readBinary(filePath)
	const upload = await prepareUploadImage(filePath, binary)
	const node = findNodeByPath(canvas, filePath)

	if (node) {
		const cached = getCachedAssetId(node)
		if (cached) {
			try {
				const { status } = await getToken360Asset(creds, cached)
				if (status === 'Active') return `asset://${cached}`
				if (status === 'Processing') {
					await waitForToken360AssetActive(creds, cached)
					return `asset://${cached}`
				}
				clearCachedAssetId(node)
				if (status === 'Rejected') {
					throw new Error(`Reference image rejected by Token360 review: ${upload.filename}`)
				}
				if (status === 'Inactive') {
					throw new Error(`Reference image inactive in Token360: ${upload.filename}`)
				}
			} catch (err: unknown) {
				if (isToken360AssetNotFound(err)) {
					clearCachedAssetId(node)
				} else {
					throw err
				}
			}
		}
	}

	const assetId = await uploadToken360Asset(creds, upload.filename, upload.mime, upload.bytes)
	await waitForToken360AssetActive(creds, assetId)
	if (node) setCachedAssetId(node, assetId)
	return `asset://${assetId}`
}

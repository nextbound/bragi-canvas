import type BragiCanvas from './main'
import type { Canvas, CanvasNode } from './types/canvas-internal'
import { uploadRef } from './providers/upload'
import {
	BytePlusAssetCreds,
	createAsset,
	createAssetGroup,
	getAsset,
	isAssetNotFound,
	isGroupNotFound,
	waitForActive,
} from './providers/byteplus-assets'

const PROVIDER_KEY = 'byteplus'  // used inside node's bragiAssetIds map

function imageExtToMime(ext: string): string {
	return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
}

function audioExtToMime(ext: string): string {
	if (ext === 'wav') return 'audio/wav'
	if (ext === 'flac') return 'audio/flac'
	return 'audio/mpeg'
}

const IMAGE_EXTS = /\.(png|jpe?g|webp|gif)$/i

function findNodeByPath(canvas: Canvas, filePath: string): CanvasNode | null {
	for (const node of canvas.nodes.values()) {
		const d = node.getData() as unknown
		if (d.type === 'file' && d.file === filePath) return node
	}
	return null
}

/** Credentials for BytePlus asset library. null if not configured. */
export function getBytePlusAssetCreds(plugin: BragiCanvas): BytePlusAssetCreds | null {
	const p = plugin.settings.providers
	const ak = (p.byteplusAccessKey || '').trim()
	const sk = (p.byteplusSecretKey || '').trim()
	if (!ak || !sk) return null
	return {
		accessKey: ak,
		secretKey: sk,
		projectName: (p.byteplusProjectName || 'default').trim(),
	}
}


async function getOrCreateGroupId(canvas: Canvas, creds: BytePlusAssetCreds): Promise<string> {
	const data = canvas.getData() as unknown
	const existing = data?.bragi?.byteplusGroupId as string | undefined
	if (existing) return existing
	const groupId = await createAssetGroup(creds)
	const current = canvas.getData() as unknown
	canvas.importData({
		...current,
		bragi: { ...(current.bragi || {}), byteplusGroupId: groupId },
	})
	void canvas.requestSave()
	return groupId
}

/** Invalidate the canvas-level group id (e.g. after a group-not-found error). */
function clearGroupId(canvas: Canvas) {
	const current = canvas.getData() as unknown
	if (current?.bragi?.byteplusGroupId) {
		const rest = { ...current.bragi }
		delete rest.byteplusGroupId
		canvas.importData({ ...current, bragi: rest })
		void canvas.requestSave()
	}
}

function getCachedAssetId(node: CanvasNode): string | null {
	const d = node.getData() as unknown
	return d?.bragiAssetIds?.[PROVIDER_KEY] ?? null
}

function setCachedAssetId(node: CanvasNode, assetId: string) {
	const d = node.getData() as unknown
	const map = { ...(d.bragiAssetIds || {}), [PROVIDER_KEY]: assetId }
	node.setData({ ...d, bragiAssetIds: map })
}

function clearCachedAssetId(node: CanvasNode) {
	const d = node.getData() as unknown
	if (!d.bragiAssetIds) return
	const rest = { ...d.bragiAssetIds }
	delete rest[PROVIDER_KEY]
	node.setData({ ...d, bragiAssetIds: rest })
}

/**
 * Ensure the given local image is available as an `asset://...` URI.
 * Uses per-node + per-canvas caches, with pre-validation via GetAsset.
 *
 * Throws on Rejected / Failed / timeout / fatal errors — caller should propagate
 * to fail the whole video generation task.
 */
export async function ensureBytePlusAsset(
	plugin: BragiCanvas,
	canvas: Canvas,
	filePath: string,
	creds: BytePlusAssetCreds,
): Promise<string> {
	const isImage = IMAGE_EXTS.test(filePath)
	const assetType: 'Image' | 'Audio' = isImage ? 'Image' : 'Audio'
	const ext = (filePath.split('.').pop() || (isImage ? 'png' : 'mp3')).toLowerCase()
	const mime = isImage ? imageExtToMime(ext) : audioExtToMime(ext)
	const node = findNodeByPath(canvas, filePath)

	// 1. Check cache + pre-validate
	if (node) {
		const cached = getCachedAssetId(node)
		if (cached) {
			try {
				const { status } = await getAsset(creds, cached)
				if (status === 'Active') return `asset://${cached}`
				if (status === 'Rejected') {
					throw new Error(`Reference ${assetType.toLowerCase()} rejected by BytePlus content review: ${filePath.split('/').pop()}`)
				}
				if (status === 'Failed') {
					clearCachedAssetId(node)
				} else if (status === 'Processing') {
					await waitForActive(creds, cached)
					return `asset://${cached}`
				} else {
					clearCachedAssetId(node)
				}
			} catch (err: unknown) {
				if (isAssetNotFound(err)) {
					clearCachedAssetId(node)
				} else {
					throw err
				}
			}
		}
	}

	// 2. Upload to Bragi Relay so BytePlus can fetch
	const adapter = plugin.app.vault.adapter
	const binary = await adapter.readBinary(filePath)
	const url = await uploadRef(undefined, binary, `ref.${ext}`, mime)

	// 3. Create the asset (retry once if group was missing)
	let groupId = await getOrCreateGroupId(canvas, creds)
	let assetId: string
	try {
		assetId = await createAsset(creds, groupId, url, assetType)
	} catch (err: unknown) {
		if (isGroupNotFound(err)) {
			clearGroupId(canvas)
			groupId = await getOrCreateGroupId(canvas, creds)
			assetId = await createAsset(creds, groupId, url, assetType)
		} else {
			throw err
		}
	}

	// 4. Poll until Active
	await waitForActive(creds, assetId)

	// 5. Cache on the node (if we have one)
	if (node) setCachedAssetId(node, assetId)

	return `asset://${assetId}`
}

/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import type BragiCanvas from './main'
import type { Canvas, CanvasNode } from './types/canvas-internal'
import { uploadRef } from './providers/upload'
import {
	BytePlusAssetCreds,
	createAsset,
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

function videoExtToMime(ext: string): string {
	if (ext === 'mov') return 'video/quicktime'
	return 'video/mp4'
}

const IMAGE_EXTS = /\.(png|jpe?g|webp|gif)$/i
const AUDIO_EXTS = /\.(mp3|wav|flac)$/i
const VIDEO_EXTS = /\.(mp4|mov)$/i

type BytePlusAssetType = 'Image' | 'Audio' | 'Video'

function getAssetFileInfo(filePath: string): { assetType: BytePlusAssetType; ext: string; mime: string } {
	const ext = (filePath.split('.').pop() || '').toLowerCase()
	if (IMAGE_EXTS.test(filePath)) {
		return { assetType: 'Image', ext: ext || 'png', mime: imageExtToMime(ext || 'png') }
	}
	if (AUDIO_EXTS.test(filePath)) {
		return { assetType: 'Audio', ext: ext || 'mp3', mime: audioExtToMime(ext || 'mp3') }
	}
	if (VIDEO_EXTS.test(filePath)) {
		return { assetType: 'Video', ext: ext || 'mp4', mime: videoExtToMime(ext || 'mp4') }
	}
	throw new Error(`BytePlus assets support image, audio, MP4, or MOV files only: ${filePath.split('/').pop() || filePath}`)
}

function findNodeByPath(canvas: Canvas, filePath: string): CanvasNode | null {
	for (const node of canvas.nodes.values()) {
		const d = node.getData() as unknown
		if (d.type === 'file' && d.file === filePath) return node
	}
	return null
}

/**
 * Credentials for BytePlus asset library. null if not configured.
 * Requires AK/SK *and* an asset group id — without a group id we fall back to
 * passing the plain URL to Seedance (no asset library, no face support), matching
 * the TokenRouter / Token360 behaviour. We never auto-create asset groups, since
 * each project has a cap on group count.
 */
export function getBytePlusAssetCreds(plugin: BragiCanvas): BytePlusAssetCreds | null {
	const p = plugin.settings.providers
	const ak = (p.byteplusAccessKey || '').trim()
	const sk = (p.byteplusSecretKey || '').trim()
	const groupId = (p.byteplusAssetGroupId || '').trim()
	if (!ak || !sk || !groupId) return null
	return { accessKey: ak, secretKey: sk, groupId }
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
 * Ensure the given local media file is available as an `asset://...` URI.
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
	const { assetType, ext, mime } = getAssetFileInfo(filePath)
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

	// 2. Upload to Bragi temporary storage so BytePlus can fetch
	const adapter = plugin.app.vault.adapter
	const binary = await adapter.readBinary(filePath)
	const url = await uploadRef(undefined, binary, `ref.${ext}`, mime)

	// 3. Create the asset under the configured group
	let assetId: string
	try {
		assetId = await createAsset(creds, creds.groupId, url, assetType)
	} catch (err: unknown) {
		if (isGroupNotFound(err)) {
			throw new Error(
				`BytePlus asset group not found or inaccessible: ${creds.groupId}. Check the BytePlus "Asset group ID" in provider settings, or switch the Seedance provider.`,
			)
		}
		throw err
	}

	// 4. Poll until Active
	await waitForActive(creds, assetId)

	// 5. Cache on the node (if we have one)
	if (node) setCachedAssetId(node, assetId)

	return `asset://${assetId}`
}

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Resume strict linting after the runtime-shaped data boundary. */

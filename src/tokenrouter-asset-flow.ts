/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this flow narrows at use sites. */
import type BragiCanvas from './main'
import type { Canvas, CanvasNode } from './types/canvas-internal'
import { uploadRef } from './providers/upload'
import {
	createModelArkAsset,
	createModelArkAssetGroup,
	getModelArkAsset,
	isModelArkAssetNotFound,
	isModelArkGroupNotFound,
	waitForModelArkAssetActive,
} from './providers/tokenrouter-modelark-assets'
import type { TokenRouterModelArkCreds } from './providers/tokenrouter-modelark-assets'

const PROVIDER_KEY = 'tokenrouter'
const GROUP_ID_KEY = 'tokenrouterModelArkGroupId'
const groupCreateInFlightByCanvas = new WeakMap<Canvas, Promise<string>>()

type TokenRouterModelArkAssetType = 'Image' | 'Audio' | 'Video'

function imageExtToMime(ext: string): string {
	if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
	if (ext === 'tif' || ext === 'tiff') return 'image/tiff'
	if (ext === 'heic') return 'image/heic'
	if (ext === 'heif') return 'image/heif'
	if (ext === 'bmp') return 'image/bmp'
	if (ext === 'gif') return 'image/gif'
	if (ext === 'webp') return 'image/webp'
	return 'image/png'
}

function audioExtToMime(ext: string): string {
	if (ext === 'wav') return 'audio/wav'
	return 'audio/mpeg'
}

function videoExtToMime(ext: string): string {
	if (ext === 'mov') return 'video/quicktime'
	return 'video/mp4'
}

const IMAGE_EXTS = /\.(png|jpe?g|webp|bmp|tiff?|gif|heic|heif)$/i
const AUDIO_EXTS = /\.(mp3|wav)$/i
const VIDEO_EXTS = /\.(mp4|mov)$/i

function getAssetFileInfo(filePath: string): { assetType: TokenRouterModelArkAssetType; ext: string; mime: string } {
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
	throw new Error(`TokenRouter ModelArk supports images, MP3/WAV audio, MP4, or MOV files only: ${filePath.split('/').pop() || filePath}`)
}

function findNodeByPath(canvas: Canvas, filePath: string): CanvasNode | null {
	for (const node of canvas.nodes.values()) {
		const d = node.getData() as { type?: string; file?: string }
		if (d.type === 'file' && d.file === filePath) return node
	}
	return null
}

export function getTokenRouterModelArkCreds(plugin: BragiCanvas): TokenRouterModelArkCreds | null {
	const apiKey = (plugin.settings.providers.tokenrouter || '').trim()
	const groupId = (plugin.settings.providers.tokenrouterModelArkAssetGroupId || '').trim()
	return apiKey ? { apiKey, ...(groupId ? { groupId } : {}) } : null
}

function isSharedGroupConfigured(creds: TokenRouterModelArkCreds): boolean {
	return !!creds.groupId?.trim()
}

function configuredGroupId(creds: TokenRouterModelArkCreds): string | null {
	const groupId = creds.groupId?.trim()
	return groupId || null
}

function getCachedGroupId(canvas: Canvas): string | null {
	const data = canvas.getData() as { bragi?: Record<string, unknown> }
	const existing = data.bragi?.[GROUP_ID_KEY]
	return typeof existing === 'string' && existing ? existing : null
}

async function createAndCacheGroupId(canvas: Canvas, creds: TokenRouterModelArkCreds): Promise<string> {
	const groupId = await createModelArkAssetGroup(creds)
	const current = canvas.getData() as { bragi?: Record<string, unknown> }
	canvas.importData({
		...current,
		bragi: { ...(current.bragi || {}), [GROUP_ID_KEY]: groupId },
	} as unknown as Parameters<Canvas['importData']>[0])
	void canvas.requestSave()
	return groupId
}

async function getOrCreateGroupId(canvas: Canvas, creds: TokenRouterModelArkCreds): Promise<string> {
	// A shared group is only the ModelArk upload container. The generation payload
	// still uses only the explicit asset ids collected from the current canvas edges.
	const sharedGroupId = configuredGroupId(creds)
	if (sharedGroupId) return sharedGroupId

	const existing = getCachedGroupId(canvas)
	if (existing) return existing

	const inFlight = groupCreateInFlightByCanvas.get(canvas)
	if (inFlight) return inFlight

	let createPromise: Promise<string>
	createPromise = createAndCacheGroupId(canvas, creds).finally(() => {
		if (groupCreateInFlightByCanvas.get(canvas) === createPromise) groupCreateInFlightByCanvas.delete(canvas)
	})
	groupCreateInFlightByCanvas.set(canvas, createPromise)
	return createPromise
}

function clearGroupId(canvas: Canvas): void {
	const current = canvas.getData() as { bragi?: Record<string, unknown> }
	if (!current.bragi?.[GROUP_ID_KEY]) return
	const rest = { ...current.bragi }
	delete rest[GROUP_ID_KEY]
	canvas.importData({ ...current, bragi: rest } as unknown as Parameters<Canvas['importData']>[0])
	void canvas.requestSave()
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

export async function ensureTokenRouterModelArkAsset(
	plugin: BragiCanvas,
	canvas: Canvas,
	filePath: string,
	creds: TokenRouterModelArkCreds,
): Promise<string> {
	const { assetType, ext, mime } = getAssetFileInfo(filePath)
	const node = findNodeByPath(canvas, filePath)

	if (node) {
		const cached = getCachedAssetId(node)
		if (cached) {
			try {
				const { status } = await getModelArkAsset(creds, cached)
				if (status === 'Active') return `asset://${cached}`
				if (status === 'Rejected') {
					throw new Error(`Reference ${assetType.toLowerCase()} rejected by TokenRouter ModelArk review: ${filePath.split('/').pop()}`)
				}
				if (status === 'Failed') {
					clearCachedAssetId(node)
				} else if (status === 'Processing') {
					await waitForModelArkAssetActive(creds, cached)
					return `asset://${cached}`
				} else {
					clearCachedAssetId(node)
				}
			} catch (err: unknown) {
				if (isModelArkAssetNotFound(err)) {
					clearCachedAssetId(node)
				} else {
					throw err
				}
			}
		}
	}

	const adapter = plugin.app.vault.adapter
	const binary = await adapter.readBinary(filePath)
	const url = await uploadRef(undefined, binary, `ref.${ext}`, mime)

	let groupId = await getOrCreateGroupId(canvas, creds)
	let assetId: string
	try {
		assetId = await createModelArkAsset(creds, groupId, url, assetType)
	} catch (err: unknown) {
		if (isModelArkGroupNotFound(err)) {
			if (isSharedGroupConfigured(creds)) {
				throw new Error(
					`TokenRouter ModelArk shared asset group not found or inaccessible: ${creds.groupId}. Check the TokenRouter provider settings, switch Seedance provider, or ask TokenRouter to restore or create the group.`,
				)
			}
			clearGroupId(canvas)
			groupId = await getOrCreateGroupId(canvas, creds)
			assetId = await createModelArkAsset(creds, groupId, url, assetType)
		} else {
			throw err
		}
	}

	await waitForModelArkAssetActive(creds, assetId)
	if (node) setCachedAssetId(node, assetId)

	return `asset://${assetId}`
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the TokenRouter ModelArk asset flow. */

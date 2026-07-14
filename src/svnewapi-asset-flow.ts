import type BragiCanvas from './main'
import type { Canvas, CanvasNode } from './types/canvas-internal'
import { requestUrl } from 'obsidian'
import { uploadRef } from './providers/upload'
import { SVROUTER_BASE_URL } from './providers/svnewapi'

// SV NewAPI (new-api gateway) asset-library flow. Unlike the direct byteplus /
// tokenrouter / token360 flows which call the provider's asset API themselves, this
// registers reference media through the gateway's POST /v1/assets endpoint, so the
// BytePlus AK/SK stay in the gateway and the asset is created in the same account that
// will serve generation. The asset_id is cached on the canvas node (keyed by
// 'svnewapi'). See new-api: relay/channel/task/SEEDANCE_ASSET_PROXY_WIP.md.

const PROVIDER_KEY = 'svnewapi'
const POLL_INTERVAL_MS = 4000
const POLL_TIMEOUT_MS = 300000 // 5 minutes

const IMAGE_EXTS = /\.(png|jpe?g|webp|gif)$/i
const AUDIO_EXTS = /\.(mp3|wav|flac)$/i
const VIDEO_EXTS = /\.(mp4|mov)$/i

type AssetType = 'Image' | 'Audio' | 'Video'
type JsonRecord = Record<string, unknown>

export interface SvNewApiAssetCreds {
	baseUrl: string
	apiKey: string
}

// Thrown when the gateway/channel does not support asset registration (HTTP 501).
// The caller may fall back to sending the public reference URL.
export class SvNewApiAssetUnsupportedError extends Error {}

function asRecord(value: unknown): JsonRecord | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function stringValue(value: unknown, fallback = ''): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	return fallback
}

function gatewayErrorMessage(json: unknown, text: string, fallback: string): string {
	const body = asRecord(json)
	const error = asRecord(body?.error)
	return stringValue(error?.message || body?.error || body?.message || text.substring(0, 200), fallback)
}

function assetFailedReason(body: JsonRecord | null): string {
	const result = asRecord(body?.Result) || asRecord(body?.result)
	const error = asRecord(result?.Error) || asRecord(result?.error) || asRecord(body?.Error) || asRecord(body?.error)
	return stringValue(
		body?.failed_reason ||
		body?.failedReason ||
		body?.FailedReason ||
		result?.FailedReason ||
		result?.failed_reason ||
		result?.failedReason ||
		error?.Message ||
		error?.message ||
		error?.Code ||
		error?.code,
		'',
	)
}

export function getSvNewApiAssetCreds(plugin: BragiCanvas): SvNewApiAssetCreds | null {
	const apiKey = (plugin.settings.providers.svnewapi || '').trim()
	if (!apiKey) return null
	return { baseUrl: SVROUTER_BASE_URL, apiKey }
}

function assetFileInfo(filePath: string): { assetType: AssetType; ext: string; mime: string } {
	const ext = (filePath.split('.').pop() || '').toLowerCase()
	if (IMAGE_EXTS.test(filePath)) {
		return { assetType: 'Image', ext: ext || 'png', mime: ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext || 'png'}` }
	}
	if (AUDIO_EXTS.test(filePath)) {
		return { assetType: 'Audio', ext: ext || 'mp3', mime: ext === 'wav' ? 'audio/wav' : ext === 'flac' ? 'audio/flac' : 'audio/mpeg' }
	}
	if (VIDEO_EXTS.test(filePath)) {
		return { assetType: 'Video', ext: ext || 'mp4', mime: ext === 'mov' ? 'video/quicktime' : 'video/mp4' }
	}
	throw new Error(`SV NewAPI assets support image, audio, MP4, or MOV files only: ${filePath.split('/').pop() || filePath}`)
}

function findNodeByPath(canvas: Canvas, filePath: string): CanvasNode | null {
	for (const node of canvas.nodes.values()) {
		const d = node.getData() as { type?: string; file?: string }
		if (d.type === 'file' && d.file === filePath) return node
	}
	return null
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

interface GatewayResp {
	status: number
	json: unknown
	text: string
}

async function postJson(creds: SvNewApiAssetCreds, path: string, body: unknown): Promise<GatewayResp> {
	const resp = await requestUrl({
		url: `${creds.baseUrl}${path}`,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${creds.apiKey}`,
		},
		body: JSON.stringify(body),
		throw: false,
	})
	return { status: resp.status, json: resp.json, text: resp.text }
}

async function createGatewayAsset(creds: SvNewApiAssetCreds, model: string, url: string, assetType: AssetType): Promise<{ id: string; status: string }> {
	const r = await postJson(creds, '/v1/assets', { model, url, asset_type: assetType })
	if (r.status === 501) {
		throw new SvNewApiAssetUnsupportedError('gateway/channel does not support asset registration')
	}
	if (r.status < 200 || r.status >= 300) {
		throw new Error(`SV NewAPI asset register failed: ${gatewayErrorMessage(r.json, r.text, `HTTP ${r.status}`)}`)
	}
	const body = asRecord(r.json)
	const id = stringValue(body?.id, '')
	if (!id) throw new Error('SV NewAPI asset register: no id in response')
	return { id, status: stringValue(body?.status, 'Processing') }
}

async function getGatewayAssetStatus(creds: SvNewApiAssetCreds, model: string, id: string): Promise<{ status: string; failedReason?: string }> {
	const r = await postJson(creds, '/v1/assets/status', { model, id })
	if (r.status < 200 || r.status >= 300) {
		throw new Error(`SV NewAPI asset status failed: ${gatewayErrorMessage(r.json, r.text, `HTTP ${r.status}`)}`)
	}
	const body = asRecord(r.json)
	const failedReason = assetFailedReason(body)
	return { status: stringValue(body?.status, 'Unknown'), failedReason: failedReason || undefined }
}

async function waitForActive(creds: SvNewApiAssetCreds, model: string, id: string): Promise<void> {
	const deadline = Date.now() + POLL_TIMEOUT_MS
	while (Date.now() < deadline) {
		const { status, failedReason } = await getGatewayAssetStatus(creds, model, id)
		if (status === 'Active') return
		if (status === 'Rejected') throw new Error(`Reference rejected by content review${failedReason ? ': ' + failedReason : ''}`)
		if (status === 'Failed') throw new Error(`Reference asset failed${failedReason ? ': ' + failedReason : ''}`)
		await new Promise(r => window.setTimeout(r, POLL_INTERVAL_MS))
	}
	throw new Error(`SV NewAPI asset timed out after ${POLL_TIMEOUT_MS / 1000}s`)
}

/**
 * Ensure the given local media file is registered in the gateway's asset library and
 * return an `asset://<id>` URI. Uses a per-node cache (validated via the status
 * endpoint). Throws SvNewApiAssetUnsupportedError if the gateway can't register assets
 * (so the caller can fall back to a plain URL); throws on Rejected/Failed/timeout.
 */
export async function ensureSvNewApiAsset(
	plugin: BragiCanvas,
	canvas: Canvas,
	filePath: string,
	model: string,
	creds: SvNewApiAssetCreds,
): Promise<string> {
	const { assetType, ext, mime } = assetFileInfo(filePath)
	const node = findNodeByPath(canvas, filePath)

	// 1. Cache + validate
	if (node) {
		const cached = getCachedAssetId(node)
		if (cached) {
			try {
				const { status } = await getGatewayAssetStatus(creds, model, cached)
				if (status === 'Active') return `asset://${cached}`
				if (status === 'Processing') {
					await waitForActive(creds, model, cached)
					return `asset://${cached}`
				}
				clearCachedAssetId(node) // Rejected / Failed / Unknown → re-register
			} catch {
				clearCachedAssetId(node) // not found / transient → re-register
			}
		}
	}

	// 2. Upload to Bragi temp storage so the gateway (and upstream) can fetch it
	const binary = await plugin.app.vault.adapter.readBinary(filePath)
	const publicUrl = await uploadRef(undefined, binary, `ref.${ext}`, mime)

	// 3. Register via the gateway and poll to Active
	const { id, status } = await createGatewayAsset(creds, model, publicUrl, assetType)
	if (status !== 'Active') {
		await waitForActive(creds, model, id)
	}
	if (node) setCachedAssetId(node, id)
	return `asset://${id}`
}

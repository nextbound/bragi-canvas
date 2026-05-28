import { requestUrl } from 'obsidian'

const BASE_URL = 'https://api.token360.ai/v1'
const POLL_INTERVAL_MS = 5000
const POLL_TIMEOUT_MS = 300000

type JsonRecord = Record<string, unknown>

export interface Token360AssetCreds {
	apiKey: string
	groupId: string
}

export interface Token360AssetGetResult {
	status: 'Active' | 'Processing' | 'Failed' | 'Rejected' | 'Inactive' | 'Unknown'
	raw: JsonRecord
}

function asRecord(value: unknown): JsonRecord | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null
}

function stringValue(value: unknown, fallback = ''): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	return fallback
}

function randomHex(n: number): string {
	const bytes = new Uint8Array(n)
	crypto.getRandomValues(bytes)
	return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function appendMultipartField(parts: Uint8Array[], boundary: string, name: string, value: string): void {
	const enc = new TextEncoder()
	parts.push(enc.encode(`--${boundary}\r\n`))
	parts.push(enc.encode(`Content-Disposition: form-data; name="${name}"\r\n\r\n`))
	parts.push(enc.encode(value))
	parts.push(enc.encode('\r\n'))
}

function appendMultipartFile(parts: Uint8Array[], boundary: string, name: string, filename: string, mime: string, bytes: Uint8Array): void {
	const enc = new TextEncoder()
	parts.push(enc.encode(`--${boundary}\r\n`))
	parts.push(enc.encode(`Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n`))
	parts.push(enc.encode(`Content-Type: ${mime}\r\n\r\n`))
	parts.push(bytes)
	parts.push(enc.encode('\r\n'))
}

function concatBytes(parts: Uint8Array[]): ArrayBuffer {
	let total = 0
	for (const part of parts) total += part.length
	const body = new Uint8Array(total)
	let offset = 0
	for (const part of parts) {
		body.set(part, offset)
		offset += part.length
	}
	return body.buffer
}

function parseBody(resp: { text?: string; json?: unknown }): JsonRecord | null {
	return asRecord(resp.json) || (() => {
		try { return asRecord(JSON.parse(resp.text || '')) } catch { return null }
	})()
}

function extractError(resp: { status: number; text?: string; json?: unknown }): string {
	const body = parseBody(resp)
	const error = asRecord(body?.error)
	const msg = stringValue(error?.message || body?.message || body?.error || resp.text, `HTTP ${resp.status}`)
	const code = stringValue(error?.code || error?.type || body?.code, '')
	return `${code ? code + ' - ' : ''}${msg}`
}

function makeError(message: string, status?: number): Error & { status?: number; code?: string } {
	const err = new Error(message) as Error & { status?: number; code?: string }
	err.status = status
	return err
}

function normalizeStatus(value: unknown): Token360AssetGetResult['status'] {
	const normalized = stringValue(value, 'Unknown').trim().toLowerCase()
	if (normalized === 'active' || normalized === 'success' || normalized === 'completed') return 'Active'
	if (normalized === 'processing' || normalized === 'pending' || normalized === 'queued' || normalized === 'in_progress') return 'Processing'
	if (normalized === 'failed' || normalized === 'failure' || normalized === 'error') return 'Failed'
	if (normalized === 'rejected') return 'Rejected'
	if (normalized === 'inactive' || normalized === 'disabled') return 'Inactive'
	return 'Unknown'
}

function extractAssetId(data: JsonRecord): string {
	const nestedData = asRecord(data.data)
	const result = asRecord(data.result) || asRecord(data.Result)
	const source = nestedData || result || data
	return stringValue(
		source.assetId ||
		source.token360AssetId ||
		source.AssetId ||
		source.Id ||
		source.id,
		'',
	)
}

export async function uploadToken360Asset(
	creds: Token360AssetCreds,
	fileName: string,
	mimeType: string,
	bytes: ArrayBuffer,
): Promise<string> {
	const boundary = '----BragiToken360AssetBoundary' + Math.random().toString(36).slice(2)
	const parts: Uint8Array[] = []
	appendMultipartFile(parts, boundary, 'file', fileName, mimeType, new Uint8Array(bytes))
	appendMultipartField(parts, boundary, 'name', fileName || `bragi_${randomHex(6)}`)
	appendMultipartField(parts, boundary, 'groupId', creds.groupId)
	parts.push(new TextEncoder().encode(`--${boundary}--\r\n`))

	const resp = await requestUrl({
		url: `${BASE_URL}/assets`,
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${creds.apiKey}`,
			'Content-Type': `multipart/form-data; boundary=${boundary}`,
		},
		body: concatBytes(parts),
		throw: false,
	})
	if (resp.status < 200 || resp.status >= 300) {
		throw makeError(`Token360 Upload Asset: ${extractError(resp)}`, resp.status)
	}

	const body = parseBody(resp) || {}
	const assetId = extractAssetId(body)
	if (!assetId) throw new Error('Token360 Upload Asset: no assetId in response')
	return assetId
}

export async function getToken360Asset(creds: Token360AssetCreds, assetId: string): Promise<Token360AssetGetResult> {
	const resp = await requestUrl({
		url: `${BASE_URL}/assets/${encodeURIComponent(assetId)}`,
		method: 'GET',
		headers: { 'Authorization': `Bearer ${creds.apiKey}` },
		throw: false,
	})
	if (resp.status < 200 || resp.status >= 300) {
		throw makeError(`Token360 Get Asset: ${extractError(resp)}`, resp.status)
	}

	const body = parseBody(resp) || {}
	const nestedData = asRecord(body.data)
	const result = asRecord(body.result) || asRecord(body.Result)
	const source = nestedData || result || body
	return {
		status: normalizeStatus(source.status || source.Status || source.assetStatus || source.state),
		raw: source,
	}
}

export function isToken360AssetNotFound(err: unknown): boolean {
	const e = err as { message?: string; status?: number; code?: string }
	return e.status === 404 || /NotFound|NoSuchAsset|InvalidAsset|AssetNotExist|not\s+found/i.test(e.code || e.message || '')
}

export async function waitForToken360AssetActive(creds: Token360AssetCreds, assetId: string): Promise<void> {
	const deadline = Date.now() + POLL_TIMEOUT_MS
	while (Date.now() < deadline) {
		const { status, raw } = await getToken360Asset(creds, assetId)
		if (status === 'Active') return
		if (status === 'Rejected') {
			throw new Error(`Token360 asset rejected. ${stringValue(raw.reason || raw.message || raw.error, '')}`.trim())
		}
		if (status === 'Failed') {
			throw new Error(`Token360 asset failed. ${stringValue(raw.reason || raw.message || raw.error, '')}`.trim())
		}
		if (status === 'Inactive') {
			throw new Error(`Token360 asset inactive. ${stringValue(raw.reason || raw.message || raw.error, '')}`.trim())
		}
		await new Promise(r => window.setTimeout(r, POLL_INTERVAL_MS))
	}
	throw new Error(`Token360 asset timed out after ${POLL_TIMEOUT_MS / 1000}s`)
}

/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- TokenRouter ModelArk responses are runtime-shaped and normalized at this provider boundary. */
import { requestUrl } from 'obsidian'

const BASE_URL = 'https://api.tokenrouter.com/thirdparty/modelark'
const POLL_INTERVAL_MS = 5000
const POLL_TIMEOUT_MS = 300000

type JsonRecord = Record<string, unknown>

export interface TokenRouterModelArkCreds {
	apiKey: string
	groupId?: string
}

export interface ModelArkAssetGetResult {
	status: 'Active' | 'Processing' | 'Failed' | 'Rejected' | 'Unknown'
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

function makeError(message: string, status?: number): Error & { status?: number; code?: string } {
	const err = new Error(message) as Error & { status?: number; code?: string }
	err.status = status
	return err
}

function isAssetGroupQuotaMessage(message: string): boolean {
	return /maximum\s+limit.*groups|number\s+of\s+groups.*create|asset\s+group.*quota/i.test(message)
}

async function callModelArk(
	creds: TokenRouterModelArkCreds,
	method: 'GET' | 'POST' | 'PUT' | 'DELETE',
	path: string,
	body?: unknown,
): Promise<JsonRecord> {
	const resp = await requestUrl({
		url: `${BASE_URL}${path}`,
		method,
		headers: {
			'Authorization': `Bearer ${creds.apiKey}`,
			'Content-Type': 'application/json',
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		throw: false,
	})

	const parsed = asRecord(resp.json) || (() => {
		try { return asRecord(JSON.parse(resp.text || '')) } catch { return null }
	})()
	const success = parsed?.success
	if (resp.status < 200 || resp.status >= 300 || success === false) {
		const msg = stringValue(parsed?.message || parsed?.error || resp.text, `HTTP ${resp.status}`)
		if (method === 'POST' && path === '/asset-groups' && isAssetGroupQuotaMessage(msg)) {
			throw makeError(
				`TokenRouter ModelArk asset group quota reached. Configure a shared ModelArk asset group ID, switch Seedance provider, or ask TokenRouter to delete or raise asset groups. Original: ${msg}`,
				resp.status,
			)
		}
		throw makeError(`TokenRouter ModelArk ${method} ${path}: ${msg}`, resp.status)
	}
	return asRecord(parsed?.data) || parsed || {}
}

export async function createModelArkAssetGroup(creds: TokenRouterModelArkCreds): Promise<string> {
	const result = await callModelArk(creds, 'POST', '/asset-groups', {
		Name: `bragi_${randomHex(8)}`,
		Description: 'Bragi Canvas',
		GroupType: 'AIGC',
	})
	const groupId = stringValue(result.Id || result.id, '')
	if (!groupId) throw new Error('TokenRouter ModelArk CreateAssetGroup: no Id in response')
	return groupId
}

export async function createModelArkAsset(
	creds: TokenRouterModelArkCreds,
	groupId: string,
	url: string,
	assetType: 'Image' | 'Audio' | 'Video' = 'Image',
): Promise<string> {
	const result = await callModelArk(creds, 'POST', '/assets', {
		GroupId: groupId,
		URL: url,
		AssetType: assetType,
		Name: `bragi_${randomHex(6)}`,
	})
	const assetId = stringValue(result.Id || result.id, '')
	if (!assetId) throw new Error('TokenRouter ModelArk CreateAsset: no Id in response')
	return assetId
}

export async function getModelArkAsset(creds: TokenRouterModelArkCreds, assetId: string): Promise<ModelArkAssetGetResult> {
	const result = await callModelArk(creds, 'GET', `/assets/${encodeURIComponent(assetId)}`)
	const status = stringValue(result.Status || result.status || result.asset_state, 'Unknown') as ModelArkAssetGetResult['status']
	return { status, raw: result }
}

export function isModelArkAssetNotFound(err: unknown): boolean {
	const e = err as { message?: string; status?: number; code?: string }
	return e.status === 404 || /NotFound|NoSuchAsset|InvalidAsset|AssetNotExist|not\s+found/i.test(e.code || e.message || '')
}

export function isModelArkGroupNotFound(err: unknown): boolean {
	const e = err as { message?: string; status?: number; code?: string }
	return e.status === 404 || /NotFound|NoSuchGroup|InvalidGroup|GroupNotExist|not\s+found/i.test(e.code || e.message || '')
}

export async function waitForModelArkAssetActive(creds: TokenRouterModelArkCreds, assetId: string): Promise<void> {
	const deadline = Date.now() + POLL_TIMEOUT_MS
	while (Date.now() < deadline) {
		const { status, raw } = await getModelArkAsset(creds, assetId)
		if (status === 'Active') return
		if (status === 'Rejected') {
			throw new Error(`TokenRouter ModelArk asset rejected. ${stringValue(raw.Error || raw.error || raw.FailedReason, '')}`.trim())
		}
		if (status === 'Failed') {
			throw new Error(`TokenRouter ModelArk asset failed. ${stringValue(raw.Error || raw.error || raw.FailedReason, '')}`.trim())
		}
		await new Promise(r => window.setTimeout(r, POLL_INTERVAL_MS))
	}
	throw new Error(`TokenRouter ModelArk asset timed out after ${POLL_TIMEOUT_MS / 1000}s`)
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- Resume strict linting after the TokenRouter ModelArk provider boundary. */

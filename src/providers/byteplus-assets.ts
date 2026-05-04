import { requestUrl } from 'obsidian'
import { signVolcRequest } from './volcengine-sig'

// BytePlus Asset Library API — used by Seedance when the reference image
// contains a real human face (live_action requires uploading via asset://).

const REGION = 'ap-southeast-1'
const SERVICE = 'ark'
const VERSION = '2024-01-01'
const POLL_INTERVAL_MS = 5000
const POLL_TIMEOUT_MS = 300000  // 5 minutes

export interface BytePlusAssetCreds {
	accessKey: string
	secretKey: string
	projectName: string
}

export interface AssetGetResult {
	status: 'Active' | 'Processing' | 'Failed' | 'Rejected' | 'Unknown'
	raw: any
}

function randomHex(n: number): string {
	const bytes = new Uint8Array(n)
	crypto.getRandomValues(bytes)
	return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

async function callUniversal(creds: BytePlusAssetCreds, action: string, body: any): Promise<any> {
	const bodyStr = JSON.stringify(body)
	const signed = await signVolcRequest({
		accessKey: creds.accessKey,
		secretKey: creds.secretKey,
		region: REGION,
		service: SERVICE,
		action,
		version: VERSION,
		body: bodyStr,
	})
	const resp = await requestUrl({
		url: signed.url,
		method: 'POST',
		headers: signed.headers,
		body: signed.body,
		throw: false,
	})
	const json = resp.json
	const error = json?.ResponseMetadata?.Error
	if (error) {
		const err: any = new Error(`BytePlus ${action}: ${error.Code} — ${error.Message}`)
		err.code = error.Code
		err.codeN = error.CodeN
		err.status = resp.status
		throw err
	}
	if (resp.status < 200 || resp.status >= 300) {
		throw new Error(`BytePlus ${action}: HTTP ${resp.status} — ${resp.text?.substring(0, 200) || ''}`)
	}
	return json?.Result ?? json
}

/** Create a new asset group. Returns the GroupId. */
export async function createAssetGroup(creds: BytePlusAssetCreds): Promise<string> {
	const name = randomHex(8)
	const result = await callUniversal(creds, 'CreateAssetGroup', {
		Name: name,
		Description: 'Bragi Canvas',
		ProjectName: creds.projectName || 'default',
	})
	const groupId = result.Id
	if (!groupId) throw new Error(`BytePlus CreateAssetGroup: no Id in response`)
	return groupId
}

/** Create an asset under a group. Returns the AssetId. */
export async function createAsset(
	creds: BytePlusAssetCreds,
	groupId: string,
	url: string,
	assetType: 'Image' | 'Audio' | 'Video' = 'Image',
): Promise<string> {
	const name = randomHex(6)
	const result = await callUniversal(creds, 'CreateAsset', {
		GroupId: groupId,
		URL: url,
		AssetType: assetType,
		Name: name,
		ProjectName: creds.projectName || 'default',
	})
	const assetId = result.Id
	if (!assetId) throw new Error(`BytePlus CreateAsset: no Id in response`)
	return assetId
}

/** Get an asset's current status. */
export async function getAsset(creds: BytePlusAssetCreds, assetId: string): Promise<AssetGetResult> {
	const result = await callUniversal(creds, 'GetAsset', {
		Id: assetId,
		ProjectName: creds.projectName || 'default',
	})
	const status = (result.Status || 'Unknown') as AssetGetResult['status']
	return { status, raw: result }
}

/** Is this error from GetAsset indicating the asset doesn't exist (e.g. wrong account, deleted)? */
export function isAssetNotFound(err: any): boolean {
	const code = err?.code || ''
	return /NotFound|NoSuchAsset|InvalidAsset|AssetNotExist/i.test(code)
}

/** Is this error from CreateAsset indicating the group doesn't exist? */
export function isGroupNotFound(err: any): boolean {
	const code = err?.code || ''
	return /NotFound|NoSuchGroup|InvalidGroup|GroupNotExist/i.test(code)
}

/** Poll GetAsset until it becomes Active or terminal. */
export async function waitForActive(creds: BytePlusAssetCreds, assetId: string): Promise<void> {
	const deadline = Date.now() + POLL_TIMEOUT_MS
	while (Date.now() < deadline) {
		const { status, raw } = await getAsset(creds, assetId)
		if (status === 'Active') return
		if (status === 'Rejected') {
			throw new Error(`BytePlus asset rejected (content moderation). ${raw?.FailedReason || ''}`.trim())
		}
		if (status === 'Failed') {
			throw new Error(`BytePlus asset failed. ${raw?.FailedReason || ''}`.trim())
		}
		await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
	}
	throw new Error(`BytePlus asset timed out after ${POLL_TIMEOUT_MS / 1000}s`)
}

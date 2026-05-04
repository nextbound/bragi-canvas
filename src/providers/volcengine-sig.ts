// Volcengine / BytePlus OpenAPI signer (HMAC-SHA256, differs from AWS SigV4).
//
// Reverse-engineered from `volcenginesdkcore` Python SDK:
//   Authorization: HMAC-SHA256 Credential=<AK>/<YYYYMMDD>/<region>/<service>/request, SignedHeaders=<h>, Signature=<hex>
//   X-Date:  <YYYYMMDDTHHMMSSZ>
//   X-Content-Sha256: <body sha256 hex>
//
// Endpoint: https://open.volcengineapi.com/?Action=<action>&Version=<ver>
// Service: "ark"    Region: "ap-southeast-1" (for BytePlus)

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer)
	let hex = ''
	for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
	return hex
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
	const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data
	const hash = await crypto.subtle.digest('SHA-256', buf)
	return toHex(hash)
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		key instanceof ArrayBuffer ? key : key.buffer,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data))
}

export interface VolcSignParams {
	accessKey: string
	secretKey: string
	region: string        // ap-southeast-1
	service: string       // ark
	action: string        // CreateAssetGroup / CreateAsset / GetAsset
	version: string       // 2024-01-01
	body: string          // JSON-stringified body
}

export interface SignedVolcRequest {
	url: string
	headers: Record<string, string>
	body: string
}

/** Sign a Volcengine Universal API request. */
export async function signVolcRequest(p: VolcSignParams): Promise<SignedVolcRequest> {
	const host = 'open.volcengineapi.com'
	const url = `https://${host}/?Action=${encodeURIComponent(p.action)}&Version=${encodeURIComponent(p.version)}`

	const now = new Date()
	const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')  // 20260502T044250Z
	const dateStamp = amzDate.substring(0, 8)                                       // 20260502

	const bodyHash = await sha256Hex(p.body)

	// Canonical query string — sorted by key
	const canonicalQuery = [
		`Action=${encodeURIComponent(p.action)}`,
		`Version=${encodeURIComponent(p.version)}`,
	].sort().join('&')

	// Canonical headers
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		'host': host,
		'x-content-sha256': bodyHash,
		'x-date': amzDate,
	}
	const sortedHeaderKeys = Object.keys(headers).sort()
	const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${headers[k]}\n`).join('')
	const signedHeaders = sortedHeaderKeys.join(';')

	const canonicalRequest = [
		'POST',
		'/',
		canonicalQuery,
		canonicalHeaders,
		signedHeaders,
		bodyHash,
	].join('\n')

	const credentialScope = `${dateStamp}/${p.region}/${p.service}/request`
	const stringToSign = [
		'HMAC-SHA256',
		amzDate,
		credentialScope,
		await sha256Hex(canonicalRequest),
	].join('\n')

	// Derive signing key: HMAC chain secret -> date -> region -> service -> "request"
	const kSecret = new TextEncoder().encode(p.secretKey).buffer
	const kDate = await hmac(kSecret, dateStamp)
	const kRegion = await hmac(kDate, p.region)
	const kService = await hmac(kRegion, p.service)
	const kSigning = await hmac(kService, 'request')

	const signatureBuf = await hmac(kSigning, stringToSign)
	const signature = toHex(signatureBuf)

	const authorization = `HMAC-SHA256 Credential=${p.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

	return {
		url,
		headers: {
			'Content-Type': 'application/json',
			'X-Date': amzDate,
			'X-Content-Sha256': bodyHash,
			'Authorization': authorization,
		},
		body: p.body,
	}
}

// Minimal AWS SigV4 signer for Bedrock, using Web Crypto.

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer)
	let hex = ''
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i].toString(16).padStart(2, '0')
	}
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
		key,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data))
}

export interface SigV4Params {
	method: string
	url: string
	region: string
	service: string
	accessKeyId: string
	secretAccessKey: string
	body: string | Uint8Array | ArrayBuffer
	extraHeaders?: Record<string, string>
}

/**
 * Sign an HTTPS request with AWS SigV4 and return headers to include.
 */
export async function signRequest(p: SigV4Params): Promise<Record<string, string>> {
	const url = new URL(p.url)
	const host = url.host
	const path = url.pathname || '/'
	const canonicalQuery = url.search ? url.search.substring(1).split('&').sort().join('&') : ''

	const now = new Date()
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '') // YYYYMMDDTHHMMSSZ
	const dateStamp = amzDate.substring(0, 8)

	const payloadBytes = typeof p.body === 'string'
		? p.body
		: p.body instanceof Uint8Array
			? p.body
			: new Uint8Array(p.body)
	const payloadHash = await sha256Hex(payloadBytes)

	const headers: Record<string, string> = {
		host,
		'x-amz-date': amzDate,
		'x-amz-content-sha256': payloadHash,
		...(p.extraHeaders || {}),
	}

	const signedHeaderNames = Object.keys(headers).map(h => h.toLowerCase()).sort()
	const canonicalHeaders = signedHeaderNames
		.map(h => `${h}:${headers[Object.keys(headers).find(k => k.toLowerCase() === h)!].trim()}\n`)
		.join('')
	const signedHeaders = signedHeaderNames.join(';')

	const canonicalRequest = [
		p.method,
		path,
		canonicalQuery,
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join('\n')

	const credentialScope = `${dateStamp}/${p.region}/${p.service}/aws4_request`
	const stringToSign = [
		'AWS4-HMAC-SHA256',
		amzDate,
		credentialScope,
		await sha256Hex(canonicalRequest),
	].join('\n')

	const kDate = await hmac(new TextEncoder().encode('AWS4' + p.secretAccessKey), dateStamp)
	const kRegion = await hmac(new Uint8Array(kDate), p.region)
	const kService = await hmac(new Uint8Array(kRegion), p.service)
	const kSigning = await hmac(new Uint8Array(kService), 'aws4_request')
	const signature = toHex(await hmac(new Uint8Array(kSigning), stringToSign))

	const authorization = `AWS4-HMAC-SHA256 Credential=${p.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

	// Do not return `host` — Chromium/Electron forbids setting it on fetch/requestUrl
	// (raising net::ERR_INVALID_ARGUMENT). The network stack sets it automatically
	// from the URL, which matches what we signed.
	const { host: _host, ...outgoing } = headers
	return {
		...outgoing,
		Authorization: authorization,
	}
}

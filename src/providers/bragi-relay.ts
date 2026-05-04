import { requestUrl } from 'obsidian'
import type { BragiSettings } from '../settings'

/**
 * Built-in Bragi Relay — the plugin ships with this endpoint + token so users
 * don't have to deploy their own worker. All reference-image / audio uploads
 * from Seedance, fal, STT, and audio-isolation flow through here.
 */
export const BUILTIN_BRAGI_RELAY: BragiRelayConfig = {
	endpoint: 'https://bragi-relay.hisimon-me.workers.dev',
	token: 'eca59a4c6895d6c31a63db967e2c704264517f69f1ab35043976fe72fcf618d4',
}

export interface BragiRelayConfig {
	endpoint: string
	token: string
}

export function isBragiRelayConfigured(cfg: BragiRelayConfig | undefined): boolean {
	return !!(cfg && cfg.endpoint && cfg.token)
}

function joinUrl(base: string, path: string): string {
	return base.replace(/\/+$/, '') + path
}

/** Upload raw bytes to the Bragi Relay worker; returns the public URL of the uploaded file. */
export async function uploadToBragiRelay(
	cfg: BragiRelayConfig,
	fileData: ArrayBuffer,
	fileName: string,
	contentType: string,
): Promise<string> {
	const ext = fileName.includes('.') ? fileName.split('.').pop()! : ''
	const url = joinUrl(cfg.endpoint, `/upload${ext ? `?ext=${encodeURIComponent(ext)}` : ''}`)
	const resp = await requestUrl({
		url,
		method: 'POST',
		headers: {
			'Content-Type': contentType,
			'Authorization': `Bearer ${cfg.token}`,
		},
		body: fileData,
	})
	const data = resp.json as { url?: string; error?: string }
	if (!data?.url) throw new Error(data?.error || `Bragi Relay: no URL in response`)
	return data.url
}

export async function testBragiRelay(cfg: BragiRelayConfig): Promise<{ ok: boolean; error?: string }> {
	try {
		const resp = await requestUrl({
			url: joinUrl(cfg.endpoint, '/healthz'),
			method: 'GET',
			headers: { 'Authorization': `Bearer ${cfg.token}` },
			throw: false,
		})
		if (resp.status === 200 && resp.json?.ok) return { ok: true }
		if (resp.status === 401) return { ok: false, error: 'Invalid token' }
		return { ok: false, error: `HTTP ${resp.status}: ${JSON.stringify(resp.json || '').substring(0, 100)}` }
	} catch (err: any) {
		return { ok: false, error: err?.message || String(err) }
	}
}

/** Pick the active cloud storage config from settings. Bragi Relay first, then R2 fallback. */
export function getActiveRelay(settings: BragiSettings): { kind: 'bragi'; cfg: BragiRelayConfig } | { kind: 'r2' } | null {
	if (settings.cloudStorage?.provider === 'bragi' && isBragiRelayConfigured(settings.cloudStorage)) {
		return { kind: 'bragi', cfg: { endpoint: settings.cloudStorage.endpoint, token: settings.cloudStorage.token } }
	}
	// Legacy R2 direct
	if (settings.r2 && settings.r2.accountId && settings.r2.accessKeyId && settings.r2.secretAccessKey && settings.r2.bucket && settings.r2.publicBaseUrl) {
		return { kind: 'r2' }
	}
	return null
}

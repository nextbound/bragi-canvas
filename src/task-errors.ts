import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian'

export type TaskErrorKind = 'retryable' | 'terminal' | 'attention'

export class TaskPollingError extends Error {
	constructor(message: string, readonly kind: TaskErrorKind, readonly retryAfterMs?: number) {
		super(message)
		this.name = 'TaskPollingError'
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown error'
}

export function classifyTaskError(error: unknown): TaskPollingError {
	if (error instanceof TaskPollingError) return error
	const message = errorMessage(error)
	const status = /(?:HTTP|status(?: code)?)[\s:=]+(\d{3})/i.exec(message)?.[1]
	if (status && (['408', '429'].includes(status) || Number(status) >= 500)) {
		return new TaskPollingError(message, 'retryable')
	}
	if (/net::|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|fetch failed|failed to fetch|network|socket hang up|timed?\s*out/i.test(message)) {
		return new TaskPollingError(message, 'retryable')
	}
	return new TaskPollingError(message, 'attention')
}

export function retryAfterMs(value: string | undefined, now = Date.now()): number | undefined {
	if (!value) return undefined
	const seconds = Number(value)
	const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
	return Number.isFinite(delay) && delay >= 0 ? delay : undefined
}

/** Polling and result downloads only. Never retries or submits a generation. */
export async function pollRequest(options: RequestUrlParam | string): Promise<RequestUrlResponse> {
	const params = typeof options === 'string' ? { url: options } : options
	let response: RequestUrlResponse
	try {
		response = await requestUrl({ ...params, throw: false })
	} catch (error) {
		throw classifyTaskError(error)
	}
	if (response.status === 408 || response.status === 429 || response.status >= 500) {
		const retry = Object.entries(response.headers || {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1]
		throw new TaskPollingError(`Request temporarily unavailable (HTTP ${response.status})`, 'retryable', retryAfterMs(retry))
	}
	if (response.status >= 400 && params.throw !== false) {
		throw new TaskPollingError(`Request failed (HTTP ${response.status})`, 'attention')
	}
	return response
}

/** Unknown or missing states need review, rather than polling forever. */
export function assertPendingStatus(value: unknown): void {
	if (typeof value === 'string' && ['failed', 'failure', 'error', 'cancelled', 'canceled', 'expired'].includes(value.toLowerCase())) {
		throw new TaskPollingError(`Remote task ${value}`, 'terminal')
	}
	const pending = new Set(['pending', 'queued', 'queueing', 'in_queue', 'in_progress', 'processing', 'running', 'submitted', 'created', 'preparing', 'waiting', 'starting', 'pended'])
	if (typeof value !== 'string' || !pending.has(value.toLowerCase())) {
		throw new TaskPollingError(`Unrecognized task status: ${String(value)}`, 'attention')
	}
}

/** Local output failures require intervention, even on a network-backed vault. */
export async function writeTaskResult(adapter: Pick<import('obsidian').DataAdapter, 'writeBinary'>, path: string, bytes: ArrayBuffer): Promise<void> {
	try { await adapter.writeBinary(path, bytes) }
	catch (error) { throw new TaskPollingError(`Could not save result: ${errorMessage(error)}`, 'attention') }
}

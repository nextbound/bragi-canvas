/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- HTTP headers and worker IPC payloads arrive as runtime-shaped data narrowed at use sites. */
import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, readdirSync } from 'fs'
import type { IncomingHttpHeaders } from 'http'
import { join } from 'path'
import { z, ZodError } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { App } from 'obsidian'
import type { TaskQueue } from './task-queue'
import type { BragiSettings } from './settings'
import {
	createMcpToolRegistry,
	type GetCanvas,
	type McpToolDef,
	type McpToolResult,
	type RunGeneration,
} from './mcp-tool-registry'

type JsonRpcId = string | number | null

interface JsonRpcRequest {
	jsonrpc?: '2.0'
	id?: JsonRpcId
	method?: string
	params?: unknown
}

interface JsonRpcResponse {
	jsonrpc: '2.0'
	id: JsonRpcId
	result?: unknown
	error?: {
		code: number
		message: string
		data?: unknown
	}
}

interface ToolCallParams {
	name?: unknown
	arguments?: unknown
}

interface SerializedHttpRequest {
	method?: string
	url?: string
	headers: IncomingHttpHeaders
	rawBody?: string
}

interface SerializedHttpResponse {
	statusCode: number
	headers?: Record<string, string>
	body?: string
}

type SetHttpHeader = (name: string, value: string) => void

const PROTOCOL_VERSION = '2025-06-18'

const CORS_HEADERS: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': '*',
	'Access-Control-Expose-Headers': 'Mcp-Session-Id',
}

const MCP_HTTP_WORKER_SOURCE = String.raw`
const http = require('http')

const CORS_HEADERS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': '*',
	'Access-Control-Expose-Headers': 'Mcp-Session-Id',
}

let server = null
let nextRequestId = 1
const pendingResponses = new Map()

function send(message) {
	if (typeof process.send === 'function') process.send(message)
}

function sendLog(level, message) {
	send({ type: 'log', level, message: String(message) })
}

function writeHeaders(res, headers) {
	for (const [name, value] of Object.entries(headers || {})) {
		if (value !== undefined) res.setHeader(name, value)
	}
}

function readRawBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = []
		req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
		req.on('error', reject)
	})
}

function writeResponse(requestId, response) {
	const res = pendingResponses.get(requestId)
	if (!res) return
	pendingResponses.delete(requestId)

	const headers = Object.assign({}, CORS_HEADERS, response && response.headers ? response.headers : {})
	writeHeaders(res, headers)
	res.writeHead(response && response.statusCode ? response.statusCode : 500)
	res.end(response && response.body !== undefined ? response.body : '')
}

async function handleRequest(req, res) {
	writeHeaders(res, CORS_HEADERS)

	if (req.method === 'OPTIONS') {
		res.writeHead(204)
		res.end()
		return
	}

	const requestId = String(nextRequestId++)
	pendingResponses.set(requestId, res)
	res.on('close', () => pendingResponses.delete(requestId))

	try {
		const rawBody = req.method === 'POST' ? await readRawBody(req) : undefined
		if (!pendingResponses.has(requestId)) return
		send({
			type: 'request',
			requestId,
			request: {
				method: req.method,
				url: req.url,
				headers: req.headers,
				rawBody,
			},
		})
	} catch (err) {
		pendingResponses.delete(requestId)
		writeHeaders(res, CORS_HEADERS)
		res.writeHead(500, { 'Content-Type': 'application/json' })
		res.end(JSON.stringify({
			jsonrpc: '2.0',
			id: null,
			error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
		}))
	}
}

function start(port, host) {
	if (server) {
		send({ type: 'start-error', error: { message: 'MCP HTTP worker is already running' } })
		return
	}

	server = http.createServer((req, res) => {
		void handleRequest(req, res)
	})

	server.on('error', err => {
		send({
			type: 'start-error',
			error: {
				message: err && err.message ? err.message : String(err),
				code: err && err.code ? err.code : undefined,
			},
		})
	})

	server.listen(port, host, () => {
		send({ type: 'listening' })
	})
}

function shutdown() {
	for (const [requestId, res] of pendingResponses.entries()) {
		pendingResponses.delete(requestId)
		writeHeaders(res, CORS_HEADERS)
		res.writeHead(503)
		res.end('MCP server stopped')
	}

	if (!server) {
		process.exit(0)
		return
	}

	server.close(() => process.exit(0))
}

process.on('message', message => {
	if (!message || typeof message !== 'object') return
	if (message.type === 'start') start(message.port, message.host)
	if (message.type === 'response') writeResponse(message.requestId, message.response)
	if (message.type === 'shutdown') shutdown()
})

process.on('disconnect', shutdown)
process.on('uncaughtException', err => sendLog('error', err && err.stack ? err.stack : err))
process.on('unhandledRejection', err => sendLog('error', err && err.stack ? err.stack : err))
`

function pushNodeCandidate(candidates: string[], candidate: string | undefined): void {
	if (!candidate) return
	if (candidate.includes('Obsidian.app/Contents/MacOS/Obsidian')) return
	if (candidate.includes('Obsidian Helper')) return
	if (!candidates.includes(candidate)) candidates.push(candidate)
}

function findNvmNodeCandidates(): string[] {
	const nvmDir = process.env.NVM_DIR || (process.env.HOME ? join(process.env.HOME, '.nvm') : '')
	const versionsDir = nvmDir ? join(nvmDir, 'versions', 'node') : ''
	if (!versionsDir || !existsSync(versionsDir)) return []

	try {
		return readdirSync(versionsDir)
			.filter(version => version.startsWith('v'))
			.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
			.map(version => join(versionsDir, version, 'bin', 'node'))
	} catch {
		return []
	}
}

function resolveWorkerNodeExecutable(): string {
	const candidates: string[] = []
	pushNodeCandidate(candidates, process.env.BRAGI_MCP_NODE_PATH)
	pushNodeCandidate(candidates, process.env.NODE_BINARY)
	pushNodeCandidate(candidates, process.env.npm_node_execpath)
	pushNodeCandidate(candidates, process.execPath.endsWith('/node') ? process.execPath : undefined)
	for (const candidate of findNvmNodeCandidates()) pushNodeCandidate(candidates, candidate)
	pushNodeCandidate(candidates, '/opt/homebrew/bin/node')
	pushNodeCandidate(candidates, '/usr/local/bin/node')
	pushNodeCandidate(candidates, '/usr/bin/node')

	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate
	}

	return 'node'
}

function jsonResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
	return { jsonrpc: '2.0', id, result }
}

function jsonError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
	return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}

function toolInputSchema(tool: McpToolDef): unknown {
	// Emit the schema inline (no `name`) so the top-level object keeps `type: "object"`.
	// Passing `name` wraps the schema in `{ $ref, definitions }`, which has no top-level
	// `type` and is rejected by hosts like OpenAI/Codex ("schema must be type object, got None").
	return zodToJsonSchema(z.object(tool.inputSchema), {
		$refStrategy: 'none',
	})
}

export class BragiMcpServer {
	private httpWorker: ChildProcess | null = null
	private workerStart: { resolve: () => void; reject: (err: Error) => void } | null = null
	private workerStopping = false
	private sessions = new Set<string>()

	constructor(
		private getCanvas: GetCanvas,
		private app: App,
		private runGeneration?: RunGeneration,
		private getSettings?: () => BragiSettings,
		private taskQueue?: TaskQueue,
		private getOutputDir?: () => string,
		private rememberGeneratedAsset?: (path: string) => void,
		private rememberCanvasPath?: (path: string) => void,
	) {}

	private get tools(): McpToolDef[] {
		return createMcpToolRegistry({
			getCanvas: this.getCanvas,
			app: this.app,
			runGeneration: this.runGeneration,
			getSettings: this.getSettings,
			taskQueue: this.taskQueue,
			getOutputDir: this.getOutputDir,
			rememberGeneratedAsset: this.rememberGeneratedAsset,
			rememberCanvasPath: this.rememberCanvasPath,
		})
	}

	async start(port: number): Promise<void> {
		if (this.httpWorker) await this.stop()

		return new Promise<void>((resolve, reject) => {
			const workerNode = resolveWorkerNodeExecutable()
			const worker = spawn(workerNode, ['-e', MCP_HTTP_WORKER_SOURCE], {
				env: { ...process.env },
				stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
				windowsHide: true,
			})

			const startTimeout = window.setTimeout(() => {
				this.failWorkerStart(new Error(`Bragi MCP worker did not report listening on port ${port}`))
			}, 5000)
			this.httpWorker = worker
			this.workerStart = {
				resolve: () => {
					window.clearTimeout(startTimeout)
					resolve()
				},
				reject: (err) => {
					window.clearTimeout(startTimeout)
					reject(err)
				},
			}
			this.workerStopping = false

			worker.stdout?.on('data', chunk => {
				const message = Buffer.isBuffer(chunk) ? chunk.toString('utf8').trim() : String(chunk).trim()
				if (message) console.debug('Bragi MCP worker:', message)
			})
			worker.stderr?.on('data', chunk => {
				const message = Buffer.isBuffer(chunk) ? chunk.toString('utf8').trim() : String(chunk).trim()
				if (message) console.error('Bragi MCP worker stderr:', message)
			})
			worker.on('message', message => {
				void this.handleWorkerMessage(message)
			})
			worker.on('error', err => {
				this.failWorkerStart(err instanceof Error ? err : new Error(String(err)))
			})
			worker.on('exit', (code, signal) => {
				const message = `Bragi MCP worker exited${code !== null ? ` with code ${code}` : ''}${signal ? ` from signal ${signal}` : ''}`
				this.failWorkerStart(new Error(message))
				if (!this.workerStopping && this.httpWorker === worker) {
					console.error(message)
					this.httpWorker = null
				}
			})

			if (!worker.connected || !worker.send) {
				this.failWorkerStart(new Error('Bragi MCP worker IPC channel is not available'))
				return
			}

			worker.send({ type: 'start', port, host: '127.0.0.1' })
		})
	}

	private async handleWorkerMessage(message: unknown): Promise<void> {
		if (!message || typeof message !== 'object') return
		const payload = message as {
			type?: unknown
			requestId?: unknown
			request?: unknown
			response?: unknown
			error?: { message?: unknown; code?: unknown }
			level?: unknown
			message?: unknown
		}

		if (payload.type === 'listening') {
			this.workerStart?.resolve()
			this.workerStart = null
			return
		}

		if (payload.type === 'start-error') {
			const details = typeof payload.error?.message === 'string' ? payload.error.message : 'Unknown worker start error'
			const code = typeof payload.error?.code === 'string' ? ` (${payload.error.code})` : ''
			const err = new Error(`Bragi MCP server failed to start: ${details}${code}`)
			if (this.workerStart) this.failWorkerStart(err)
			else console.error(err)
			return
		}

		if (payload.type === 'log') {
			const logMessage = typeof payload.message === 'string' ? payload.message : JSON.stringify(payload.message ?? '')
			if (payload.level === 'error') console.error('Bragi MCP worker:', logMessage)
			else console.debug('Bragi MCP worker:', logMessage)
			return
		}

		if (payload.type !== 'request' || typeof payload.requestId !== 'string') return
		const request = payload.request as SerializedHttpRequest
		try {
			const response = await this.handleSerializedHttpRequest(request)
			this.sendWorkerResponse(payload.requestId, response)
		} catch (err) {
			console.error('Bragi MCP worker request failed:', err)
			this.sendWorkerResponse(payload.requestId, this.withCors({
				statusCode: 500,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(jsonError(null, -32603, err instanceof Error ? err.message : String(err))),
			}))
		}
	}

	private failWorkerStart(err: Error): void {
		if (!this.workerStart) return
		console.error('Bragi MCP server start failed:', err)
		const worker = this.httpWorker
		this.httpWorker = null
		this.workerStart.reject(err)
		this.workerStart = null
		if (worker && !worker.killed) worker.kill()
	}

	private sendWorkerResponse(requestId: string, response: SerializedHttpResponse): void {
		const worker = this.httpWorker
		if (!worker?.connected || !worker.send) return
		worker.send({ type: 'response', requestId, response })
	}

	private withCors(response: SerializedHttpResponse): SerializedHttpResponse {
		return {
			...response,
			headers: { ...CORS_HEADERS, ...(response.headers ?? {}) },
		}
	}

	private async handleSerializedHttpRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
		if (req.method === 'OPTIONS') {
			return this.withCors({ statusCode: 204 })
		}

		if (req.url !== '/mcp' && !req.url?.startsWith('/mcp?')) {
			return this.withCors({ statusCode: 404, body: 'Not found' })
		}

		const unauthorized = this.authorize(req.headers)
		if (unauthorized) return unauthorized

		try {
			if (req.method === 'DELETE') {
				this.closeSession(req.headers)
				return this.withCors({ statusCode: 204 })
			}

			if (req.method === 'GET') {
				return this.withCors({
					statusCode: 200,
					headers: {
						'Content-Type': 'text/event-stream',
						'Cache-Control': 'no-cache',
						Connection: 'keep-alive',
					},
					body: 'event: endpoint\ndata: /mcp\n\n',
				})
			}

			if (req.method !== 'POST') {
				return this.withCors({ statusCode: 405, body: 'Method not allowed' })
			}

			const body = parseJsonBody(req.rawBody)
			const responseHeaders: Record<string, string> = {}
			const response = await this.handleBody(body, (name, value) => {
				responseHeaders[name] = value
			})
			if (response === null) {
				return this.withCors({ statusCode: 204, headers: responseHeaders })
			}

			return this.withCors({
				statusCode: 200,
				headers: { 'Content-Type': 'application/json', ...responseHeaders },
				body: JSON.stringify(response),
			})
		} catch (err) {
			console.error('Bragi MCP error:', err)
			return this.withCors({
				statusCode: 500,
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(jsonError(null, -32603, err instanceof Error ? err.message : String(err))),
			})
		}
	}

	private authorize(headers: IncomingHttpHeaders): SerializedHttpResponse | null {
		const expectedToken = (this.getSettings?.()?.mcpToken || '').trim()
		if (!expectedToken) return null

		const authHeader = headers['authorization']
		const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader
		const presented = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : ''
		if (presented === expectedToken) return null

		return this.withCors({
			statusCode: 401,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(jsonError(null, -32001, 'Unauthorized')),
		})
	}

	private closeSession(headers: IncomingHttpHeaders): void {
		const sessionIdHeader = headers['mcp-session-id']
		const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader
		if (sessionId) this.sessions.delete(sessionId)
	}

	private async handleBody(body: unknown, setHeader: SetHttpHeader): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
		if (Array.isArray(body)) {
			const responses = await Promise.all(body.map(item => this.handleRequest(item, setHeader)))
			const concrete = responses.filter((item): item is JsonRpcResponse => item !== null)
			return concrete.length > 0 ? concrete : null
		}

		return this.handleRequest(body, setHeader)
	}

	private async handleRequest(raw: unknown, setHeader: SetHttpHeader): Promise<JsonRpcResponse | null> {
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
			return jsonError(null, -32600, 'Invalid request')
		}

		const request = raw as JsonRpcRequest
		const id = request.id ?? null
		const isNotification = request.id === undefined
		if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
			return isNotification ? null : jsonError(id, -32600, 'Invalid request')
		}

		try {
			switch (request.method) {
				case 'initialize':
					return this.handleInitialize(request, setHeader)
				case 'notifications/initialized':
					return null
				case 'ping':
					return isNotification ? null : jsonResponse(id, {})
				case 'tools/list':
					return isNotification ? null : jsonResponse(id, this.listTools())
				case 'tools/call':
					return isNotification ? null : jsonResponse(id, await this.callTool(request.params))
				default:
					return isNotification ? null : jsonError(id, -32601, `Method not found: ${request.method}`)
			}
		} catch (err) {
			if (isNotification) return null
			if (err instanceof ZodError) {
				return jsonError(id, -32602, 'Invalid params', err.errors)
			}
			return jsonError(id, -32603, err instanceof Error ? err.message : String(err))
		}
	}

	private handleInitialize(request: JsonRpcRequest, setHeader: SetHttpHeader): JsonRpcResponse | null {
		if (request.id === undefined) return null
		const sessionId = randomUUID()
		this.sessions.add(sessionId)
		setHeader('Mcp-Session-Id', sessionId)
		const params = request.params as { protocolVersion?: unknown } | undefined
		return jsonResponse(request.id, {
			protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION,
			capabilities: { tools: {} },
			serverInfo: { name: 'bragi-canvas', version: '1.0.0' },
		})
	}

	private listTools(): { tools: Array<{ name: string; description: string; inputSchema: unknown }> } {
		return {
			tools: this.tools.map(tool => ({
				name: tool.name,
				description: tool.description,
				inputSchema: toolInputSchema(tool),
			})),
		}
	}

	private async callTool(params: unknown): Promise<McpToolResult> {
		const toolParams = params as ToolCallParams | undefined
		if (!toolParams || typeof toolParams.name !== 'string') {
			throw new Error('tools/call requires params.name')
		}

		const tool = this.tools.find(item => item.name === toolParams.name)
		if (!tool) throw new Error(`Unknown tool: ${toolParams.name}`)

		const args = z.object(tool.inputSchema).parse(toolParams.arguments ?? {})
		return tool.handler(args)
	}

	async stop(): Promise<void> {
		this.sessions.clear()
		const worker = this.httpWorker
		if (!worker) return

		this.httpWorker = null
		this.workerStart = null
		this.workerStopping = true

		await new Promise<void>((resolve) => {
			let settled = false
			const finish = () => {
				if (settled) return
				settled = true
				resolve()
			}
			const timeout = window.setTimeout(() => {
				if (!worker.killed) worker.kill()
				finish()
			}, 1500)
			worker.once('exit', () => {
				window.clearTimeout(timeout)
				finish()
			})
			if (worker.connected && worker.send) {
				worker.send({ type: 'shutdown' })
			} else {
				worker.kill()
			}
		})
		this.workerStopping = false
	}
}

function parseJsonBody(raw: string | undefined): unknown {
	if (!raw) return undefined
	return JSON.parse(raw)
}

/* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

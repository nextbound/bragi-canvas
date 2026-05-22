import * as http from 'http'
import { randomUUID } from 'crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { App } from 'obsidian'
import type { TaskQueue } from './task-queue'
import type { BragiSettings } from './settings'
import {
	createMcpToolRegistry,
	type GetCanvas,
	type McpToolDef,
	type RunGeneration,
	type ToolSchema,
} from './mcp-tool-registry'

function registerTool<Args extends ToolSchema>(mcp: McpServer, tool: McpToolDef<Args>): void {
	mcp.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, tool.handler)
}

interface Session {
	transport: StreamableHTTPServerTransport
	server: McpServer
}

export class BragiMcpServer {
	private httpServer: http.Server | null = null
	private sessions: Map<string, Session> = new Map()

	constructor(
		private getCanvas: GetCanvas,
		private app: App,
		private runGeneration?: RunGeneration,
		private getSettings?: () => BragiSettings,
		private taskQueue?: TaskQueue,
		private getOutputDir?: () => string,
	) {}

	private createServer(): McpServer {
		const mcp = new McpServer(
			{ name: 'bragi-canvas', version: '1.0.0' },
			{ capabilities: { tools: {} } },
		)
		this.registerTools(mcp)
		return mcp
	}

	private registerTools(mcp: McpServer) {
		for (const tool of createMcpToolRegistry({
			getCanvas: this.getCanvas,
			app: this.app,
			runGeneration: this.runGeneration,
			getSettings: this.getSettings,
			taskQueue: this.taskQueue,
			getOutputDir: this.getOutputDir,
		})) {
			registerTool(mcp, tool)
		}
	}

	async start(port: number): Promise<void> {
		this.httpServer = http.createServer((req, res) => {
			void this.handleHttpRequest(req, res)
		})

		return new Promise<void>((resolve, reject) => {
			this.httpServer!.on('error', (err: NodeJS.ErrnoException) => {
				console.error(`Bragi MCP server failed to start on port ${port}:`, err.message)
				reject(err instanceof Error ? err : new Error(String(err)))
			})
			this.httpServer!.listen(port, '127.0.0.1', () => {
				resolve()
			})
		})
	}

	private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		res.setHeader('Access-Control-Allow-Origin', '*')
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
		res.setHeader('Access-Control-Allow-Headers', '*')
		res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id')

		if (req.method === 'OPTIONS') {
			res.writeHead(204)
			res.end()
			return
		}

		if (req.url !== '/mcp' && !req.url?.startsWith('/mcp?')) {
			res.writeHead(404)
			res.end('Not found')
			return
		}

		// Optional bearer token auth: when settings.mcpToken is set, every request
		// must carry a matching Authorization header.
		const expectedToken = (this.getSettings?.()?.mcpToken || '').trim()
		if (expectedToken) {
			const authHeader = req.headers['authorization']
			const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader
			const presented = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : ''
			if (presented !== expectedToken) {
				res.writeHead(401, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({
					jsonrpc: '2.0',
					error: { code: -32001, message: 'Unauthorized' },
					id: null,
				}))
				return
			}
		}

		try {
			await this.routeRequest(req, res)
		} catch (err) {
			console.error('Bragi MCP error:', err)
			if (!res.headersSent) {
				res.writeHead(500)
				res.end(JSON.stringify({ error: String(err) }))
			}
		}
	}

	private async routeRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const sessionIdHeader = req.headers['mcp-session-id']
		const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader

		if (sessionId) {
			const session = this.sessions.get(sessionId)
			if (!session) {
				res.writeHead(404, { 'Content-Type': 'application/json' })
				res.end(JSON.stringify({
					jsonrpc: '2.0',
					error: { code: -32001, message: 'Session not found' },
					id: null,
				}))
				return
			}
			await session.transport.handleRequest(req, res)
			return
		}

		// No session ID → must be an initialize request. Parse body once and hand to a new transport.
		if (req.method !== 'POST') {
			res.writeHead(400, { 'Content-Type': 'application/json' })
			res.end(JSON.stringify({
				jsonrpc: '2.0',
				error: { code: -32000, message: 'Missing Mcp-Session-Id header' },
				id: null,
			}))
			return
		}

		const body = await readJsonBody(req)

		const server = this.createServer()
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (id: string) => {
				this.sessions.set(id, { transport, server })
			},
		})

		transport.onclose = () => {
			const id = transport.sessionId
			if (id) this.sessions.delete(id)
		}

		await server.connect(transport)
		await transport.handleRequest(req, res, body)
	}

	async stop(): Promise<void> {
		for (const { server, transport } of this.sessions.values()) {
			try {
				await server.close()
			} catch {
				// Session shutdown is best-effort.
			}
			try {
				await transport.close()
			} catch {
				// Session shutdown is best-effort.
			}
		}
		this.sessions.clear()

		if (this.httpServer) {
			this.httpServer.close()
			this.httpServer = null
		}
	}
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = []
		req.on('data', chunk => chunks.push(chunk))
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8')
			if (!raw) return resolve(undefined)
			try {
				resolve(JSON.parse(raw))
			} catch (err) {
				reject(err instanceof Error ? err : new Error(String(err)))
			}
		})
		req.on('error', reject)
	})
}

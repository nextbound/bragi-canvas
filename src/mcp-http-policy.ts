/** Self-contained so exactly this policy can run in the isolated HTTP worker. */
export function validateMcpRequest(headers: Record<string, string | string[] | undefined>, method: string | undefined, port: number): { status: number; message?: string; headers: Record<string, string> } {
	const host = headers.host
	const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
	if (typeof host !== 'string' || !allowedHosts.includes(host.toLowerCase())) return { status: 403, message: 'Host must be a loopback address with the MCP port.', headers: {} }
	const origin = headers.origin
	const cors: Record<string, string> = {}
	if (origin !== undefined) {
		if (typeof origin !== 'string' || origin !== `http://${host}`) return { status: 403, message: 'Origin must match this MCP server.', headers: {} }
		cors['Access-Control-Allow-Origin'] = origin
		cors['Vary'] = 'Origin'
		cors['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
		cors['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version'
		cors['Access-Control-Expose-Headers'] = 'Mcp-Session-Id'
	}
	if (method === 'POST') {
		const contentType = headers['content-type']
		if (typeof contentType !== 'string' || contentType.split(';')[0].trim().toLowerCase() !== 'application/json') return { status: 415, message: 'MCP POST requests require application/json.', headers: cors }
		const length = headers['content-length']
		if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > 64 * 1024 * 1024)) return { status: 413, message: 'MCP request body exceeds 64 MiB.', headers: cors }
	}
	return { status: 200, headers: cors }
}

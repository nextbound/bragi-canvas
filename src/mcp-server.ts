/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- MCP request payloads and Canvas bridge data arrive as runtime-shaped JSON that is validated at the command boundary. */
import * as http from 'http'
import { randomUUID } from 'crypto'
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { Modal, TFile, type App } from 'obsidian'
import type { AllCanvasNodeData, CanvasEdgeData } from 'obsidian/canvas'
import type { Canvas, CanvasEdge, CanvasNode, MoveAndResizeOptions } from './types/canvas-internal'
import type { PanelResult } from './panel'
import { getModelById, getActiveProvider, getEnabledModels } from './models/index'
import { getConfiguredProviderIds } from './providers/registry'
import type { GenerationType, Mode } from './models/types'
import { getUpstreamInputs } from './edge-parser'
import { getOrderedTextRefs } from './text-refs'
import { getOrderedImages } from './ref-thumbnails'
import type { TaskQueue, TaskSnapshot } from './task-queue'
import type { BragiSettings } from './settings'

type GetCanvas = () => Canvas | null
type RunGeneration = (node: CanvasNode, result: PanelResult) => Promise<{
	placeholderIds: string[]
	expectedOutputType: 'image' | 'video' | 'text' | 'audio'
}>
type ToolSchema = z.ZodRawShape
type JsonMap = Record<string, unknown>
type BragiCanvasNodeData = AllCanvasNodeData & { bragiAssetId?: string }
type SerializableEdge = CanvasEdgeData | CanvasEdge
type FileView = { file?: TFile }
type EdgeStore = Map<string, CanvasEdge> | CanvasEdge[]

function requireCanvas(getCanvas: GetCanvas): Canvas {
	const canvas = getCanvas()
	if (!canvas) throw new Error('No active canvas open in Obsidian')
	return canvas
}

function findNode(canvas: Canvas, id: string): CanvasNode {
	const node = canvas.nodes.get(id)
	if (!node) throw new Error(`Node not found: ${id}`)
	return node
}

function serializeNode(node: CanvasNode) {
	const d = node.getData() as BragiCanvasNodeData
	return {
		id: node.id,
		type: d.type,
		x: d.x,
		y: d.y,
		width: d.width,
		height: d.height,
		...(d.type === 'text' ? { text: d.text } : {}),
		...(d.type === 'file' ? { file: d.file } : {}),
		...(d.color ? { color: d.color } : {}),
	}
}

function serializeEdge(edge: SerializableEdge) {
	const d = 'getData' in edge && typeof edge.getData === 'function' ? edge.getData() : edge
	const runtimeFrom = 'from' in edge ? edge.from : undefined
	const runtimeTo = 'to' in edge ? edge.to : undefined
	return {
		id: edge.id || d.id,
		fromNode: d.fromNode || runtimeFrom?.node?.id,
		fromSide: d.fromSide || runtimeFrom?.side,
		toNode: d.toNode || runtimeTo?.node?.id,
		toSide: d.toSide || runtimeTo?.side,
		...(d.label ? { label: d.label } : {}),
	}
}

function canvasEdgeData(canvas: Canvas): CanvasEdgeData[] {
	return canvas.getData().edges || []
}

function edgeStillExists(canvas: Canvas, edgeId: string): boolean {
	return canvasEdgeData(canvas).some(e => e.id === edgeId)
}

function findRuntimeEdge(canvas: Canvas, edgeId: string): CanvasEdge | null {
	const store = canvas.edges as unknown as EdgeStore
	if (store instanceof Map) return store.get(edgeId) || null
	if (Array.isArray(store)) return store.find(edge => edge.id === edgeId) || null
	return null
}

function removeFromRuntimeEdgeStore(canvas: Canvas, edgeId: string): boolean {
	const store = canvas.edges as unknown as EdgeStore
	if (store instanceof Map) return store.delete(edgeId)
	if (!Array.isArray(store)) return false
	const index = store.findIndex(edge => edge.id === edgeId)
	if (index < 0) return false
	store.splice(index, 1)
	return true
}

function callRuntimeEdgeRemoval(canvas: Canvas, edgeId: string): boolean {
	const edge = findRuntimeEdge(canvas, edgeId)
	if (!edge) return false
	const runtime = canvas as unknown as Record<string, unknown>
	for (const methodName of ['removeEdge', 'deleteEdge']) {
		const method = runtime[methodName]
		if (typeof method !== 'function') continue
		try {
			method.call(canvas, edge)
			return true
		} catch {
			try {
				method.call(canvas, edgeId)
				return true
			} catch {
				// Try the next known Canvas runtime method shape.
			}
		}
	}
	return false
}

function ok(data: unknown = { status: 'ok' }) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

function registerTool<Args extends ToolSchema>(
	mcp: McpServer,
	name: string,
	description: string,
	inputSchema: Args,
	cb: ToolCallback<Args>,
): void {
	mcp.registerTool(name, { description, inputSchema }, cb)
}

function randomId(): string {
	return randomUUID().replace(/-/g, '').slice(0, 16)
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
		const getCanvas = this.getCanvas

		registerTool(mcp,
			'list_nodes',
			'List all nodes on the active canvas',
			{ type: z.enum(['text', 'file', 'link', 'group']).optional().describe('Filter by node type') },
			({ type }) => {
				const canvas = requireCanvas(getCanvas)
				let nodes = Array.from(canvas.nodes.values())
				if (type) nodes = nodes.filter(n => n.getData().type === type)
				return ok(nodes.map(serializeNode))
			},
		)

		registerTool(mcp,
			'get_node',
			'Get details of a single node including its edges',
			{ id: z.string().describe('Node ID') },
			({ id }) => {
				const canvas = requireCanvas(getCanvas)
				const node = findNode(canvas, id)
				const edges = canvas.getEdgesForNode(node) || []
				return ok({
					node: serializeNode(node),
					edges: edges.map(serializeEdge),
				})
			},
		)

		registerTool(mcp,
			'create_text_node',
			'Create a new text node on the canvas',
			{
				text: z.string().describe('Node text content'),
				x: z.number().describe('X position'),
				y: z.number().describe('Y position'),
				width: z.number().optional().default(300).describe('Width'),
				height: z.number().optional().default(200).describe('Height'),
			},
			({ text, x, y, width, height }) => {
				const canvas = requireCanvas(getCanvas)
				const node = canvas.createTextNode({
					text,
					pos: { x, y },
					size: { width, height },
				})
				void canvas.requestSave()
				return ok({ id: node.id })
			},
		)

		registerTool(mcp,
			'update_node',
			'Update a node\'s content, position, or size',
			{
				id: z.string().describe('Node ID'),
				text: z.string().optional().describe('New text content'),
				x: z.number().optional().describe('New X position'),
				y: z.number().optional().describe('New Y position'),
				width: z.number().optional().describe('New width'),
				height: z.number().optional().describe('New height'),
				color: z.string().optional().describe('Node color'),
			},
			({ id, text, x, y, width, height, color }) => {
				const canvas = requireCanvas(getCanvas)
				const node = findNode(canvas, id)

				// For geometry-only updates, moveAndResize is safe and fast.
				// For text/color updates we rebuild the node via importData,
				// because node.setText() and repeated setData() calls from an
				// external (non-UI) caller can leave Obsidian's canvas in a
				// broken internal state that unmounts all nodes until reload.
				const needsRebuild = text !== undefined || color !== undefined

				if (needsRebuild) {
					const full = canvas.getData()
					const nodes = full.nodes.map((n) => {
						if (n.id !== id) return n
						const next = { ...n }
						if (text !== undefined) next.text = text
						if (color !== undefined) next.color = color
						if (x !== undefined) next.x = x
						if (y !== undefined) next.y = y
						if (width !== undefined) next.width = width
						if (height !== undefined) next.height = height
						return next
					})
					canvas.importData({ ...full, nodes })
					void canvas.requestSave()
					return ok()
				}

				// Geometry-only path: moveAndResize keeps live state coherent.
				const move: MoveAndResizeOptions = {}
				if (x !== undefined) move.x = x
				if (y !== undefined) move.y = y
				if (width !== undefined) move.width = width
				if (height !== undefined) move.height = height
				if (Object.keys(move).length > 0) node.moveAndResize(move)
				void canvas.requestSave()
				return ok()
			},
		)

		registerTool(mcp,
			'delete_node',
			'Delete a node from the canvas',
			{ id: z.string().describe('Node ID') },
			({ id }) => {
				const canvas = requireCanvas(getCanvas)
				const node = findNode(canvas, id)
				canvas.removeNode(node)
				void canvas.requestSave()
				return ok()
			},
		)

		registerTool(mcp,
			'connect_nodes',
			'Create an edge between two nodes',
			{
				fromId: z.string().describe('Source node ID'),
				toId: z.string().describe('Target node ID'),
				fromSide: z.enum(['top', 'right', 'bottom', 'left']).optional().default('right').describe('Source side'),
				toSide: z.enum(['top', 'right', 'bottom', 'left']).optional().default('left').describe('Target side'),
				toEnd: z.enum(['none', 'arrow']).optional().default('arrow').describe('Arrow at target end'),
				label: z.string().optional().describe('Edge label'),
			},
			({ fromId, toId, fromSide, toSide, toEnd, label }) => {
				const canvas = requireCanvas(getCanvas)
				findNode(canvas, fromId)
				findNode(canvas, toId)
				if (fromId === toId) throw new Error(`Self-loop not allowed: ${fromId}`)
				const edgeId = randomId()
				const edge: CanvasEdgeData = {
					id: edgeId,
					fromNode: fromId,
					fromSide,
					toNode: toId,
					toSide,
					toEnd,
				}
				if (label) edge.label = label
				canvas.importData({ nodes: [], edges: [edge] })
				void canvas.requestSave()
				return ok({ edgeId })
			},
		)

		registerTool(mcp,
			'delete_edge',
			'Delete an edge from the canvas',
			{ edgeId: z.string().describe('Edge ID') },
			async ({ edgeId }) => {
				const canvas = requireCanvas(getCanvas)
				const full = canvas.getData()
				const edgeArr = full.edges || []
				const filtered = edgeArr.filter((e) => e.id !== edgeId)
				if (filtered.length === edgeArr.length) throw new Error(`Edge not found: ${edgeId}`)
				canvas.importData({ ...full, edges: filtered })
				await canvas.requestFrame()

				if (edgeStillExists(canvas, edgeId)) {
					callRuntimeEdgeRemoval(canvas, edgeId)
					removeFromRuntimeEdgeStore(canvas, edgeId)
					await canvas.requestFrame()
				}

				if (edgeStillExists(canvas, edgeId)) {
					const remaining = canvasEdgeData(canvas).map(edge => edge.id).join(', ')
					throw new Error(`Edge delete did not apply: ${edgeId}. Remaining edge IDs: ${remaining || '(none)'}`)
				}

				await canvas.requestSave()
				return ok({ status: 'ok', edgeId, deleted: true })
			},
		)

		registerTool(mcp,
			'list_edges',
			'List all edges on the active canvas',
			{},
			() => {
				const canvas = requireCanvas(getCanvas)
				// canvas.edges is a Map at runtime (types lie — they say it's an array).
				// Read the authoritative array from getData() instead.
				const edges = canvas.getData().edges || []
				return ok(edges.map(serializeEdge))
			},
		)

		registerTool(mcp,
			'get_selection',
			'Get the currently selected nodes',
			{},
			() => {
				const canvas = requireCanvas(getCanvas)
				const sel = canvas.selection ? Array.from(canvas.selection) : []
				return ok(sel.map(serializeNode))
			},
		)

		registerTool(mcp,
			'select_node',
			'Select a node on the canvas',
			{ id: z.string().describe('Node ID') },
			({ id }) => {
				const canvas = requireCanvas(getCanvas)
				const node = findNode(canvas, id)
				canvas.selectOnly(node, false)
				return ok()
			},
		)

		registerTool(mcp,
			'read_canvas',
			'Read the full canvas data (all nodes and edges). Returns a truncated marker if the JSON exceeds 100KB — use list_nodes / list_edges for large canvases.',
			{},
			() => {
				const canvas = requireCanvas(getCanvas)
				const data = canvas.getData()
				const serialized = JSON.stringify(data)
				const MAX_SIZE = 100 * 1024
				if (serialized.length > MAX_SIZE) {
					const d = data
					return ok({
						truncated: true,
						sizeBytes: serialized.length,
						nodeCount: (d.nodes || []).length,
						edgeCount: (d.edges || []).length,
						hint: 'Canvas too large to return in full. Use list_nodes / list_edges / get_node instead.',
					})
				}
				return ok(data)
			},
		)

		// ── Generation tools ──────────────────────────────────────

		registerTool(mcp,
			'list_models',
			'List available AI models, optionally filtered by type (image/video/text/audio). Only returns models with configured API keys.',
			{ type: z.enum(['image', 'video', 'text', 'audio']).optional().describe('Filter by generation type') },
			({ type }) => {
				const settings = this.getSettings?.()
				if (!settings) throw new Error('Settings not available')
				const configured = getConfiguredProviderIds(settings)
				const types: GenerationType[] = type ? [type] : ['image', 'video', 'text', 'audio']
				const result: JsonMap[] = []
				for (const t of types) {
					const orderKey = t as keyof typeof settings.modelOrder
					const models = getEnabledModels(t, settings.modelOrder[orderKey], settings.modelPrefs, configured)
					for (const m of models) {
						const pref = settings.modelPrefs[m.id]
						const provider = getActiveProvider(m, pref?.selectedProvider, configured)
						result.push({
							id: m.id,
							name: m.name,
							type: m.type,
							provider,
							modes: m.modes,
							params: m.params.map(p => ({
								id: p.id,
								label: p.label,
								type: p.type,
								default: p.default,
								...(p.options ? { options: p.options } : {}),
								...(p.min !== undefined ? { min: p.min, max: p.max, step: p.step, unit: p.unit } : {}),
							})),
						})
					}
				}
				return ok(result)
			},
		)

		registerTool(mcp,
			'get_upstream',
			'Get upstream inputs (text prompts, reference images, reference videos) connected to a node via arrows',
			{ id: z.string().describe('Target node ID') },
			({ id }) => {
				const canvas = requireCanvas(getCanvas)
				const node = findNode(canvas, id)
				const upstream = getUpstreamInputs(canvas, node)
				const textRefs = getOrderedTextRefs(canvas, node)
				const orderedImages = getOrderedImages(canvas, node)
				return ok({
					prompts: upstream.prompts,
					images: orderedImages,
					videos: upstream.videos,
					textRefs: textRefs.map(r => ({ nodeId: r.nodeId, preview: r.preview, kind: r.kind, mdPath: r.mdPath })),
				})
			},
		)

		registerTool(mcp,
			'generate',
			'Trigger AI generation on a node. The node must contain a text prompt (text node or .md file node). Upstream connected nodes provide reference images/text. Returns immediately for sync results (image/text) or with a task status for async results (video).',
			{
				nodeId: z.string().describe('ID of the node to generate from (must contain a prompt)'),
				modelId: z.string().describe('Model ID (from list_models)'),
				mode: z.string().optional().describe('Generation mode (e.g. text-to-image, first-frame, tts). Defaults to auto-inferred mode.'),
				params: z.record(z.union([z.string(), z.number()])).optional().describe('Model-specific parameters (from list_models params)'),
				batchCount: z.number().optional().default(1).describe('Number of parallel generations (1-4)'),
			},
			async ({ nodeId, modelId, mode, params, batchCount }) => {
				if (!this.runGeneration) throw new Error('Generation not available')
				const settings = this.getSettings?.()
				if (!settings) throw new Error('Settings not available')

				const canvas = requireCanvas(getCanvas)
				const node = findNode(canvas, nodeId)

				const model = getModelById(modelId)
				if (!model) throw new Error(`Model not found: ${modelId}`)

				const configured = getConfiguredProviderIds(settings)
				const pref = settings.modelPrefs[modelId]
				const provider = getActiveProvider(model, pref?.selectedProvider, configured)
				if (!provider) throw new Error(`No configured provider for model ${modelId}`)

				const apiModelId = model.supportedProviders[provider]?.apiModelId || modelId

				// Read prompt from node
				const nodeData = node.getData()
				let prompt = ''
				if (nodeData.type === 'text') {
					prompt = node.text?.trim() || nodeData.text?.trim() || ''
				} else if (nodeData.type === 'file' && /\.md$/i.test(nodeData.file || '')) {
					const file = this.app.vault.getAbstractFileByPath(nodeData.file)
					if (file instanceof TFile) prompt = (await this.app.vault.read(file)).trim()
				}
				if (!prompt) throw new Error('Node contains no prompt text')

				// Resolve params with defaults
				const resolvedParams: Record<string, string | number> = {}
				for (const p of model.params) {
					resolvedParams[p.id] = params?.[p.id] ?? p.default
				}

				const selectedMode = (mode as Mode) || model.modes[0] || null

				const panelResult: PanelResult = {
					prompt,
					model,
					activeProvider: provider,
					apiModelId,
					mode: selectedMode,
					params: resolvedParams,
					batchCount: Math.min(Math.max(batchCount || 1, 1), 4),
				}

				const { placeholderIds, expectedOutputType } = await this.runGeneration(node, panelResult)
				return ok({
					status: 'generation_started',
					modelId,
					provider,
					mode: selectedMode,
					placeholderIds,
					expectedOutputType,
					hint: expectedOutputType === 'video'
						? 'Video generation is async. Use list_pending_tasks / get_task_status to track progress.'
						: 'Generation runs in the background. Re-read the placeholder node to see when it is replaced with the result.',
				})
			},
		)

		registerTool(mcp,
			'list_pending_tasks',
			'List all pending async generation tasks (currently only video tasks are tracked). Empty array means no in-flight async work.',
			{},
			() => {
				if (!this.taskQueue) return ok([])
				const snapshots = this.taskQueue.getSnapshots()
				const now = Date.now()
				return ok(snapshots.map(s => ({
					taskId: s.taskId,
					modelName: s.modelName,
					providerName: s.providerName,
					sourceNodeId: s.sourceNodeId,
					placeholderNodeId: s.placeholderNodeId,
					canvasPath: s.canvasPath,
					elapsedMs: now - s.startedAt,
				})))
			},
		)

		registerTool(mcp,
			'create_nodes_batch',
			'Create multiple text nodes in a single canvas import. Much faster than calling create_text_node N times.',
			{
				nodes: z.array(z.object({
					text: z.string(),
					x: z.number(),
					y: z.number(),
					width: z.number().optional().default(300),
					height: z.number().optional().default(200),
					color: z.string().optional(),
				})).describe('Array of text node specs'),
			},
			({ nodes }) => {
				const canvas = requireCanvas(getCanvas)
				const full = canvas.getData()
				const created: string[] = []
				const newNodes = nodes.map(n => {
					const id = randomId()
					created.push(id)
					const node: AllCanvasNodeData = {
						id,
						type: 'text',
						text: n.text,
						x: n.x,
						y: n.y,
						width: n.width ?? 300,
						height: n.height ?? 200,
					}
					if (n.color) node.color = n.color
					return node
				})
				canvas.importData({
					...full,
					nodes: [...(full.nodes || []), ...newNodes],
				})
				void canvas.requestSave()
				return ok({ ids: created })
			},
		)

		registerTool(mcp,
			'connect_nodes_batch',
			'Create multiple edges in a single canvas import.',
			{
				edges: z.array(z.object({
					fromId: z.string(),
					toId: z.string(),
					fromSide: z.enum(['top', 'right', 'bottom', 'left']).optional().default('right'),
					toSide: z.enum(['top', 'right', 'bottom', 'left']).optional().default('left'),
					toEnd: z.enum(['none', 'arrow']).optional().default('arrow'),
					label: z.string().optional(),
				})),
			},
			({ edges }) => {
				const canvas = requireCanvas(getCanvas)
				const full = canvas.getData()
				const created: string[] = []
				const newEdges = edges.map(e => {
					if (!canvas.nodes.has(e.fromId)) throw new Error(`Node not found: ${e.fromId}`)
					if (!canvas.nodes.has(e.toId)) throw new Error(`Node not found: ${e.toId}`)
					if (e.fromId === e.toId) throw new Error(`Self-loop not allowed: ${e.fromId}`)
					const id = randomId()
					created.push(id)
					const edge: CanvasEdgeData = {
						id,
						fromNode: e.fromId,
						fromSide: e.fromSide,
						toNode: e.toId,
						toSide: e.toSide,
						toEnd: e.toEnd,
					}
					if (e.label) edge.label = e.label
					return edge
				})
				canvas.importData({
					...full,
					edges: [...(full.edges || []), ...newEdges],
				})
				void canvas.requestSave()
				return ok({ edgeIds: created })
			},
		)

		registerTool(mcp,
			'update_nodes_batch',
			'Update geometry and/or color of many nodes in a single canvas import. Much faster than calling update_node N times. Use this for layout/cleanup passes on large canvases.',
			{
				updates: z.array(z.object({
					id: z.string(),
					x: z.number().optional(),
					y: z.number().optional(),
					width: z.number().optional(),
					height: z.number().optional(),
					color: z.string().optional(),
				})).describe('Array of partial node updates (text is NOT supported here — use update_node for text edits)'),
			},
			({ updates }) => {
				const canvas = requireCanvas(getCanvas)
				const full = canvas.getData()
				const byId = new Map(updates.map(u => [u.id, u]))
				const nodes = full.nodes.map((n) => {
					const u = byId.get(n.id)
					if (!u) return n
					const next = { ...n }
					if (u.x !== undefined) next.x = u.x
					if (u.y !== undefined) next.y = u.y
					if (u.width !== undefined) next.width = u.width
					if (u.height !== undefined) next.height = u.height
					if (u.color !== undefined) next.color = u.color
					return next
				})
				const applied = updates.filter(u => canvas.nodes.has(u.id)).map(u => u.id)
				const missing = updates.filter(u => !canvas.nodes.has(u.id)).map(u => u.id)
				canvas.importData({ ...full, nodes })
				void canvas.requestSave()
				return ok({ applied, missing })
			},
		)

		registerTool(mcp,
			'create_group_node',
			'Create a group node (a labelled rectangular frame around a region of the canvas). Use this to visually partition a cluttered canvas into chapters / scenes / stages.',
			{
				label: z.string().optional().describe('Text shown in the group header'),
				x: z.number(),
				y: z.number(),
				width: z.number(),
				height: z.number(),
				color: z.string().optional().describe('Canvas color ("1".."6" or hex)'),
			},
			({ label, x, y, width, height, color }) => {
				const canvas = requireCanvas(getCanvas)
				const full = canvas.getData()
				const id = randomId()
				const newNode: AllCanvasNodeData = { id, type: 'group', x, y, width, height }
				if (label) newNode.label = label
				if (color) newNode.color = color
				canvas.importData({ ...full, nodes: [...(full.nodes || []), newNode] })
				void canvas.requestSave()
				return ok({ id })
			},
		)

		registerTool(mcp,
			'arrange_in_grid',
			'Lay out the given nodes in a grid. Preserves each node\'s current width/height; only moves x/y. Typical cleanup call for a cluttered canvas.',
			{
				ids: z.array(z.string()).describe('Node IDs in desired reading order (left-to-right, top-to-bottom)'),
				cols: z.number().describe('Columns in the grid'),
				originX: z.number().optional().default(0).describe('Top-left x of the grid'),
				originY: z.number().optional().default(0).describe('Top-left y of the grid'),
				gap: z.number().optional().default(80).describe('Pixel gap between cells'),
				cellWidth: z.number().optional().describe('Override cell width (default: max width among provided nodes)'),
				cellHeight: z.number().optional().describe('Override cell height (default: max height among provided nodes)'),
			},
			({ ids, cols, originX, originY, gap, cellWidth, cellHeight }) => {
				const canvas = requireCanvas(getCanvas)
				if (cols < 1) throw new Error('cols must be >= 1')
				const full = canvas.getData()
				const nodeById = new Map<string, AllCanvasNodeData>()
				for (const n of (full.nodes || [])) nodeById.set(n.id, n)
				const missing = ids.filter(id => !nodeById.has(id))
				if (missing.length > 0) throw new Error(`Nodes not found: ${missing.join(', ')}`)

				const targetNodes = ids
					.map(id => nodeById.get(id))
					.filter((node): node is AllCanvasNodeData => node !== undefined)
				const cw = cellWidth ?? Math.max(...targetNodes.map(n => n.width || 300))
				const ch = cellHeight ?? Math.max(...targetNodes.map(n => n.height || 200))

				const updates = new Map<string, { x: number; y: number }>()
				ids.forEach((id, i) => {
					const col = i % cols
					const row = Math.floor(i / cols)
					updates.set(id, {
						x: originX + col * (cw + gap),
						y: originY + row * (ch + gap),
					})
				})

				const nodes = full.nodes.map((n) => {
					const u = updates.get(n.id)
					return u ? { ...n, x: u.x, y: u.y } : n
				})
				canvas.importData({ ...full, nodes })
				void canvas.requestSave()
				return ok({
					moved: ids.length,
					cellWidth: cw,
					cellHeight: ch,
					rows: Math.ceil(ids.length / cols),
					cols,
				})
			},
		)

		registerTool(mcp,
			'create_file_node',
			'Create a file node on the canvas referencing an existing vault file (image/video/audio/md).',
			{
				filePath: z.string().describe('Vault-relative file path'),
				x: z.number(),
				y: z.number(),
				width: z.number().optional().default(400),
				height: z.number().optional().default(400),
			},
			({ filePath, x, y, width, height }) => {
				const canvas = requireCanvas(getCanvas)
				const file = this.app.vault.getAbstractFileByPath(filePath)
				if (!file) throw new Error(`File not found in vault: ${filePath}`)
				const id = randomId()
				const full = canvas.getData()
				const newNode = { id, type: 'file' as const, file: filePath, x, y, width, height }
				canvas.importData({ ...full, nodes: [...(full.nodes || []), newNode] })
				void canvas.requestSave()
				return ok({ id })
			},
		)

		registerTool(mcp,
			'upload_image_as_node',
			'Write a base64-encoded image to the canvas\'s output directory (_bragi/assets by default) and create a file node for it.',
			{
				base64: z.string().describe('Base64 string (no data: prefix needed)'),
				filename: z.string().describe('Suggested filename with extension, e.g. "ref.png"'),
				x: z.number(),
				y: z.number(),
				width: z.number().optional().default(400),
				height: z.number().optional().default(400),
			},
			async ({ base64, filename, x, y, width, height }) => {
				const canvas = requireCanvas(getCanvas)
				const outputDir = this.getOutputDir?.() || '_bragi/assets'
				// Strip data: prefix if present
				const cleaned = base64.replace(/^data:[^;]+;base64,/, '')
				const binary = Uint8Array.from(atob(cleaned), c => c.charCodeAt(0)).buffer
				// Dedupe filename
				const safeName = filename.replace(/[^\w.-]/g, '_')
				let finalPath = `${outputDir}/${safeName}`
				let suffix = 1
				while (this.app.vault.getAbstractFileByPath(finalPath)) {
					const dot = safeName.lastIndexOf('.')
					const stem = dot >= 0 ? safeName.slice(0, dot) : safeName
					const ext = dot >= 0 ? safeName.slice(dot) : ''
					finalPath = `${outputDir}/${stem}_${suffix}${ext}`
					suffix++
				}
				// Ensure directory exists
				const adapter = this.app.vault.adapter
				const parts = outputDir.split('/')
				let cur = ''
				for (const p of parts) {
					cur = cur ? `${cur}/${p}` : p
					if (!(await adapter.exists(cur))) await adapter.mkdir(cur)
				}
				await adapter.writeBinary(finalPath, binary)
				const id = randomId()
				const full = canvas.getData()
				const newNode = { id, type: 'file' as const, file: finalPath, x, y, width, height }
				canvas.importData({ ...full, nodes: [...(full.nodes || []), newNode] })
				void canvas.requestSave()
				return ok({ id, filePath: finalPath })
			},
		)

		registerTool(mcp,
			'set_asset_id',
			'Bind a Volcengine/BytePlus Asset ID to an image file node. Used for Seedance face-reference (asset://<id> protocol). Pass empty string to clear.',
			{
				nodeId: z.string(),
				assetId: z.string().describe('Asset ID like asset-20260403175316-... or "" to clear'),
			},
			({ nodeId, assetId }) => {
				const canvas = requireCanvas(getCanvas)
				const node = findNode(canvas, nodeId)
				const d = node.getData() as BragiCanvasNodeData
				if (d.type !== 'file' || !/\.(png|jpg|jpeg|webp|gif)$/i.test(d.file || '')) {
					throw new Error('Asset ID only applies to image file nodes')
				}
				const next = { ...d }
				if (assetId) next.bragiAssetId = assetId
				else delete next.bragiAssetId
				node.setData(next)
				void canvas.requestSave()
				return ok({ nodeId, assetId: assetId || null })
			},
		)

		registerTool(mcp,
			'get_active_canvas_info',
			'Get path and stats for the currently active canvas (or null if no canvas is open).',
			{},
			() => {
				const canvas = getCanvas()
				if (!canvas) return ok(null)
				const data = canvas.getData()
				const file = (this.app.workspace.getLeaf(false)?.view as unknown as FileView | undefined)?.file
				return ok({
					path: file?.path || null,
					basename: file?.basename || null,
					nodeCount: (data.nodes || []).length,
					edgeCount: (data.edges || []).length,
				})
			},
		)

		registerTool(mcp,
			'list_canvases',
			'List every .canvas file in the vault.',
			{},
			() => {
				const files = this.app.vault.getFiles().filter(f => f.extension === 'canvas')
				return ok(files.map(f => ({ path: f.path, basename: f.basename })))
			},
		)

		registerTool(mcp,
			'open_canvas',
			'Switch the active tab to the given .canvas file. Requires user confirmation via a modal; throws "cancelled by user" if the user declines.',
			{ path: z.string().describe('Vault-relative .canvas file path') },
			async ({ path }) => {
				const file = this.app.vault.getAbstractFileByPath(path)
				if (!file || !(file instanceof TFile)) throw new Error(`Canvas not found: ${path}`)
				if (file.extension !== 'canvas') throw new Error(`Not a .canvas file: ${path}`)
				const confirmed = await confirmOpenCanvas(this.app, file.basename)
				if (!confirmed) throw new Error('cancelled by user')
				await this.app.workspace.getLeaf().openFile(file)
				return ok({ path: file.path })
			},
		)

		registerTool(mcp,
			'get_task_status',
			'Get status of an async task by taskId. Returns "pending" if still in-flight, or "not_found" if already completed/failed (inspect the placeholder node to see the result).',
			{ taskId: z.string().describe('Task ID returned by list_pending_tasks') },
			({ taskId }) => {
				if (!this.taskQueue) return ok({ status: 'not_found', taskId })
				const snap: TaskSnapshot | undefined = this.taskQueue.getSnapshots().find(s => s.taskId === taskId)
				if (!snap) return ok({ status: 'not_found', taskId })
				return ok({
					status: 'pending',
					taskId: snap.taskId,
					modelName: snap.modelName,
					providerName: snap.providerName,
					sourceNodeId: snap.sourceNodeId,
					placeholderNodeId: snap.placeholderNodeId,
					canvasPath: snap.canvasPath,
					elapsedMs: Date.now() - snap.startedAt,
				})
			},
		)
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

function confirmOpenCanvas(app: App, basename: string): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new Modal(app)
		modal.titleEl.setText('Switch canvas?')
		modal.contentEl.createEl('p', {
			text: `An MCP client is requesting to open "${basename}.canvas". Allow?`,
		})
		const btnRow = modal.contentEl.createDiv({ cls: 'modal-button-container' })
		const cancelBtn = btnRow.createEl('button', { text: 'Cancel' })
		const okBtn = btnRow.createEl('button', { text: 'Open', cls: 'mod-cta' })
		let decided = false
		cancelBtn.onclick = () => { decided = true; resolve(false); modal.close() }
		okBtn.onclick = () => { decided = true; resolve(true); modal.close() }
		modal.onClose = () => { if (!decided) resolve(false) }
		modal.open()
	})
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

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

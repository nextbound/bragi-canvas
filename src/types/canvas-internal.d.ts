import { App } from 'obsidian'
import { AllCanvasNodeData, CanvasData } from 'obsidian/canvas'

export interface CanvasNode {
	id: string
	app: App
	canvas: Canvas
	child: Partial<CanvasNode>
	color: string
	containerEl: HTMLElement
	contentEl: HTMLElement
	height: number
	initialized: boolean
	isEditing: boolean
	nodeEl: HTMLElement
	text: string
	unknownData: Record<string, string>
	width: number
	x: number
	y: number
	zIndex: number
	file?: { path: string }
	subpath?: string
	focus(): void
	getBBox?(): { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number }
	getData(): AllCanvasNodeData
	initialize(): void
	moveAndResize(options: MoveAndResizeOptions): void
	render(): void
	setData(data: Partial<AllCanvasNodeData>): void
	setText(text: string): Promise<void>
	showMenu(): void
	startEditing(): void
}

export interface MoveAndResizeOptions {
	x?: number
	y?: number
	width?: number
	height?: number
}

export interface CanvasEdge {
	id: string
	from: { node: CanvasNode; side: string }
	to: { node: CanvasNode; side: string }
}

export interface Canvas {
	edges: CanvasEdge[]
	selection: Set<CanvasNode>
	nodes: Map<string, CanvasNode>
	wrapperEl: HTMLElement | null
	/** Obsidian internal: center of the current viewport in canvas coordinates. */
	posCenter?: () => { x: number; y: number }
	/** Obsidian internal viewport state, present on some Canvas builds. */
	x?: number
	y?: number
	tx?: number
	ty?: number
	zoom?: number
	tZoom?: number
	scale?: number
	zoomCenter?: { x: number; y: number } | null
	finishViewportAnimation?: boolean
	addNode(node: CanvasNode): void
	createTextNode(options: CreateNodeOptions): CanvasNode
	deselectAll(): void
	getData(): CanvasData
	getEdgesForNode(node: CanvasNode): CanvasEdge[]
	importData(data: { nodes: object[]; edges: object[] }): void
	markViewportChanged?(): void
	panTo?(x: number, y: number): void
	removeNode(node: CanvasNode): void
	requestFrame(): Promise<void>
	requestSave(): Promise<void>
	selectOnly(node: CanvasNode, startEditing: boolean): void
	setViewport?(x: number, y: number, zoom: number): void
	zoomToBbox?(bbox: { minX: number; minY: number; maxX: number; maxY: number; width?: number; height?: number }): void
	zoomToSelection?(): void
}

export interface CreateNodeOptions {
	text: string
	pos?: { x: number; y: number }
	position?: 'left' | 'right' | 'top' | 'bottom'
	size?: { height?: number; width?: number }
	focus?: boolean
}

import { Notice } from 'obsidian'
import type { AudioProvider, VideoProvider } from './providers/types'
import type { Canvas, CanvasNode } from './types/canvas-internal'
import { markNodeFailed, detachGeneratingOverlay } from './canvas-ops'
import { classifyTaskError, errorMessage } from './task-errors'

export type TaskState = 'waiting-canvas' | 'polling' | 'retrying' | 'needs-attention' | 'ready-to-apply'
export interface TaskSnapshot {
	taskId: string
	providerName: string
	apiModelId: string
	modelName: string
	canvasPath: string
	sourceNodeId: string
	placeholderNodeId: string
	outputDir: string
	startedAt: number
	outputType?: 'video' | 'audio'
	state?: TaskState
	retryCount?: number
	nextRetryAt?: number
	lastError?: string
	filePath?: string
}
interface TaskRuntime {
	provider?: VideoProvider | AudioProvider
	canvas: Canvas
}
interface TaskRecord {
	snapshot: TaskSnapshot
	runtime?: TaskRuntime
}
interface PendingTask extends TaskRuntime {
	snapshot: TaskSnapshot
	placeholder: CanvasNode
	sourceNode: CanvasNode
}
const STATES = new Set<TaskState>(['waiting-canvas', 'polling', 'retrying', 'needs-attention', 'ready-to-apply'])
export const taskKey = (task: Pick<TaskSnapshot, 'providerName' | 'taskId'>): string => JSON.stringify([task.providerName, task.taskId])

/** Pure legacy snapshot decoder. File/task state is separate from settings migrations. */
export function decodeTaskSnapshots(value: unknown): TaskSnapshot[] {
	if (!Array.isArray(value)) return []
	const result = new Map<string, TaskSnapshot>()
	for (const item of value) {
		if (!item || typeof item !== 'object') continue
		const raw = item as Record<string, unknown>
		const fields = ['taskId', 'providerName', 'apiModelId', 'modelName', 'canvasPath', 'sourceNodeId', 'placeholderNodeId', 'outputDir'] as const
		if (!fields.every(field => typeof raw[field] === 'string') || !raw.taskId || !raw.providerName) continue
		const record = Object.fromEntries(fields.map(field => [field, raw[field]])) as Pick<TaskSnapshot, typeof fields[number]>
		const snapshot: TaskSnapshot = {
			...record,
			startedAt: typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt) ? raw.startedAt : Date.now(),
			outputType: raw.outputType === 'audio' ? 'audio' : 'video',
			state: typeof raw.state === 'string' && STATES.has(raw.state as TaskState) ? raw.state as TaskState : 'waiting-canvas',
		}
		for (const field of ['filePath', 'lastError'] as const) if (typeof raw[field] === 'string') snapshot[field] = raw[field]
		for (const field of ['retryCount', 'nextRetryAt'] as const) if (typeof raw[field] === 'number' && Number.isFinite(raw[field]) && raw[field] >= 0) snapshot[field] = raw[field]
		result.set(taskKey(snapshot), snapshot)
	}
	return [...result.values()]
}

/** One source of truth for dormant, running and recoverable generation tasks. */
export class TaskQueue {
	private tasks = new Map<string, TaskRecord>()
	private interval: number | null = null
	private inFlight = new Set<string>()
	private epoch = 0
	private stopped = false
	onChange: (() => void | Promise<void>) | null = null
	onComplete: ((filePath: string, canvasPath: string) => void | Promise<void>) | null = null
	isCanvasLive: ((canvas: Canvas, path: string) => boolean) | null = null

	restore(value: unknown): void {
		for (const snapshot of decodeTaskSnapshots(value)) this.tasks.set(taskKey(snapshot), { snapshot })
	}
	start(): void {
		if (this.interval !== null || this.stopped) return
		this.interval = window.setInterval(() => { void this.pollAll().catch(error => console.error('Bragi task persistence:', error)) }, 5000)
	}
	stop(): void {
		this.stopped = true
		this.epoch++
		this.stopTimer()
		for (const task of this.tasks.values()) task.runtime = undefined
	}
	private stopTimer(): void {
		if (this.interval !== null) window.clearInterval(this.interval)
		this.interval = null
	}
	async addTask(task: PendingTask): Promise<void> {
		const key = taskKey(task.snapshot)
		if (this.tasks.has(key)) return
		this.tasks.set(key, { snapshot: { ...task.snapshot, state: 'polling' }, runtime: task })
		try { await this.persist() } catch (error) {
			const saved = this.tasks.get(key)!
			saved.snapshot.state = 'needs-attention'
			saved.snapshot.lastError = `Could not save task: ${errorMessage(error)}`
			new Notice('Task accepted, but could not be saved. Fix storage and use resume checking.')
		}
		this.start()
	}
	hasTask(taskId: string, providerName?: string): boolean {
		return [...this.tasks.values()].some(({ snapshot }) => snapshot.taskId === taskId && (!providerName || snapshot.providerName === providerName))
	}
	getSnapshots(): TaskSnapshot[] { return [...this.tasks.values()].map(task => ({ ...task.snapshot })) }
	get activeCount(): number { return this.tasks.size }

	bindCanvas(canvas: Canvas, path: string, makeProvider: (snapshot: TaskSnapshot) => VideoProvider | AudioProvider | null): void {
		if (this.stopped) return
		for (const task of this.tasks.values()) {
			if (task.snapshot.canvasPath !== path) continue
			if (task.runtime?.canvas === canvas && task.snapshot.state !== 'needs-attention') continue
			const provider = makeProvider(task.snapshot)
			if (!task.snapshot.filePath && !provider?.checkStatus) {
				task.snapshot.state = 'needs-attention'
				task.snapshot.lastError = 'Restore the provider connection, then resume checking.'
				continue
			}
			task.runtime = { canvas, provider: provider ?? undefined }
			if (task.snapshot.state === 'waiting-canvas') task.snapshot.state = task.snapshot.filePath ? 'ready-to-apply' : 'polling'
		}
		this.start()
	}
	resume(placeholderId?: string, canvasPath?: string): void {
		for (const task of this.tasks.values()) {
			if (placeholderId && task.snapshot.placeholderNodeId !== placeholderId) continue
			if (canvasPath && task.snapshot.canvasPath !== canvasPath) continue
			if (task.snapshot.state !== 'needs-attention' && task.snapshot.state !== 'retrying') continue
			task.snapshot.state = task.snapshot.filePath ? 'ready-to-apply' : task.runtime ? 'polling' : 'waiting-canvas'
			delete task.snapshot.lastError
			delete task.snapshot.nextRetryAt
			task.snapshot.retryCount = 0
		}
		void this.persist().catch(error => console.error('Bragi task save:', error))
		this.start()
	}
	private async persist(): Promise<void> { await this.onChange?.() }
	private live(task: TaskRecord): boolean {
		return !this.stopped && !!task.runtime && (this.isCanvasLive?.(task.runtime.canvas, task.snapshot.canvasPath) ?? true)
	}

	async pollAll(): Promise<void> {
		if (this.stopped) return
		const epoch = this.epoch
		await Promise.all([...this.tasks.entries()].map(async ([key, task]) => {
			if (this.inFlight.has(key) || task.snapshot.state === 'needs-attention') return
			if (!this.live(task)) {
				task.runtime = undefined
				if (!task.snapshot.filePath) task.snapshot.state = 'waiting-canvas'
				return
			}
			if ((task.snapshot.nextRetryAt || 0) > Date.now()) return
			const runtime = task.runtime!
			this.inFlight.add(key)
			try {
				if (!task.snapshot.filePath) {
					if (!runtime.provider?.checkStatus) throw new Error('Restore the provider connection, then resume checking.')
					const result = await runtime.provider.checkStatus(task.snapshot.taskId)
					if (epoch !== this.epoch) return
					if (!result.done) {
						task.snapshot.state = 'polling'
						task.snapshot.retryCount = 0
						delete task.snapshot.nextRetryAt
						delete task.snapshot.lastError
						return
					}
					if (!result.filePath) throw new Error('Completed task did not provide an output file.')
					task.snapshot.filePath = result.filePath
				}
				task.snapshot.state = 'ready-to-apply'
				// Durably record the download before attempting Canvas changes.
				await this.persist()
				if (epoch !== this.epoch || task.runtime !== runtime || !this.live(task)) return
				await this.applyResult(task.snapshot, runtime.canvas)
				if (epoch !== this.epoch) return
				await this.onComplete?.(task.snapshot.filePath, task.snapshot.canvasPath)
				this.tasks.delete(key)
				try { await this.persist() } catch (error) { this.tasks.set(key, task); throw error }
				new Notice(`${task.snapshot.outputType === 'audio' ? 'Audio' : 'Video'} ready (${task.snapshot.modelName})`)
			} catch (error) {
				if (epoch !== this.epoch) return
				const classified = classifyTaskError(error)
				task.snapshot.lastError = classified.message.slice(0, 500)
				if (classified.kind === 'terminal') {
					const placeholder = runtime.canvas.nodes.get(task.snapshot.placeholderNodeId)
					if (placeholder && task.runtime === runtime && this.live(task)) {
						markNodeFailed(placeholder, classified.message)
						try {
							await runtime.canvas.requestSave()
							await runtime.canvas.view?.save?.()
						} catch (saveError) {
							task.snapshot.state = 'needs-attention'
							task.snapshot.lastError = `Remote task failed; could not save its failure: ${errorMessage(saveError)}`
							await this.persist()
							return
						}
					}
					this.tasks.delete(key)
					try { await this.persist() } catch (saveError) { this.tasks.set(key, task); task.snapshot.state = 'needs-attention'; throw saveError }
					new Notice(`${task.snapshot.modelName} failed: ${classified.message}`)
				} else if (classified.kind === 'retryable' && !task.snapshot.filePath) {
					const retry = task.snapshot.retryCount || 0
					task.snapshot.retryCount = retry + 1
					task.snapshot.nextRetryAt = Date.now() + Math.max(Math.min(5000 * 2 ** Math.min(retry, 4), 60000), classified.retryAfterMs || 0)
					task.snapshot.state = 'retrying'
				} else {
					task.snapshot.state = 'needs-attention'
					new Notice(`${task.snapshot.modelName}: ${errorMessage(error)}. Use Resume checking after fixing the issue.`)
				}
				await this.persist()
			} finally { this.inFlight.delete(key) }
		}))
		if (![...this.tasks.values()].some(task => task.runtime && task.snapshot.state !== 'needs-attention')) this.stopTimer()
	}

	private async applyResult(snapshot: TaskSnapshot, canvas: Canvas): Promise<void> {
		const data = canvas.getData()
		const index = data.nodes.findIndex(node => node.id === snapshot.placeholderNodeId)
		if (index < 0) {
			new Notice(`Result saved to ${snapshot.filePath}. Its placeholder was removed.`)
			return
		}
		const previous = data.nodes[index]
		// Retain the ID and edges: retries after a failed save are idempotent.
		data.nodes[index] = { id: previous.id, type: 'file', file: snapshot.filePath!, x: previous.x, y: previous.y, width: previous.width, height: previous.height }
		const existing = canvas.nodes.get(snapshot.placeholderNodeId)
		if (existing && previous.type !== 'file') {
			detachGeneratingOverlay(existing.id, existing.nodeEl || existing.containerEl)
			// Canvas import reuses runtime nodes by ID; remove the text instance first.
			canvas.removeNode(existing)
		}
		canvas.importData(data)
		await canvas.requestSave()
		await canvas.view?.save?.()
	}
}

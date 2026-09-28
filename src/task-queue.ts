import { Notice } from 'obsidian'
import type { AudioProvider, VideoProvider } from './providers/types'
import type { Canvas, CanvasNode } from './types/canvas-internal'
import { markNodeFailed, detachGeneratingOverlay, setGeneratingStatus } from './canvas-ops'
import { classifyTaskError, errorMessage } from './task-errors'

export const TASK_CHECK_WINDOW_MS = 15 * 60 * 1000
export const TASK_MAX_AUTO_RETRIES = 5
export type TaskState = 'waiting-canvas' | 'polling' | 'downloading' | 'retrying' | 'needs-attention' | 'ready-to-apply'
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
	checkDeadlineAt?: number
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
const STATES = new Set<TaskState>(['waiting-canvas', 'polling', 'downloading', 'retrying', 'needs-attention', 'ready-to-apply'])
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
		for (const field of ['retryCount', 'nextRetryAt', 'checkDeadlineAt'] as const) if (typeof raw[field] === 'number' && Number.isFinite(raw[field]) && raw[field] >= 0) snapshot[field] = raw[field]
		snapshot.checkDeadlineAt ??= snapshot.startedAt + TASK_CHECK_WINDOW_MS
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
	beforeResume: (() => void) | null = null
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
		this.tasks.set(key, { snapshot: { ...task.snapshot, state: 'polling', checkDeadlineAt: Date.now() + TASK_CHECK_WINDOW_MS }, runtime: task })
		try { await this.persist() } catch (error) {
			const saved = this.tasks.get(key)!
			saved.snapshot.state = 'needs-attention'
			saved.snapshot.lastError = `Could not save task: ${errorMessage(error)}`
			new Notice('Task accepted, but could not be saved. Fix storage and use resume checking.')
		}
		this.render(this.tasks.get(key)!)
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
			task.runtime = { canvas, provider: provider ?? undefined }
			if (!task.snapshot.filePath && !provider?.checkStatus) {
				task.snapshot.state = 'needs-attention'
				task.snapshot.lastError = 'Restore the provider connection, then resume checking.'
				this.render(task)
				continue
			}
			if (task.snapshot.state === 'waiting-canvas') task.snapshot.state = task.snapshot.filePath ? 'ready-to-apply' : 'polling'
			this.render(task)
		}
		this.start()
	}
	resume(placeholderId?: string, canvasPath?: string): void {
		this.beforeResume?.()
		for (const task of this.tasks.values()) {
			if (placeholderId && task.snapshot.placeholderNodeId !== placeholderId) continue
			if (canvasPath && task.snapshot.canvasPath !== canvasPath) continue
			if (task.snapshot.state !== 'needs-attention' && task.snapshot.state !== 'retrying') continue
			task.snapshot.state = task.snapshot.filePath ? 'ready-to-apply' : task.runtime ? 'polling' : 'waiting-canvas'
			delete task.snapshot.lastError
			delete task.snapshot.nextRetryAt
			task.snapshot.retryCount = 0
			task.snapshot.checkDeadlineAt = Date.now() + TASK_CHECK_WINDOW_MS
			this.render(task)
		}
		void this.persist().catch(error => console.error('Bragi task save:', error))
		this.start()
	}
	private async persist(): Promise<void> { await this.onChange?.() }
	private isPaused(task: TaskRecord): boolean { return task.snapshot.state === 'needs-attention' }
	private live(task: TaskRecord): boolean {
		return !this.stopped && !!task.runtime && (this.isCanvasLive?.(task.runtime.canvas, task.snapshot.canvasPath) ?? true)
	}
	private render(task: TaskRecord): void {
		if (!this.live(task)) return
		const node = task.runtime!.canvas.nodes.get(task.snapshot.placeholderNodeId)
		if (!node) return
		const { state, lastError, nextRetryAt, retryCount } = task.snapshot
		const paused = state === 'needs-attention'
		const retrying = state === 'retrying'
		const label = paused ? 'Checking paused' : retrying ? 'Waiting to retry'
			: state === 'downloading' ? 'Downloading result' : state === 'ready-to-apply' ? 'Saving result' : 'Waiting for provider'
		setGeneratingStatus(node, {
			label,
			paused: paused || retrying,
			detail: paused ? lastError : retrying ? `Connection interrupted. Retry ${retryCount}/${TASK_MAX_AUTO_RETRIES}.` : undefined,
			retryAt: retrying ? nextRetryAt : undefined,
			onResume: paused ? () => this.resume(task.snapshot.placeholderNodeId, task.snapshot.canvasPath) : undefined,
		})
	}
	private async pause(task: TaskRecord, message: string): Promise<void> {
		task.snapshot.state = 'needs-attention'
		task.snapshot.lastError = message
		delete task.snapshot.nextRetryAt
		this.render(task)
		await this.persist()
	}

	async pollAll(): Promise<void> {
		if (this.stopped) return
		const epoch = this.epoch
		await Promise.all([...this.tasks.entries()].map(async ([key, task]) => {
			if (task.snapshot.state === 'needs-attention') return
			// The deadline also stops the spinner while an HTTP or storage call is still in flight.
			// Its eventual result remains eligible for recovery; never submit a replacement task.
			if (Date.now() >= (task.snapshot.checkDeadlineAt ?? task.snapshot.startedAt + TASK_CHECK_WINDOW_MS)) {
				await this.pause(task, 'No result after 15 minutes of checking. The provider may still be working. Your task is saved; resume checking to continue.')
				return
			}
			if (this.inFlight.has(key)) return
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
					task.snapshot.state = 'polling'
					delete task.snapshot.nextRetryAt
					this.render(task)
					const result = await runtime.provider.checkStatus(task.snapshot.taskId, phase => {
						if (epoch !== this.epoch || task.runtime !== runtime || task.snapshot.state === 'needs-attention') return
						task.snapshot.state = phase
						this.render(task)
					})
					if (epoch !== this.epoch) return
					if (!result.done) {
						if (this.isPaused(task)) return
						const recovered = !!task.snapshot.retryCount || !!task.snapshot.lastError
						task.snapshot.state = 'polling'
						task.snapshot.retryCount = 0
						delete task.snapshot.nextRetryAt
						delete task.snapshot.lastError
						this.render(task)
						if (recovered) await this.persist()
						return
					}
					if (!result.filePath) throw new Error('Completed task did not provide an output file.')
					task.snapshot.filePath = result.filePath
				}
				task.snapshot.state = 'ready-to-apply'
				this.render(task)
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
				if (this.isPaused(task)) return
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
							this.render(task)
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
					if (task.snapshot.retryCount > TASK_MAX_AUTO_RETRIES) {
						await this.pause(task, `Automatic checks stopped after ${TASK_MAX_AUTO_RETRIES} retries. ${classified.message}. Your task is saved; resume checking when the connection recovers.`)
						return
					}
				} else {
					task.snapshot.state = 'needs-attention'
					new Notice(`${task.snapshot.modelName}: ${errorMessage(error)}. Use Resume checking after fixing the issue.`)
				}
				if (this.tasks.has(key)) this.render(task)
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

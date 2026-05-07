import { Notice } from 'obsidian'
import type { VideoProvider } from './providers/types'
import type { Canvas, CanvasNode } from './types/canvas-internal'
import { replacePlaceholderWithFile, markNodeFailed } from './canvas-ops'

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
}

interface PendingTask {
	snapshot: TaskSnapshot
	provider: VideoProvider
	canvas: Canvas
	placeholder: CanvasNode
	sourceNode: CanvasNode
}

export class TaskQueue {
	private tasks: PendingTask[] = []
	private interval: ReturnType<typeof setInterval> | null = null
	private pollIntervalMs = 5000
	/** Set of taskIds that are currently being processed (checkStatus in flight) —
	 *  prevents re-entering the same task from overlapping poll ticks when a single
	 *  poll takes longer than the interval. */
	private inFlight = new Set<string>()

	onChange: (() => void) | null = null

	start(): void {
		if (this.interval) return
		this.interval = activeWindow.setInterval(() => { void this.pollAll() }, this.pollIntervalMs)
	}

	stop(): void {
		if (this.interval) {
			activeWindow.clearInterval(this.interval)
			this.interval = null
		}
	}

	addTask(task: PendingTask): void {
		if (this.tasks.some(t => t.snapshot.taskId === task.snapshot.taskId)) return
		this.tasks.push(task)
		this.start()
		// No need to update placeholder text — the global overlay ticker does that now.
		this.onChange?.()
	}

	hasTask(taskId: string): boolean {
		return this.tasks.some(t => t.snapshot.taskId === taskId)
	}

	getSnapshots(): TaskSnapshot[] {
		return this.tasks.map(t => ({ ...t.snapshot }))
	}

	private async pollAll(): Promise<void> {
		if (this.tasks.length === 0) {
			this.stop()
			return
		}

		// Snapshot which tasks to poll this tick: skip ones still processing from a prior tick.
		const toPoll = this.tasks.filter(t => !this.inFlight.has(t.snapshot.taskId))
		const completedIds = new Set<string>()

		await Promise.all(toPoll.map(async (task) => {
			const id = task.snapshot.taskId
			this.inFlight.add(id)
			try {
				const result = await task.provider.checkStatus!(id)
				// Double-check nobody removed this task while we were awaiting
				if (!this.tasks.some(t => t.snapshot.taskId === id)) return

				if (result.done && result.filePath) {
					replacePlaceholderWithFile(task.canvas, task.placeholder, result.filePath, task.sourceNode)
					new Notice(`Video ready (${task.snapshot.modelName})`)
					completedIds.add(id)
				}
			} catch (err: unknown) {
				console.error(`Bragi Canvas: Task ${id} failed:`, err)
				if (this.tasks.some(t => t.snapshot.taskId === id)) {
					markNodeFailed(task.placeholder, err.message || 'Unknown error')
					new Notice(`${task.snapshot.modelName} failed: ${err.message}`)
					completedIds.add(id)
				}
			} finally {
				this.inFlight.delete(id)
			}
		}))

		if (completedIds.size > 0) {
			this.tasks = this.tasks.filter(t => !completedIds.has(t.snapshot.taskId))
			this.onChange?.()
		}

		if (this.tasks.length === 0) {
			this.stop()
		}
	}

	get activeCount(): number {
		return this.tasks.length
	}
}

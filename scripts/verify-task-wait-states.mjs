import assert from 'node:assert/strict'
import { testRuntime } from './test-runtime.mjs'

const { module: { TaskQueue, TASK_CHECK_WINDOW_MS, TaskPollingError, pollRequest, withTimeout }, cleanup } = await testRuntime(`
export * from './src/task-queue'; export * from './src/task-errors';
`)
globalThis.window = { setInterval: () => 1, clearInterval: () => {} }
const realNow = Date.now
let clock = realNow()
Date.now = () => clock
const snapshot = () => ({ taskId: 'accepted-task', providerName: 'test', apiModelId: 'test', modelName: 'Test', canvasPath: 'Test.canvas', sourceNodeId: 'source', placeholderNodeId: 'result', outputDir: 'assets', startedAt: clock })
function setup(checkStatus, overrides = {}) {
	const node = { id: 'result' }
	let data = { nodes: [{ id: 'result', type: 'text', x: 0, y: 0, width: 320, height: 240 }], edges: [] }
	const canvas = { nodes: new Map([['result', node]]), getData: () => structuredClone(data), removeNode: () => canvas.nodes.delete('result'), importData: value => { data = value }, requestSave: async () => {} }
	const queue = new TaskQueue()
	queue.restore([{ ...snapshot(), ...overrides }])
	queue.bindCanvas(canvas, 'Test.canvas', () => ({ checkStatus }))
	return { queue, node, canvas }
}

try {
	// A provider that keeps returning pending cannot keep the animation running forever.
	let checks = 0
	let saved
	let { queue, node } = setup(async () => { checks++; return { done: false } })
	queue.onChange = () => { saved = queue.getSnapshots() }
	await queue.pollAll()
	clock += TASK_CHECK_WINDOW_MS
	await queue.pollAll()
	assert.equal(checks, 1)
	assert.equal(saved[0].state, 'needs-attention')
	assert.equal(node.presentation.paused, true)
	assert.match(node.presentation.detail, /15 minutes/)
	await queue.pollAll()
	assert.equal(checks, 1)
	node.presentation.onResume()
	assert.equal(node.presentation.paused, false)
	assert.equal(queue.getSnapshots()[0].checkDeadlineAt, clock + TASK_CHECK_WINDOW_MS)
	await queue.pollAll()
	assert.equal(checks, 2)
	assert.equal(queue.getSnapshots()[0].taskId, 'accepted-task')
	queue.stop()

	// The watchdog also pauses an in-flight request; resuming never overlaps that request.
	let finish
	checks = 0
	;({ queue, node } = setup(() => { checks++; return new Promise(resolve => { finish = resolve }) }))
	const hungPoll = queue.pollAll()
	clock += TASK_CHECK_WINDOW_MS
	await queue.pollAll()
	assert.equal(node.presentation.paused, true)
	node.presentation.onResume()
	await queue.pollAll()
	assert.equal(checks, 1)
	clock += TASK_CHECK_WINDOW_MS
	await queue.pollAll()
	finish({ done: false })
	await hungPoll
	assert.equal(queue.getSnapshots()[0].state, 'needs-attention', 'Late pending responses must not restart the spinner')
	queue.stop()

	// A late successful response is still recovered after the watchdog pauses checking.
	let completed
	;({ queue, node } = setup(() => new Promise(resolve => { completed = resolve })))
	const latePoll = queue.pollAll()
	clock += TASK_CHECK_WINDOW_MS
	await queue.pollAll()
	assert.equal(node.presentation.paused, true)
	completed({ done: true, filePath: 'assets/recovered.mp4' })
	await latePoll
	assert.equal(queue.activeCount, 0)
	queue.stop()

	// Reopening an expired snapshot must not reset its checking window.
	checks = 0
	;({ queue, node } = setup(async () => { checks++; return { done: false } }, { startedAt: clock - TASK_CHECK_WINDOW_MS - 1 }))
	await queue.pollAll()
	assert.equal(checks, 0)
	assert.equal(node.presentation.paused, true)
	queue.stop()

	// Retry exhaustion persists across reloads; recovery uses the original accepted ID.
	const ids = []
	;({ queue, node } = setup(async id => { ids.push(id); throw new TaskPollingError('HTTP 502', 'retryable') }))
	for (const delay of [5000, 10000, 20000, 40000, 60000]) {
		await queue.pollAll()
		assert.equal(node.presentation.paused, true)
		assert.equal(node.presentation.retryAt, clock + delay)
		clock += delay
	}
	await queue.pollAll()
	assert.equal(queue.getSnapshots()[0].state, 'needs-attention')
	const retained = queue.getSnapshots()[0]
	queue.stop()
	;({ queue, node } = setup(async id => { ids.push(id); return { done: false } }, retained))
	await queue.pollAll()
	assert.equal(ids.length, 6)
	node.presentation.onResume()
	await queue.pollAll()
	assert.deepEqual(ids, Array(7).fill('accepted-task'))
	assert.equal(queue.getSnapshots()[0].retryCount, 0)
	queue.stop()

	// Downloading and non-retryable failures have distinct, truthful presentation.
	let rejectDownload
	;({ queue, node } = setup((_id, onProgress) => { onProgress('downloading'); return new Promise((_, reject) => { rejectDownload = reject }) }))
	const downloadPoll = queue.pollAll()
	assert.equal(node.presentation.label, 'Downloading result')
	rejectDownload(new Error('Invalid API key'))
	await downloadPoll
	assert.equal(node.presentation.paused, true)
	assert.match(node.presentation.detail, /Invalid API key/)
	queue.stop()

	// Inline resume refreshes the provider after the user repairs credentials.
	const auth = setup(async () => { throw new Error('Invalid API key') })
	await auth.queue.pollAll()
	let fixedChecks = 0
	auth.queue.beforeResume = () => auth.queue.bindCanvas(auth.canvas, 'Test.canvas', () => ({ checkStatus: async () => { fixedChecks++; return { done: false } } }))
	auth.node.presentation.onResume()
	await auth.queue.pollAll()
	assert.equal(fixedChecks, 1)
	assert.equal(auth.queue.getSnapshots()[0].state, 'polling')
	auth.queue.stop()

	// Hung HTTP calls time out without replay; successful calls clear their deadline timer.
	let requests = 0
	globalThis.__request = () => { requests++; return new Promise(() => {}) }
	await assert.rejects(pollRequest('https://example.test/task', 5), error => error.kind === 'retryable' && /timed out/.test(error.message))
	assert.equal(requests, 1)
	assert.equal(await withTimeout(Promise.resolve('done'), 5, new Error('timeout')), 'done')
	let rejectLate
	const lateFailure = withTimeout(new Promise((_, reject) => { rejectLate = reject }), 5, new Error('timeout'))
	await assert.rejects(lateFailure, /timeout/)
	rejectLate(new Error('late network error'))
	await new Promise(resolve => setImmediate(resolve))
	console.log('Task wait states: bounded retries, deadline watchdog, paused UI, resume identity, late recovery, download phase and HTTP timeouts passed.')
} finally {
	Date.now = realNow
	await cleanup()
}

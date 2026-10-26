import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { testRuntime } from './test-runtime.mjs'

const runtime = await testRuntime(`
export * from './src/seedance-draft';
export { SeedanceProvider, buildSeedanceRequestBody, buildSeedanceFinalRequestBody } from './src/providers/seedance';
export { TaskQueue, decodeTaskSnapshots } from './src/task-queue';
export { getActiveProvider, getModelById } from './src/models';
export { getConnectedConfiguredProviderIds } from './src/provider-model-prefs';
export { createMcpToolRegistry } from './src/mcp-tool-registry';
`)
Object.assign(globalThis.window, { setInterval: () => 1, clearInterval: () => {} })
const { SeedanceProvider, buildSeedanceRequestBody: buildDraft, buildSeedanceFinalRequestBody: buildFinal,
	getSeedanceDraft, decodeSeedanceDraft, canFinalizeSeedanceDraft, TaskQueue, decodeTaskSnapshots,
	getActiveProvider, getModelById, getConnectedConfiguredProviderIds, createMcpToolRegistry } = runtime.module
const draft = { providerId: 'byteplus', modelId: 'seedance-2.5', taskId: 'draft-task', apiModelId: 'ep-original-model', createdAt: Date.now() - 8 * 86400000, outputFormat: 'mov' }
const context = { catalogModelId: 'seedance-2.5', providerId: 'byteplus' }
const params = { modelId: draft.apiModelId, resolution: 'draft', genMode: 'image-ref', duration: '5', ratio: '9:16', generate_audio: 'true', output_format: 'mov', refImages: ['asset://reference-image'] }
const data = { id: 'draft-node', type: 'file', file: 'assets/draft.mov', x: 0, y: 0, width: 280, height: 400, bragiSeedanceDraft: draft }
const settings = () => ({ modelOrder: {}, providers: { byteplus: 'test-key', bytedance: 'test-key', svnewapi: 'test-key' }, modelPrefs: { 'seedance-2.5': { enabled: true, selectedProvider: 'byteplus' } }, providerModelPrefs: { byteplus: { 'seedance-2.5': true }, bytedance: { 'seedance-2.5': true }, svnewapi: { 'seedance-2.5': true } }, apiModelIdOverrides: { byteplus: { 'seedance-2.5': 'ep-current-model' } } })
try {
	// Draft is a BytePlus-only resolution choice; ordinary 480p stays ordinary.
	const body = buildDraft('Sailboat at sunrise', params, context)
	assert.deepEqual(body, { model: draft.apiModelId, content: [{ type: 'text', text: 'Sailboat at sunrise' }, { type: 'image_url', image_url: { url: 'asset://reference-image' }, role: 'reference_image' }], duration: 5, ratio: '9:16', resolution: '480p', generate_audio: true, watermark: false, output_format: 'mov', draft: true })
	assert.equal(buildDraft('Sailboat', { ...params, resolution: '480p' }, context).draft, undefined)
	for (const providerId of ['bytedance', 'svnewapi', undefined]) assert.throws(() => buildDraft('Sailboat', params, { ...context, providerId }), /only supported/)
	assert.throws(() => buildDraft('Sailboat', params, { ...context, catalogModelId: 'seedance-2.0' }), /only supported/)
	const s = settings()
	const tools = createMcpToolRegistry({ getCanvas: () => null, app: {}, getSettings: () => s })
	const listModels = tools.find(tool => tool.name === 'list_models')
	for (const provider of ['byteplus', 'bytedance', 'svnewapi']) {
		s.modelPrefs['seedance-2.5'].selectedProvider = provider
		const models = JSON.parse((await listModels.handler({ type: 'video' })).content[0].text)
		const resolution = models.find(model => model.id === 'seedance-2.5').params.find(param => param.id === 'resolution')
		assert.equal(resolution.options.some(option => option.value === 'draft'), provider === 'byteplus')
		assert.equal(resolution.default, '720p')
	}

	// Only task identity and explicitly reusable output settings reach final submission.
	const expectedFinal = { model: draft.apiModelId, content: [{ type: 'draft_task', draft_task: { id: draft.taskId } }], resolution: '1080p', output_format: 'mov', watermark: false }
	assert.deepEqual(buildFinal({ ...draft, prompt: 'Do not send', seed: 42, duration: 20, ratio: '1:1' }), expectedFinal)
	const requests = []
	globalThis.__request = async request => { requests.push(request); return { status: 200, json: { id: 'final-task' } } }
	const provider = new SeedanceProvider('current-account-key', {}, 'assets', 'https://example.test/tasks')
	assert.deepEqual(await provider.generateVideoFromDraft(draft), { done: false, taskId: 'final-task' })
	assert.equal(requests.length, 1)
	assert.equal(requests[0].headers.Authorization, 'Bearer current-account-key')
	assert.deepEqual(JSON.parse(requests[0].body), expectedFinal)
	for (const message of ['Draft task expired', 'Draft task does not belong to this account']) {
		globalThis.__request = async () => ({ status: 400, json: { error: { code: 'InvalidParameter', message } } })
		await assert.rejects(() => provider.generateVideoFromDraft(draft), error => error.message.includes(message))
	}
	assert.equal(canFinalizeSeedanceDraft(data, 'byteplus'), true, 'Age does not hide the action; the provider owns expiry errors')
	for (const active of ['bytedance', 'svnewapi', null]) assert.equal(canFinalizeSeedanceDraft(data, active), false)
	for (const changed of [{ bragiSeedanceDraft: undefined }, { type: 'text' }, { file: 'image.png' }, { bragiSeedanceDraft: { ...draft, providerId: 'bytedance' } }]) assert.equal(canFinalizeSeedanceDraft({ ...data, ...changed }, 'byteplus'), false)
	assert.equal(decodeSeedanceDraft({ ...draft, taskId: '' }), null)
	assert.equal(decodeSeedanceDraft({ ...draft, createdAt: NaN }), null)

	// A restart and failed local save retain draft metadata until writeback succeeds.
	const snapshot = { taskId: draft.taskId, providerName: 'byteplus', apiModelId: draft.apiModelId, modelName: 'Seedance 2.5', canvasPath: 'QA.canvas', sourceNodeId: 'source', placeholderNodeId: 'result', outputDir: 'assets', startedAt: Date.now(), outputType: 'video', seedanceDraft: draft }
	let queue = new TaskQueue()
	queue.restore(JSON.parse(JSON.stringify([snapshot])))
	assert.deepEqual(queue.getSnapshots()[0].seedanceDraft, draft)
	assert.equal(decodeTaskSnapshots([{ ...snapshot, taskId: 'unrelated-task' }])[0].seedanceDraft, undefined)
	let canvasData = { nodes: [{ id: 'result', type: 'text', text: 'Working', x: 200, y: 0, width: 280, height: 400 }], edges: [{ id: 'edge', fromNode: 'source', toNode: 'result' }] }
	let failSave = true, downloads = 0
	const canvas = { nodes: new Map([['result', { id: 'result' }]]), getData: () => structuredClone(canvasData), importData: value => { canvasData = value }, removeNode: node => canvas.nodes.delete(node.id), requestSave: async () => { if (failSave) throw new Error('Disk temporarily unavailable') } }
	queue.bindCanvas(canvas, 'QA.canvas', () => ({ checkStatus: async () => { downloads++; return { done: true, filePath: 'assets/draft.mov' } } }))
	await queue.pollAll()
	assert.equal(queue.getSnapshots()[0].state, 'needs-attention')
	const saved = JSON.parse(JSON.stringify(queue.getSnapshots())); queue.stop(); queue = new TaskQueue(); queue.restore(saved)
	failSave = false; queue.bindCanvas(canvas, 'QA.canvas', () => null); queue.resume(); await queue.pollAll()
	assert.deepEqual(getSeedanceDraft(canvasData.nodes[0]), draft)
	assert.equal(canvasData.nodes[0].id, 'result'); assert.equal(canvasData.edges[0].toNode, 'result'); assert.equal(downloads, 1); queue.stop()
	const finalQueue = new TaskQueue(); finalQueue.restore([{ ...snapshot, taskId: 'final-task', seedanceDraft: undefined, filePath: 'assets/final.mov' }]); finalQueue.bindCanvas(canvas, 'QA.canvas', () => null); await finalQueue.pollAll()
	assert.equal(getSeedanceDraft(canvasData.nodes[0]), null); finalQueue.stop()

	// Execute the production toolbar action: one submission, source preserved, normal error placeholders.
	const source = await readFile('src/main.ts', 'utf8')
	const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
	const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'BragiCanvas')
	const methods = cls.members.filter(m => m.name && ['startSeedanceFinal', 'canFinalizeDraftNode'].includes(m.name.getText(ast))).map(m => m.getText(ast)).join('\n')
	const code = ts.transpileModule(`class Subject { syncGenerating = new Set(); draftSubmissions = new Set(); ${methods} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
	const placeholders = [], queued = [], notices = []
	let submit, received
	const deps = { getSeedanceDraft, canFinalizeSeedanceDraft, getModelById, getActiveProvider, getConnectedConfiguredProviderIds, getCanvasFromNode: n => n.canvas,
		createPlaceholderNode: () => { const p = { id: 'result-' + placeholders.length }; placeholders.push(p); return p },
		setGeneratingStatus: () => {}, markNodeFailed: (node, message) => { node.error = message }, errorMessage: e => e.message,
		Notice: class { constructor(message) { notices.push(message) } }, getProvider: () => ({ makeVideo: () => ({ generateVideoFromDraft: async savedDraft => { received = savedDraft; return submit() } }) }) }
	const Subject = new Function(...Object.keys(deps), code + ';return Subject')(...Object.values(deps))
	const subject = new Subject(); subject.settings = settings(); subject.getCanvasPath = () => 'QA.canvas'; subject.getOutputDir = () => 'assets'
	subject.taskQueue = { getSnapshots: () => queued, addTask: async task => { queued.push(task.snapshot) } }
	const node = { id: data.id, canvas: {}, getData: () => data }
	assert.equal(subject.canFinalizeDraftNode(node), true)
	let finish; submit = () => new Promise(resolve => { finish = resolve })
	assert.equal(subject.startSeedanceFinal(node), 'result-0'); assert.equal(subject.startSeedanceFinal(node), null)
	finish({ done: false, taskId: 'accepted-final' }); await new Promise(resolve => setTimeout(resolve, 0))
	assert.deepEqual(received, draft); assert.equal(queued[0].apiModelId, 'ep-original-model'); assert.equal(queued[0].seedanceDraft, undefined)
	assert.equal(subject.startSeedanceFinal(node), null); queued.length = 0
	assert.equal(data.bragiSeedanceDraft.taskId, 'draft-task')
	for (const message of ['Draft task expired', 'Draft task does not belong to this account']) {
		submit = async () => { throw new Error(message) }; subject.startSeedanceFinal(node); await new Promise(resolve => setTimeout(resolve, 0))
		assert.equal(placeholders.at(-1).error, message); assert.equal(queued.length, 0)
	}
	subject.settings.modelPrefs['seedance-2.5'].selectedProvider = 'bytedance'; assert.equal(subject.canFinalizeDraftNode(node), false)
	subject.startSeedanceFinal(node); await new Promise(resolve => setTimeout(resolve, 0)); assert.match(placeholders.at(-1).error, /Connect Seedance/)
	subject.settings.modelPrefs['seedance-2.5'].selectedProvider = 'byteplus'; subject.settings.modelPrefs['seedance-2.5'].enabled = false; assert.equal(subject.canFinalizeDraftNode(node), false)
	console.log('Seedance draft: provider-scoped catalog/MCP, payloads, opaque model identity, durable node metadata, toolbar eligibility, duplicate submission and error placeholders passed.')
} finally { await runtime.cleanup() }

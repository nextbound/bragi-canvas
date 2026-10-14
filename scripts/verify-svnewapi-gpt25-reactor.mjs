import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { testRuntime } from './test-runtime.mjs'

const runtime = await testRuntime(`
export { SvNewApiImageProvider, SvNewApiVideoProvider } from './src/providers/svnewapi';
export { APIMartProvider } from './src/providers/apimart';
export { ALL_MODELS, getEnabledModels, isAggregated, isApiModelIdEditable } from './src/models';
export { getConnectedConfiguredProviderIds, enableModelWithProvider } from './src/provider-model-prefs';
export { getOrderedAudios } from './src/audio-refs';
export { getOrderedImages } from './src/ref-thumbnails';
export { getUpstreamInputs } from './src/edge-parser';
export { createMcpToolRegistry } from './src/mcp-tool-registry';
export { getSeedanceReferenceLimits } from './src/seedance-capabilities';
`)
const originalWindow = globalThis.window
// Skip image polling delays; retain bounded-operation deadline timers until their
// promises resolve and clear them, without running a real service or paid request.
globalThis.window = {
	setTimeout: (callback, delay) => delay === 3000 ? (queueMicrotask(callback), 0) : setTimeout(callback, delay),
	clearTimeout,
}
let requests = [], replies = [], writes = []
const reset = (...responses) => { requests = []; replies = responses; writes = [] }
globalThis.__request = async request => {
	requests.push(request)
	assert.ok(replies.length, `Unexpected request: ${request.url}`)
	return replies.shift()
}
const queued = { status: 202, headers: {}, json: { id: 'image_task', object: 'image.task', model: 'sv-gpt-image-2.5-flare', status: 'queued', progress: 0, created_at: 1 } }
const completedImage = { status: 200, headers: {}, json: { ...queued.json, status: 'completed', progress: 100, data: [{ url: 'https://media.example.test/result?signature=test' }] } }
const imageBytes = { status: 200, headers: { 'content-type': 'image/webp' }, arrayBuffer: new Uint8Array([82, 73, 70, 70]).buffer }
const app = { vault: { adapter: { exists: async () => true, writeBinary: async (path, bytes) => writes.push({ path, bytes: [...new Uint8Array(bytes)] }) } } }
try {
	const { SvNewApiImageProvider, SvNewApiVideoProvider, APIMartProvider, ALL_MODELS, getEnabledModels, getConnectedConfiguredProviderIds, enableModelWithProvider, isAggregated, isApiModelIdEditable } = runtime.module
	const model = ALL_MODELS.find(model => model.id === 'gpt-image-2.5')
	assert.ok(model.supportedProviders.svnewapi, 'The existing GPT Image 2.5 must offer SVRouter')
	assert.equal(isAggregated(model, 'svnewapi'), true)
	assert.equal(isApiModelIdEditable(model, 'svnewapi'), false)
	assert.deepEqual(ALL_MODELS.filter(model => /^gpt-image-2\.5/.test(model.id)).map(model => model.id), ['gpt-image-2.5'], 'Variants must remain inside one catalog model')
	const settings = { providers: { svnewapi: 'gateway-token', apimart: 'direct-token' }, modelPrefs: {}, providerModelPrefs: {} }
	const connected = model => getConnectedConfiguredProviderIds(settings, model)
	assert.deepEqual(getEnabledModels('image', [], settings.modelPrefs, connected), [], 'Adding provider support must not enable models')
	enableModelWithProvider(settings, 'gpt-image-2.5', 'apimart')
	enableModelWithProvider(settings, 'gpt-image-2.5', 'svnewapi')
	assert.equal(settings.modelPrefs['gpt-image-2.5'].selectedProvider, 'apimart', 'Connecting SVRouter must preserve the selected provider')
	const image = new SvNewApiImageProvider('gateway-token', app, 'assets', 'https://gateway.example.test')
	const direct = new APIMartProvider('direct-token', app, 'assets')
	for (const [variant, expected] of [['flare', 'flare'], ['sunburst', 'sunburst'], ['stale-choice', 'flare']]) {
		const params = { modelId: 'sv-gpt-image-2.5', variant, aspectRatio: '16:9', imageSize: '4K', quality: 'max', refImages: ['https://temp.bragi.now/ref.png'] }
		reset(queued, completedImage, imageBytes)
		await image.generateImage('A quiet lake', params)
		const gatewayBody = JSON.parse(requests[0].body)
		assert.deepEqual(gatewayBody, { model: `sv-gpt-image-2.5-${expected}`, prompt: 'A quiet lake', n: 1, size: '16:9', resolution: '4k', quality: 'max', image_urls: ['https://temp.bragi.now/ref.png'] })
		assert.equal(requests[0].url, 'https://gateway.example.test/v1/images/tasks')
		assert.equal(requests[1].headers.Authorization, 'Bearer gateway-token')
		assert.equal(requests[2].headers?.Authorization, undefined)
		assert.match(writes[0].path, /\.webp$/)
		reset({ status: 200, headers: {}, json: { data: [{ b64_json: 'AQID' }] } })
		await direct.generateImage('A quiet lake', { ...params, modelId: 'gpt-image-2.5' })
		assert.deepEqual(JSON.parse(requests[0].body), { ...gatewayBody, model: `gpt-image-2.5-${expected}` }, 'Direct APIMart payload must stay unchanged')
	}
	reset({ status: 200, json: { url: 'https://temp.bragi.now/ref.png' } }, { status: 200, json: { url: 'https://temp.bragi.now/mask.png' } }, queued, completedImage, imageBytes)
	await image.generateImage('Edit', { modelId: 'sv-gpt-image-2.5', refImages: ['data:image/png;base64,AQID'], mask_url: 'data:image/png;base64,BAU=', size: '1536x1024', resolution: '2k', background: 'transparent', output_format: 'webp', output_compression: 0, moderation: 'low' })
	const edit = JSON.parse(requests[2].body)
	assert.equal(edit.size, '1536x1024'); assert.equal(edit.resolution, '2k')
	assert.equal(edit.output_compression, 0); assert.equal(edit.mask_url, 'https://temp.bragi.now/mask.png')
	assert.notEqual(requests[0].headers.Authorization, 'Bearer gateway-token')
	for (const [params, pattern] of [
		[{ background: 'transparent', output_format: 'jpeg', refImages: ['data:image/png;base64,AQID'] }, /PNG|WebP/],
		[{ refImages: Array(17).fill('https://media.example.test/ref.png') }, /16/],
		[{ refImages: ['asset://image'] }, /public|HTTP/i],
		[{ refImages: ['http://localhost/ref.png'] }, /public/i],
	]) {
		reset()
		await assert.rejects(() => image.generateImage('Invalid', { modelId: 'sv-gpt-image-2.5', ...params }), pattern)
		assert.equal(requests.length, 0)
	}

	const reactor = ALL_MODELS.find(model => model.id === 'fast-h3-omni')
	assert.ok(reactor, 'Fast H3 Omni must be an addable catalog model')
	assert.equal(reactor.supportedProviders.svnewapi.apiModelId, 'sv-fast-h3-omni')
	assert.deepEqual(getEnabledModels('video', [], settings.modelPrefs, connected), [])
	enableModelWithProvider(settings, 'fast-h3-omni', 'svnewapi')
	assert.deepEqual(getEnabledModels('video', [], settings.modelPrefs, connected).map(model => model.id), ['fast-h3-omni'])
	assert.deepEqual(reactor.params.find(param => param.id === 'seconds').options.map(option => option.value), ['5.875', '8', '10.125', '12.25', '14.375'])
	assert.ok(!reactor.params.some(param => ['resolution', 'generate_audio'].includes(param.id)))
	const video = new SvNewApiVideoProvider('gateway-token', app, 'assets', 'https://gateway.example.test')
	const context = { catalogModelId: 'fast-h3-omni' }
	const videoTask = { status: 202, headers: {}, json: { id: 'video_1', object: 'video', model: 'sv-fast-h3-omni', status: 'queued', progress: 0, created_at: 1 } }
	reset(videoTask)
	assert.deepEqual(await video.generateVideo('The subject speaks', { modelId: 'sv-fast-h3-omni', seconds: '5.875', canvas: '9:16', genMode: 'first-last-frame', refImages: ['https://media.example.test/start.png', 'https://media.example.test/end.png'], refAudios: ['https://media.example.test/voice.mp3'], seed: 0, catalogModelId: 'wrong' }, context), { done: false, taskId: 'video_1' })
	assert.deepEqual(JSON.parse(requests[0].body), { model: 'sv-fast-h3-omni', prompt: 'The subject speaks', metadata: { seconds: 5.875, canvas: '9:16', reference_images: ['https://media.example.test/start.png', 'https://media.example.test/end.png'], reference_audios: ['https://media.example.test/voice.mp3'], first_frame_image: 'https://media.example.test/start.png', last_frame_image: 'https://media.example.test/end.png', seed: 0 } })
	for (const [params, pattern] of [
		[{ seconds: 6 }, /duration/], [{ canvas: '21:9' }, /canvas|ratio/],
		[{ refImages: Array(10).fill('https://media.example.test/ref.png') }, /9/],
		[{ refAudios: Array(4).fill('https://media.example.test/ref.mp3') }, /3/],
		[{ refAudios: ['https://media.example.test/ref.mp3'] }, /image/],
		[{ refVideos: ['https://media.example.test/ref.mp4'] }, /video/],
		[{ genMode: 'first-frame' }, /image/], [{ genMode: 'first-last-frame', refImages: ['https://media.example.test/ref.png'] }, /two|2/],
		[{ refImages: ['http://media.example.test/ref.png'] }, /HTTPS/],
		[{ seed: 0.5 }, /seed/], [{ resolution: '720p' }, /resolution|parameter/],
		[{ continue_from_clip_id: 'another' }, /parameter|continuation/],
	]) {
		reset()
		await assert.rejects(() => video.generateVideo('Invalid', { modelId: 'sv-fast-h3-omni', ...params }, context), pattern)
		assert.equal(requests.length, 0, 'Invalid Reactor input must fail before uploads and GPU submission')
	}
	reset(videoTask)
	await video.generateVideo('@Image1 speaks with @Audio2 while <Picture 2> watches <Audio 1>.', { modelId: 'sv-fast-h3-omni' }, context)
	assert.equal(JSON.parse(requests[0].body).prompt, '<Picture 1> speaks with <Audio 2> while <Picture 2> watches <Audio 1>.')
	reset({ status: 200, headers: {}, json: { ...videoTask.json, status: 'in_progress', metadata: { url: 'https://evil.example.test/steal' } } })
	assert.deepEqual(await video.checkStatus('video_1'), { done: false, taskId: 'video_1' })
	reset({ status: 200, headers: {}, json: { ...videoTask.json, status: 'completed', metadata: { url: 'https://evil.example.test/steal' } } }, { status: 200, headers: { 'content-type': 'video/mp4' }, arrayBuffer: new Uint8Array([0, 0, 1, 2]).buffer })
	const result = await video.checkStatus('video_1')
	assert.equal(result.done, true); assert.match(result.filePath, /\.mp4$/)
	assert.equal(requests[1].url, 'https://gateway.example.test/v1/videos/video_1/content')
	assert.equal(requests[1].headers.Authorization, 'Bearer gateway-token')
	assert.deepEqual(writes[0].bytes, [0, 0, 1, 2])
	reset({ status: 200, headers: {}, json: { ...videoTask.json, status: 'failed', error: { message: 'Session timed out' }, metadata: { url: 'https://evil.example.test/steal' } } })
	await assert.rejects(() => video.checkStatus('video_1'), error => error.kind === 'terminal' && /Session timed out/.test(error.message))
	reset({ status: 200, headers: {}, json: { ...videoTask.json, status: 'completed' } }, { status: 401, headers: {}, json: { error: { message: 'Invalid token' } } })
	await assert.rejects(() => video.checkStatus('video_1'), error => error.kind === 'attention')
	assert.equal(writes.length, 0)

	// Execute the production Canvas dispatch method, with actual drag-order and
	// edge helpers. Keep existing task recovery/persistence implementation intact.
	const source = await readFile('src/main.ts', 'utf8')
	const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
	const cls = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'BragiCanvas')
	const method = cls.members.find(method => method.name?.getText(ast) === 'runSingleGeneration').getText(ast)
	const code = ts.transpileModule(`class Subject { ${method} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
	const failures = [], queuedTasks = []
	const { getOrderedImages, getOrderedAudios, getUpstreamInputs, getSeedanceReferenceLimits } = runtime.module
	const dependencies = { getOrderedImages, getOrderedAudios, getSeedanceReferenceLimits, getProvider: () => ({ makeVideo: () => video }), setGeneratingStatus: () => {}, Notice: class {}, markNodeFailed: (_, message) => failures.push(message), errorMessage: String }
	const Subject = new Function(...Object.keys(dependencies), `${code};return Subject`)(...Object.values(dependencies))
	const subject = new Subject()
	subject.app = app; subject.settings = { providers: {} }; subject.getCanvasPath = () => 'scene.canvas'
	subject.taskQueue = { addTask: async task => queuedTasks.push(task.snapshot) }
	const prepared = []
	subject.prepareReferenceMedia = async (_, __, modality, path) => { prepared.push({ modality, path }); return `https://media.example.test/${path}` }
	const node = { id: 'prompt', getData: () => ({ type: 'text', bragiAudioOrder: ['bob.mp3', 'alice.mp3'] }) }
	const fileNode = (id, file) => ({ id, getData: () => ({ type: 'file', file }) })
	const edge = source => ({ from: { node: source }, to: { node }, getData: () => ({ toEnd: 'arrow', fromEnd: 'none' }) })
	const canvas = { getEdgesForNode: () => [edge(fileNode('alice', 'alice.mp3')), edge(fileNode('bob', 'bob.mp3')), edge(fileNode('alice2', 'alice.mp3')), edge(fileNode('face', 'face.png'))] }
	assert.deepEqual(getOrderedAudios(canvas, node), ['bob.mp3', 'alice.mp3'])
	reset(videoTask)
	await subject.runSingleGeneration(node, { model: reactor, activeProvider: 'svnewapi', apiModelId: 'sv-fast-h3-omni', mode: 'image-ref', params: { seconds: '8', canvas: '16:9' } }, canvas, { id: 'result' }, '<Audio 1> is Bob.', getUpstreamInputs(canvas, node), [], 'scene.canvas', 'assets')
	assert.deepEqual(failures, [])
	assert.deepEqual(JSON.parse(requests[0].body).metadata.reference_audios, ['https://media.example.test/bob.mp3', 'https://media.example.test/alice.mp3'])
	assert.deepEqual(prepared.filter(ref => ref.modality === 'audio').map(ref => ref.path), ['bob.mp3', 'alice.mp3'])
	assert.equal(queuedTasks[0].apiModelId, 'sv-fast-h3-omni'); assert.equal(queuedTasks[0].providerName, 'svnewapi')
	const { createMcpToolRegistry } = runtime.module
	const mcpNode = { id: 'mcp_prompt', text: 'A scene', getData: () => ({ type: 'text', text: 'A scene' }) }
	const mcpCanvas = { nodes: new Map([['mcp_prompt', mcpNode]]), requestFrame: async () => {} }
	let mcpResult
	settings.modelOrder = { image: [], video: [], text: [], audio: [] }
	const tools = createMcpToolRegistry({ getCanvas: () => mcpCanvas, app, getSettings: () => settings, runGeneration: async (_, result) => { mcpResult = result; return { placeholderIds: ['result'], expectedOutputType: 'video' } } })
	const generate = tools.find(tool => tool.name === 'generate')
	await generate.handler({ nodeId: 'mcp_prompt', modelId: 'fast-h3-omni', params: { seconds: '5.875', canvas: '9:16', seed: 0 } })
	assert.deepEqual(mcpResult.params, { seconds: '5.875', canvas: '9:16', seed: 0 }, 'Advanced seed=0 must survive the actual MCP boundary')
	assert.equal(mcpResult.apiModelId, 'sv-fast-h3-omni')
	console.log('SVRouter aggregated GPT Image 2.5, Reactor async transport, explicit model enablement and Canvas audio ordering passed.')
} finally {
	globalThis.window = originalWindow
	delete globalThis.__request
	await runtime.cleanup()
}

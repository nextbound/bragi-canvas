import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { testRuntime } from './test-runtime.mjs'

const runtime = await testRuntime(`
export { SeedanceProvider, buildSeedanceRequestBody } from './src/providers/seedance';
export { DashScopeVideoProvider } from './src/providers/dashscope';
export { MuleRouterVideoProvider } from './src/providers/mulerouter';
export { SeedreamProvider } from './src/providers/seedream';
export { ALL_MODELS, isApiModelIdEditable } from './src/models';
export { resolveApiModelId } from './src/provider-model-prefs';
export { getSeedanceReferenceLimits } from './src/seedance-capabilities';
`)

try {
	const { SeedanceProvider, buildSeedanceRequestBody, DashScopeVideoProvider, MuleRouterVideoProvider, SeedreamProvider, ALL_MODELS, isApiModelIdEditable, resolveApiModelId, getSeedanceReferenceLimits } = runtime.module
	const requests = []
	globalThis.__request = async request => {
		requests.push(request)
		return { status: 200, text: '', json: { id: 'task', output: { task_id: 'task' }, task_info: { id: 'task' }, data: [{ b64_json: 'AQID' }] } }
	}
	const app = { vault: { adapter: { exists: async () => true, writeBinary: async () => {} } } }
	const provider = new SeedanceProvider('test', app, 'assets')
	const context = { catalogModelId: 'seedance-2.5' }
	const image = 'https://example.test/image.png', video = 'https://example.test/video.mp4', audio = 'https://example.test/audio.wav'
	const refs = mode => mode === 'first-frame' || mode === 'image-ref' ? { refImages: [image] }
		: mode === 'first-last-frame' ? { refImages: [image, image] }
			: ['video-ref', 'video-edit', 'video-extend'].includes(mode) ? { refVideos: [video] } : {}
	const model = ALL_MODELS.find(m => m.id === context.catalogModelId)
	for (const mode of model.modes) {
		const params = { genMode: mode, ...refs(mode), duration: mode === 'video-edit' ? '-1' : '30', output_format: 'mov' }
		await provider.generateVideo('Test', { ...params, modelId: 'dreamina-seedance-2-5-260628' }, context)
		const baseline = JSON.parse(requests.at(-1).body)
		// Neither an opaque endpoint nor a misleading version in an API alias changes capabilities.
		for (const apiModelId of ['ep-custom-test', 'deployment/production', 'dreamina-seedance-2-0-test']) {
			await provider.generateVideo('Test', { ...params, modelId: apiModelId, catalogModelId: 'seedance-2.0' }, context)
			assert.deepEqual(JSON.parse(requests.at(-1).body), { ...baseline, model: apiModelId })
		}
	}
	const build = params => buildSeedanceRequestBody('Test', { modelId: 'ep-custom-test', ...params }, context)
	assert.equal(build({ genMode: 'image-ref', refImages: Array(30).fill(image) }).content.length, 31)
	assert.equal(build({ genMode: 'video-ref', refVideos: Array(10).fill(video), refAudios: Array(10).fill(audio) }).content.length, 21)
	assert.equal(build({ genMode: 'video-ref', refAudios: [audio] }).content[1].role, 'reference_audio')
	for (const [params, error] of [
		[{ genMode: 'image-ref', refImages: Array(31).fill(image) }, /up to 30/],
		[{ genMode: 'video-ref', refVideos: Array(11).fill(video) }, /up to 10/],
		[{ genMode: 'video-ref', refAudios: Array(11).fill(audio) }, /up to 10/],
		[{ duration: '31' }, /4 to 30/],
		[{ genMode: 'first-frame', refImages: [image], ratio: '16:9' }, /adaptive/],
		[{ genMode: 'video-edit', refVideos: [video], duration: '4' }, /Auto/],
	]) assert.throws(() => build(params), error)
	for (const catalogModelId of ['seedance-2.0', 'seedance-2.0-fast']) {
		const legacy = params => buildSeedanceRequestBody('Test', { modelId: 'alias-seedance-2.5', ...params }, { catalogModelId })
		assert.equal(legacy({ duration: '15' }).duration, 15)
		assert.equal(legacy({ output_format: 'mov' }).output_format, undefined)
		assert.throws(() => legacy({ duration: '16' }), /4 to 15/)
		assert.throws(() => legacy({ genMode: 'image-ref', refImages: Array(10).fill(image) }), /up to 9/)
		assert.throws(() => legacy({ genMode: 'video-edit', refVideos: [video] }), /does not support/)
		assert.throws(() => legacy({ genMode: 'video-ref', refAudios: [audio] }), /requires reference/)
	}
	const requestCount = requests.length
	await assert.rejects(() => provider.generateVideo('Test', { modelId: 'dreamina-seedance-2-5-260628' }), /catalog model identity/)
	await assert.rejects(() => provider.generateVideo('Test', { modelId: 'ep-test' }, { catalogModelId: 'wan-3.0' }), /catalog model identity/)
	await assert.rejects(() => provider.generateVideo('Test', {}, context), /API model ID is required/)
	assert.equal(requests.length, requestCount)

	// Execute the production dispatch method, including request construction and queue snapshots.
	const source = await readFile('src/main.ts', 'utf8')
	const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
	const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'BragiCanvas')
	const method = cls.members.find(m => m.name?.getText(ast) === 'runSingleGeneration').getText(ast)
	const code = ts.transpileModule(`class Subject { ${method} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
	const failures = [], queued = []
	const deps = { getOrderedImages: () => [], getSeedanceReferenceLimits, getAssetIds: () => ({}), getAssetIdsForFiles: () => ({}), getProvider: () => ({ makeVideo: () => provider }), setGeneratingStatus: () => {}, Notice: class {}, markNodeFailed: (_, error) => failures.push(error), errorMessage: String }
	const Subject = new Function(...Object.keys(deps), code + ';return Subject')(...Object.values(deps))
	const subject = new Subject()
	subject.settings = { providers: {} }; subject.app = app; subject.getCanvasPath = () => 'test.canvas'
	subject.taskQueue = { addTask: async task => queued.push(task.snapshot) }
	const settings = { apiModelIdOverrides: { byteplus: { 'seedance-2.5': 'ep-dispatch-test' } } }
	const apiModelId = resolveApiModelId(settings, 'byteplus', model)
	await subject.runSingleGeneration({ id: 'source' }, { model, activeProvider: 'byteplus', apiModelId, mode: 'text-to-video', params: { duration: '30', output_format: 'mov', catalogModelId: 'seedance-2.0' } }, {}, { id: 'placeholder' }, 'Test', { videos: [], audios: [], pdfs: [] }, [], 'test.canvas', 'assets')
	assert.deepEqual(failures, [])
	assert.equal(JSON.parse(requests.at(-1).body).model, 'ep-dispatch-test')
	assert.equal(JSON.parse(requests.at(-1).body).duration, 30)
	assert.equal(JSON.parse(requests.at(-1).body).output_format, 'mov')
	assert.equal(queued[0].apiModelId, 'ep-dispatch-test')
	assert.equal(queued[0].providerName, 'byteplus')

	// Internal identity travels outside params: compare complete wire requests for every Wan route.
	const dashscope = new DashScopeVideoProvider('test', app, 'assets')
	const wan27Routes = { 'text-to-video': 'wan2.7-t2v-2026-04-25', 'first-frame': 'wan2.7-i2v-2026-04-25', 'first-last-frame': 'wan2.7-i2v-2026-04-25', 'image-ref': 'wan2.7-r2v', 'video-ref': 'wan2.7-r2v', 'video-extend': 'wan2.7-i2v-2026-04-25', 'video-edit': 'wan2.7-videoedit' }
	for (const catalogModelId of ['wan-2.7', 'wan-3.0', 'happyhorse-1.1']) {
		const m = ALL_MODELS.find(m => m.id === catalogModelId)
		assert.equal(isApiModelIdEditable(m, 'dashscope'), false)
		for (const mode of m.modes) {
			const options = { modelId: resolveApiModelId({}, 'dashscope', m), genMode: mode, ...refs(mode) }
			await dashscope.generateVideo('Test', options)
			const baseline = structuredClone(requests.at(-1))
			await dashscope.generateVideo('Test', options, { catalogModelId })
			assert.deepEqual(requests.at(-1), baseline, `${catalogModelId}/${mode}: request changed`)
			const expected = catalogModelId === 'wan-2.7' ? wan27Routes[mode] : catalogModelId === 'wan-3.0' ? 'wan3.0-video' : ({ 'text-to-video': 'happyhorse-1.1-t2v', 'first-frame': 'happyhorse-1.1-i2v', 'image-ref': 'happyhorse-1.1-r2v', 'video-edit': 'happyhorse-1.0-video-edit' })[mode]
			assert.equal(JSON.parse(requests.at(-1).body).model, expected)
		}
	}
	const mule = new MuleRouterVideoProvider('test', app, 'assets')
	const muleParams = { modelId: 'wan2.7-i2v-spicy', genMode: 'first-frame', refImages: [image], refAudios: [audio], resolution: '720p' }
	await mule.generateVideo('Test', muleParams)
	const muleBaseline = structuredClone(requests.at(-1))
	await mule.generateVideo('Test', muleParams, { catalogModelId: 'wan-2.7' })
	assert.deepEqual(requests.at(-1), muleBaseline)
	assert.match(requests.at(-1).url, /wan2\.7-i2v-spicy\/generation$/)
	const seedream = new SeedreamProvider('test', app, 'assets')
	await seedream.generateImage('Test', { modelId: 'ep-seedream-test', resolution: '2K', aspectRatio: '16:9' })
	assert.equal(JSON.parse(requests.at(-1).body).model, 'ep-seedream-test')
	assert.equal(JSON.parse(requests.at(-1).body).size, '2848x1600')
	console.log('Video model identity: endpoint overrides, all Seedance modes/bounds, real dispatch, queue identity, Wan/HappyHorse wire parity and Seedream override passed.')
} finally {
	delete globalThis.__request
	await runtime.cleanup()
}

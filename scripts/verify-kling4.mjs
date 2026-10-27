import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { testRuntime } from './test-runtime.mjs'

const runtime = await testRuntime(`
export * from './src/kling-keyframes.ts';
export * from './src/kling4-media.ts';
export * from './src/providers/apimart-kling4-payload.ts';
export { APIMartProvider } from './src/providers/apimart.ts';
export { migrateSettings } from './src/settings-migrations.ts';
export { getModelById, getEnabledModels } from './src/models/index.ts';
export { createMcpToolRegistry } from './src/mcp-tool-registry.ts';
`)
try {
	const { buildApimartKling4Request: build, parseKlingKeyframes: parse, assertKeyframeBindings: bindings, validateKling4Durations: durations, readKling4MediaDuration, APIMartProvider, getModelById, getEnabledModels, createMcpToolRegistry } = runtime.module
	const image = n => `https://temp.bragi.now/image-${n}.png`
	const video = 'https://temp.bragi.now/video.mp4', audio = 'https://temp.bragi.now/audio.mp3'
	const block = (...entries) => `[Keyframes]\n${entries.join('\n')}\n[/Keyframes]`
	const frames = block('@Image3: Outside', '@Image1: Opening', '[@Image2]: Inside')
	const p = { refImages: [image(1), image(2), image(3)], genMode: 'keyframes' }
	assert.deepEqual(build('Scene'), { model: 'kling-v4', resolution: '720p', prompt: 'Scene', duration: 5, aspect_ratio: '16:9' })
	for (let duration = 3; duration <= 30; duration++) assert.equal(build('Scene', { duration }).duration, duration)
	for (const duration of [0, 2, 31, 3.5, '', '5seconds', 'source', NaN]) assert.throws(() => build('Scene', { duration }), /whole number/)
	for (const resolution of ['720p', '1080p', '1080P']) assert.equal(build('Scene', { resolution }).resolution, resolution.toLowerCase())
	assert.throws(() => build('Scene', { resolution: '4k' }), /resolution/)
	for (const ratio of ['16:9', '9:16', '1:1', '21:9']) assert.equal(build('Scene', { aspect_ratio: ratio }).aspect_ratio, ratio)
	assert.throws(() => build('Scene', { aspect_ratio: '4:3' }), /ratio/)
	for (const key of ['multi_shot', 'multi_prompt', 'element_list', 'negative_prompt', 'mode', 'audio', 'sound']) assert.throws(() => build('Scene', { [key]: 'false' }), /does not support/)
	for (const genMode of ['first-frame', 'first-last-frame']) {
		const count = genMode === 'first-frame' ? 1 : 2
		const body = build('', { genMode, refImages: [image(1), image(2)].slice(0, count) })
		assert.equal(body.prompt, undefined); assert.equal(body.aspect_ratio, undefined)
		assert.equal(body.first_frame_image, image(1)); assert.equal(body.last_frame_image, count === 2 ? image(2) : undefined)
		assert.throws(() => build('', { genMode }), /requires exactly/)
		for (const kind of ['refVideos', 'refAudios']) assert.throws(() => build('', { genMode, refImages: [image(1), image(2)].slice(0, count), [kind]: [video] }), /cannot include/)
	}
	const body = build(frames + '\nFollow @Image3 smoothly to @Image2.', p)
	assert.deepEqual(body.image_with_roles, [{ url: image(3), role: 'first_frame' }, { url: image(1), role: 'keyframe' }, { url: image(2), role: 'last_frame' }])
	assert.equal(body.prompt, '@Image1: Outside\n@Image2: Opening\n@Image3: Inside\nFollow @Image1 smoothly to @Image3.')
	assert.ok(!body.prompt.includes('[Keyframes]'))
	assert.equal(parse(block('@Image1:', '@Image2:'), 2).frames[1].role, 'keyframe')
	assert.equal(build(block('@Image1:'), { genMode: 'keyframes', refImages: [image(1)] }).prompt, undefined)
	assert.equal(parse('General camera direction.\n' + block(' @Image2 ： ', '', ' [@Image1] : End '), 2).frames[1].role, 'last_frame')
	assert.equal(parse(block('@Image1:', '[@Image1]:'), 1).frames.length, 2, 'A loop may use the same image for first and last')
	const maxFrames = block('@Image1:', ...Array.from({ length: 8 }, (_, i) => `@Image${i + 2}:`), '[@Image10]:')
	assert.equal(parse(maxFrames, 10).frames.length, 10)
	const invalidBlocks = [
		'', '[Keyframes]\n@Image1:', '[Keyframes]\n[/Keyframes]', block('[@Image1]:'),
		block('@Image1:', '[@Image2]:', '@Image3:'), block('@Image1:', '[@Image2]:', '[@Image3]:'),
		block('@Image0:'), block('@Image4:'), block('@Image1]:'), block('[@Image1:'), block('Image1:'),
		block('@Image1:') + '\n' + block('@Image2:'), block('@Image1:') + '\n@Image2 is missing.',
	]
	for (const text of invalidBlocks) assert.throws(() => parse(text, 3), /Keyframes|keyframes|@Image/)
	assert.throws(() => parse(block(...Array.from({ length: 10 }, (_, i) => `@Image${i + 1}:`)), 10), /eight intermediate/)
	assert.throws(() => build(frames, { ...p, genMode: 'image-ref' }), /Select Keyframes/)
	bindings(frames, ['a', 'b', 'c'], ['a', 'b', 'c'])
	assert.throws(() => bindings(frames, ['b', 'a', 'c'], ['a', 'b', 'c']), /has changed/)
	bindings(block('@Image1:'), ['a', 'b'], ['a'])
	const ref = build('Use @Image1.', { genMode: 'image-ref', refImages: [image(1)], refAudios: [audio] })
	assert.equal(ref.omni_reference_task_type, 'reference'); assert.equal(ref.first_frame_image, undefined)
	assert.deepEqual(ref.image_urls, [image(1)]); assert.deepEqual(ref.audio_urls, [audio]); assert.equal(ref.aspect_ratio, 'auto')
	const multi = build('Use references', { genMode: 'video-ref', refImages: [image(1)], refVideos: [video], refAudios: [audio], audio_setting: 'origin' })
	assert.equal(multi.audio_setting, 'origin'); assert.deepEqual(multi.video_urls, [video])
	assert.deepEqual(build('Use @Audio1', { genMode: 'video-ref', refAudios: [audio] }).audio_urls, [audio])
	assert.equal(build('Use @Audio1', { genMode: 'video-ref', refAudios: [audio] }).audio_setting, undefined)
	for (const [genMode, refs] of [['image-ref', {}], ['video-ref', {}], ['video-edit', {}], ['video-extend', {}]]) assert.throws(() => build('Scene', { genMode, ...refs }), /requires/)
	const edit = build('Replace the background', { genMode: 'video-edit', refVideos: [video], refImages: [image(1)] })
	assert.equal(edit.duration, undefined); assert.equal(edit.aspect_ratio, undefined); assert.equal(edit.audio_setting, 'origin'); assert.equal(edit.video_url, video); assert.deepEqual(edit.image_urls, [image(1)])
	assert.equal(build('Edit', { genMode: 'video-edit', refVideos: [video], edit_duration: '30', aspect_ratio: '9:16', audio_setting: 'auto' }).duration, 30)
	const extend = build('Continue the scene', { genMode: 'video-extend', refVideos: [video], refImages: [image(1)], aspect_ratio: '9:16', audio_setting: 'origin' })
	assert.equal(extend.omni_reference_task_type, 'extend'); assert.equal(extend.last_frame_image, image(1)); assert.equal(extend.audio_setting, undefined); assert.equal(extend.aspect_ratio, undefined)
	assert.throws(() => build('Extend', { genMode: 'video-extend', refVideos: [video], refImages: [image(1), image(2)] }), /at most one target/)
	for (const genMode of ['text-to-video', 'image-ref', 'video-ref', 'video-edit', 'video-extend']) assert.throws(() => build(' ', { genMode }), /requires a prompt/)
	for (const kind of ['refImages', 'refVideos', 'refAudios']) {
		const limit = { refImages: 10, refVideos: 5, refAudios: 3 }[kind]
		assert.throws(() => build('Scene', { genMode: 'video-ref', [kind]: Array(limit + 1).fill(video) }), /up to/)
	}
	assert.throws(() => build('Scene', { genMode: 'video-ref', refImages: Array(10).fill(image(1)), refVideos: Array(5).fill(video), refAudios: [audio] }), /fifteen/)
	assert.throws(() => build('Scene', { refPdfs: ['file.pdf'] }), /PDF/)
	assert.throws(() => build('Scene', { genMode: 'motion-control' }), /does not support/)
	durations('video-ref', [15, 15], [5, 30]); durations('video-edit', [40], []); durations('video-extend', [60], [])
	for (const [mode, videos, audios] of [['video-ref', [15, 16], []], ['video-edit', [2.9], []], ['video-ref', [], [4.9]], ['video-ref', [], [30.1]], ['video-ref', [NaN], []]]) assert.throws(() => durations(mode, videos, audios), /Kling|duration/)

	// Obsidian's Document.createEl appends to Document; the global createEl must
	// create an unattached media element so no second document root is inserted.
	globalThis.activeDocument = { createEl() { throw new Error('Must not append to Document') } }
	globalThis.createEl = () => ({ duration: 5.1, load() {}, removeAttribute() {}, set src(_value) { queueMicrotask(() => this.onloadedmetadata?.()) } })
	assert.equal(await readKling4MediaDuration({ vault: { adapter: { getResourcePath: path => path } } }, 'refs/sound.mp3', 'audio'), 5.1)
	delete globalThis.createEl
	delete globalThis.activeDocument

	const model = getModelById('kling-4.0')
	assert.deepEqual(Object.keys(model.supportedProviders), ['apimart'])
	assert.equal(model.modes.length, 8); assert.ok(model.modes.includes('keyframes'))
	assert.ok(!model.params.some(p => ['audio', 'sound', 'mode', 'multi_shot'].includes(p.id)))
	assert.ok(!getEnabledModels('video', [], {}, ['apimart']).includes(model), 'New models stay disabled')

	for (const version of [0, 1, 15]) {
		const migrated = runtime.module.migrateSettings({ settingsSchemaVersion: version, migrationProviders_1_9: false, providers: { apimart: 'test-only-key' } }).settings
		assert.notEqual(migrated.modelPrefs['kling-4.0']?.enabled, true, 'Legacy settings imports must not auto-enable a new catalog model')
		assert.notEqual(migrated.providerModelPrefs.apimart?.['kling-4.0'], true)
	}
	const enabled = runtime.module.migrateSettings({ settingsSchemaVersion: 15, migrationProviders_1_9: true, providers: { apimart: 'test-only-key' }, modelPrefs: { 'kling-4.0': { enabled: true, selectedProvider: 'apimart' } }, providerModelPrefs: { apimart: { 'kling-4.0': true } } }).settings
	assert.equal(enabled.modelPrefs['kling-4.0'].enabled, true, 'Explicit opt-in must survive settings load')

	const calls = [], writes = []
	const provider = new APIMartProvider('test-only-key', { vault: { adapter: { exists: async () => true, writeBinary: async (path, bytes) => writes.push({ path, bytes }), rename: async () => {} } } }, 'outputs')
	globalThis.__request = async options => {
		calls.push(options)
		if (options.url.endsWith('/videos/generations')) return { status: 200, json: { data: [{ task_id: 'task-kling4' }] } }
		if (options.url.endsWith('/tasks/task-kling4')) return { status: 200, json: { data: { status: 'completed', result: { videos: [{ url: ['https://result.invalid/video.mp4'] }] } } } }
		if (options.url.startsWith('https://temp.bragi.now/upload')) return { status: 200, json: { url: image('uploaded') } }
		if (options.url === 'https://result.invalid/video.mp4') return { status: 200, arrayBuffer: new Uint8Array([1, 2, 3]).buffer }
		throw new Error('Unexpected network request')
	}
	assert.deepEqual(await provider.generateVideo(frames, { ...p, modelId: 'kling-v4' }), { done: false, taskId: 'task-kling4' })
	assert.deepEqual(JSON.parse(calls.at(-1).body).image_with_roles.map(i => i.role), ['first_frame', 'keyframe', 'last_frame'])
	assert.equal(calls.at(-1).headers.Authorization, 'Bearer test-only-key')
	const count = calls.length
	await assert.rejects(() => provider.generateVideo(block('[@Image1]:'), { modelId: 'kling-v4', genMode: 'keyframes', refImages: ['data:image/png;base64,aA=='] }), /first entry/)
	assert.equal(calls.length, count, 'Invalid input must not upload or submit')
	await provider.generateVideo('Use the sound', { modelId: 'kling-v4', genMode: 'video-ref', refAudios: ['data:audio/mpeg;base64,aA=='] })
	assert.ok(calls.some(c => c.url.startsWith('https://temp.bragi.now/upload')))
	assert.deepEqual(JSON.parse(calls.at(-1).body).audio_urls, [image('uploaded')])
	const completed = await provider.checkStatus('task-kling4'); assert.equal(completed.done, true); assert.ok(completed.filePath.startsWith('outputs/apimart_video_')); assert.equal(writes.length, 1)
	globalThis.__request = async () => ({ status: 400, json: { error: { code: 'InvalidParameter', message: 'Unsupported input' } } })
	await assert.rejects(() => provider.generateVideo('Scene', { modelId: 'kling-v4' }), /InvalidParameter.*Unsupported input/)
	globalThis.__request = async () => ({ status: 200, json: { data: { status: 'failed', error: { message: 'Rejected by upstream' } } } })
	await assert.rejects(() => provider.checkStatus('task-kling4'), /Rejected by upstream/)

	const node = { id: 'prompt', text: '', getData: () => ({ id: 'prompt', type: 'text', text: '' }) }
	const canvas = { nodes: new Map([[node.id, node]]), getEdgesForNode: () => [], requestFrame: async () => {} }
	let dispatched
	const settings = { providers: { apimart: 'test-only-key' }, modelPrefs: { 'kling-4.0': { enabled: true, selectedProvider: 'apimart' } }, providerModelPrefs: { apimart: { 'kling-4.0': true } }, modelOrder: {}, apiModelIdOverrides: {} }
	const tools = createMcpToolRegistry({ getCanvas: () => canvas, app: {}, getSettings: () => settings, runGeneration: async (_node, result) => { dispatched = result; return { placeholderIds: ['output'], expectedOutputType: 'video' } } })
	const generate = tools.find(t => t.name === 'generate').handler
	await generate({ nodeId: node.id, modelId: model.id, mode: 'first-frame', params: {}, batchCount: 1 })
	assert.equal(dispatched.prompt, ''); assert.equal(dispatched.mode, 'first-frame')
	await assert.rejects(() => generate({ nodeId: node.id, modelId: model.id, mode: 'text-to-video', params: {}, batchCount: 1 }), /no prompt/)
	node.text = 'Scene'
	await generate({ nodeId: node.id, modelId: model.id, mode: 'text-to-video', params: { duration: 31 }, batchCount: 1 })
	assert.equal(dispatched.params.duration, 31, 'Invalid Kling durations reach preflight without silent clamping')
	await assert.rejects(() => generate({ nodeId: node.id, modelId: model.id, mode: 'motion-control', params: {}, batchCount: 1 }), /not supported/)
	settings.modelPrefs[model.id].enabled = false
	await assert.rejects(() => generate({ nodeId: node.id, modelId: model.id, mode: 'first-frame', params: {}, batchCount: 1 }), /not enabled/)
	const source = await readFile('src/main.ts', 'utf8')
	const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
	const plugin = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'BragiCanvas')
	const batchMethod = plugin.members.find(m => m.name?.getText(ast) === 'executeBatchGeneration').getText(ast)
	const compiled = ts.transpileModule(`class BatchSubject { ${batchMethod} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
	const notices = []
	const BatchSubject = new Function('kling4PromptOptional', 'Notice', 'errorMessage', compiled + ';return BatchSubject')(runtime.module.kling4PromptOptional, class { constructor(message) { notices.push(message) } }, error => error.message)
	const batch = new BatchSubject()
	node.text = ''
	let batchCalls = 0
	batch.executeGeneration = async () => { batchCalls++ }
	await batch.executeBatchGeneration([node], { model, mode: 'first-frame' })
	assert.equal(batchCalls, 1, 'Batch first-frame generation must also allow empty prompts')
	batch.executeGeneration = async () => { throw new Error('Invalid keyframes') }
	await batch.executeBatchGeneration([node], { model, mode: 'keyframes' })
	assert.ok(notices.some(message => message.includes('Invalid keyframes')), 'Batch preflight errors must be visible')
	console.log('Kling 4.0: parser, eight modes, boundaries, stable bindings, relay, submit/poll/download, errors, catalog opt-in, and MCP checks passed.')
} finally { await runtime.cleanup() }

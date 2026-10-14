import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { testRuntime } from './test-runtime.mjs'

const { module: runtime, cleanup } = await testRuntime(`
export { BreezeBlueProvider, buildBreezeBluePreviewRequest, testBreezeBlueConnection } from './src/providers/breezeblue';
export { breezeVoiceDesign } from './src/models/audio';
export { migrateSettings } from './src/settings-migrations';
export { getEnabledModels } from './src/models';
export { createMcpToolRegistry } from './src/mcp-tool-registry';
`)

const files = new Map()
const app = { vault: { adapter: { exists: async () => true, mkdir: async () => {}, writeBinary: async (path, bytes) => files.set(path, Buffer.from(bytes)) } } }
const description = 'A warm, clear voice with measured pacing.'
const script = 'Welcome. Let me show you around.'
const options = { modelId: 'breeze-tts-2-multilingual', voicePrompt: description, previewText: script, previewCount: 3 }
const fixture = Buffer.from('RIFF-candidate-audio')
const preview = { generated_voice_id: 'temporary-preview', media_type: 'audio/wav', audio_base_64: fixture.toString('base64') }
const response = (status, json) => ({ status, json })
const calls = []

try {
	const { BreezeBlueProvider, buildBreezeBluePreviewRequest, testBreezeBlueConnection, breezeVoiceDesign, migrateSettings, getEnabledModels } = runtime
	assert.deepEqual(buildBreezeBluePreviewRequest(options), { model_id: options.modelId, voice_description: description, text: script, preview_count: 3 })
	assert.equal(buildBreezeBluePreviewRequest({ ...options, previewCount: undefined }).preview_count, 1)
	for (const count of [0, 4, 10, 1.5, 'bad']) assert.throws(() => buildBreezeBluePreviewRequest({ ...options, previewCount: count }), /1–3/)
	for (const value of ['ab', 'x'.repeat(501)]) {
		assert.throws(() => buildBreezeBluePreviewRequest({ ...options, voicePrompt: value }), /3–500/)
		assert.throws(() => buildBreezeBluePreviewRequest({ ...options, previewText: value }), /3–500/)
	}
	assert.equal([...buildBreezeBluePreviewRequest({ ...options, previewText: '🙂'.repeat(500) }).text].length, 500)
	globalThis.__request = async request => {
		calls.push(request)
		assert.equal(request.url, 'https://api.breeze.blue/v1/voice-previews/design')
		assert.equal(request.headers['xi-api-key'], 'test-key')
		const body = JSON.parse(request.body)
		assert.equal(body.text, script)
		assert.equal(body.voice_description, description)
		assert.equal('language_code' in body, false)
		assert.equal('guidance_scale' in body, false)
		return response(200, { previews: Array.from({ length: body.preview_count }, () => preview), text: script })
	}
	const provider = new BreezeBlueProvider('test-key', app, '_bragi/assets')
	for (const count of [1, 2, 3]) {
		const result = await provider.generateVoicePreviews({ ...options, previewCount: count })
		assert.equal(result.filePaths.length, count)
		assert.equal(new Set(result.filePaths).size, count)
		for (const path of result.filePaths) { assert.ok(path.endsWith('.wav')); assert.deepEqual(files.get(path), fixture) }
	}
	assert.equal(calls.length, 3, 'Each candidate group uses one synchronous request, with no save or TTS call')
	await assert.rejects(() => provider.generateAudio(script, { mode: 'tts' }), /upstream voice description/)
	const writesBefore = files.size
	for (const data of [{ previews: [] }, { previews: [preview, preview, { ...preview, audio_base_64: 'invalid%' }] }, { previews: [preview, preview, { ...preview, media_type: 'text/plain' }] }]) {
		globalThis.__request = async () => response(200, data)
		await assert.rejects(() => provider.generateVoicePreviews(options), /candidates|audio/)
		assert.equal(files.size, writesBefore, 'Malformed responses must not leave a partial candidate group')
	}
	globalThis.__request = async () => response(422, { detail: 'Unsupported model' })
	await assert.rejects(() => provider.generateVoicePreviews(options), /Unsupported model/)
	globalThis.__request = async request => { assert.ok(request.url.endsWith('/models')); return response(200, []) }
	assert.deepEqual(await testBreezeBlueConnection('test-key'), { ok: true, message: 'Connected.' })
	globalThis.__request = async () => response(401, { detail: 'Invalid API key' })
	assert.deepEqual(await testBreezeBlueConnection('test-key'), { ok: false, message: 'Invalid API key' })

	const migrated = migrateSettings({ settingsSchemaVersion: 14, providers: { sonilo: 'existing-key' }, modelPrefs: {}, providerModelPrefs: {} }, undefined, { strict: true })
	assert.equal(migrated.valid, true)
	assert.equal(migrated.settings.settingsSchemaVersion, 15)
	assert.equal(migrated.settings.providers.breezeblue, '')
	assert.equal(migrated.settings.providers.sonilo, 'existing-key')
	migrated.settings.providers.breezeblue = 'test-key'
	assert.equal(getEnabledModels('audio', [], migrated.settings.modelPrefs, () => ['breezeblue']).some(model => model.id === breezeVoiceDesign.id), false)
	assert.equal(migrateSettings({ providers: { breezeblue: 'imported-key' } }, undefined, { strict: true }).settings.providers.breezeblue, 'imported-key')
	assert.equal(migrateSettings({ providers: { breezeblue: 123 } }, undefined, { strict: true }).valid, false)
	assert.deepEqual(breezeVoiceDesign.params.find(param => param.id === 'preview_count').options.map(option => option.value), ['1', '2', '3'])
	migrated.settings.modelPrefs[breezeVoiceDesign.id] = { enabled: true, selectedProvider: 'breezeblue' }
	migrated.settings.providerModelPrefs.breezeblue = { [breezeVoiceDesign.id]: true }
	const modelTool = runtime.createMcpToolRegistry({ getCanvas: () => null, getSettings: () => migrated.settings }).find(tool => tool.name === 'list_models')
	const listed = JSON.parse(modelTool.handler({ type: 'audio' }).content[0].text)
	const exposed = listed.find(model => model.id === breezeVoiceDesign.id)
	assert.deepEqual(exposed.voiceSources, ['design'])
	assert.equal(exposed.voiceDesignOutput, 'audio-previews')
	assert.deepEqual(exposed.params.find(param => param.id === 'preview_count').options.map(option => option.value), ['1', '2', '3'])

	// Execute the real canvas replacement without DOM overlays to verify all outputs and collision handling.
	const canvasSource = await readFile('src/canvas-ops.ts', 'utf8')
	const canvasAst = ts.createSourceFile('canvas-ops.ts', canvasSource, ts.ScriptTarget.Latest, true)
	const geometryNames = new Set(['findFreePosition', 'replacePlaceholderWithFile', 'replacePlaceholderWithFiles'])
	const geometryFunctions = canvasAst.statements.filter(node => ts.isFunctionDeclaration(node) && geometryNames.has(node.name?.text)).map(node => node.getText(canvasAst).replace(/^export /, '')).join('\n')
	const geometryCode = ts.transpileModule(geometryFunctions, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
	let nextId = 0
	const replaceFiles = new Function('generateId', 'detachGeneratingOverlay', 'PLACEMENT_GAP', 'PLACEMENT_RADIUS', `${geometryCode}; return replacePlaceholderWithFiles`)(() => `output-${nextId++}`, () => {}, 20, 20)
	const sourceNode = { id: 'source' }
	const placeholderData = { id: 'pending', type: 'text', text: '', x: 450, y: 0, width: 400, height: 200 }
	const placeholder = { id: 'pending', getData: () => placeholderData }
	let data = { nodes: [{ id: 'source', type: 'text', x: 0, y: 0, width: 400, height: 200 }, placeholderData, { id: 'obstacle', type: 'text', x: 450, y: 220, width: 400, height: 200 }], edges: [{ id: 'pending-edge', fromNode: 'source', toNode: 'pending' }] }
	const canvas = { getData: () => data, removeNode: node => { data = { nodes: data.nodes.filter(item => item.id !== node.id), edges: data.edges.filter(edge => edge.toNode !== node.id) } }, importData: next => { data = next }, requestSave: async () => {} }
	replaceFiles(canvas, placeholder, ['one.wav', 'two.wav', 'three.wav'], sourceNode)
	const outputs = data.nodes.filter(node => node.type === 'file')
	assert.deepEqual(outputs.map(node => node.file), ['one.wav', 'two.wav', 'three.wav'])
	assert.equal(outputs[0].x, placeholderData.x)
	assert.equal(outputs[0].y, placeholderData.y)
	assert.equal(data.edges.length, 3)
	assert.ok(data.edges.every(edge => edge.fromNode === 'source' && outputs.some(node => node.id === edge.toNode)))
	for (const output of outputs) for (const other of data.nodes.filter(node => node.id !== output.id)) {
		assert.ok(output.x + output.width <= other.x || other.x + other.width <= output.x || output.y + output.height <= other.y || other.y + other.height <= output.y, 'Candidate nodes must not overlap existing nodes or each other')
	}

	// Exercise the production generation branch, including Design inference and script separation.
	const mainSource = await readFile('src/main.ts', 'utf8')
	const mainAst = ts.createSourceFile('main.ts', mainSource, ts.ScriptTarget.Latest, true)
	const cls = mainAst.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'BragiCanvas')
	const methods = cls.members.filter(member => ['startSingleGeneration', 'runSingleGeneration'].includes(member.name?.getText(mainAst))).map(member => member.getText(mainAst)).join('\n')
	const helperNames = new Set(['selectedVoiceMode', 'modelIdForVoiceMode', 'readVoiceDesignTextIndex'])
	const helpers = mainAst.statements.filter(node => ts.isFunctionDeclaration(node) && helperNames.has(node.name?.text)).map(node => node.getText(mainAst)).join('\n')
	const subjectCode = ts.transpileModule(`${helpers}\nclass Subject { syncGenerating = new Set(); ${methods} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
	let applied
	const generated = []
	let previewCalls = 0
	const deps = {
		getProvider: () => ({ makeAudio: () => ({ generateVoicePreviews: async input => { previewCalls++; assert.equal(input.voicePrompt, description); assert.equal(input.previewText, script); assert.equal(input.previewCount, '3'); return { filePaths: ['one.wav', 'two.wav', 'three.wav'] } }, generateAudio: () => assert.fail('Preview mode must not call TTS'), designVoice: () => assert.fail('Preview mode must not create a saved voice') }) }),
		getOrderedImages: () => [], setGeneratingStatus: () => {}, replacePlaceholderWithFiles: (...args) => { applied = args },
		Notice: class {}, errorMessage: String, markNodeFailed: () => assert.fail('Candidate generation should succeed'),
		getCanvasFromNode: () => canvas, getUpstreamInputs: () => ({ images: [], audios: [], videos: [], pdfs: [] }),
		getOrderedPrompts: async () => [description], computeOutputSize: () => ({ w: 400, h: 200 }), readAspectRatio: () => undefined,
		createPlaceholderNode: () => ({ id: 'new-placeholder' }),
	}
	const Subject = new Function(...Object.keys(deps), `${subjectCode}; return Subject`)(...Object.values(deps))
	const subject = new Subject()
	subject.getCanvasPath = () => 'source.canvas'
	subject.getOutputDir = () => '_bragi/assets'
	subject.rememberGeneratedAsset = (...args) => generated.push(args)
	subject.settings = {}
	const result = { model: breezeVoiceDesign, activeProvider: 'breezeblue', apiModelId: options.modelId, mode: 'tts', params: { preview_count: '3', voiceDesignTextIndex: 1 }, prompt: script }
	await subject.runSingleGeneration(sourceNode, result, canvas, placeholder, script, { images: [], audios: [], videos: [], pdfs: [] }, ['Wrong description', description], 'source.canvas', '_bragi/assets')
	assert.equal(previewCalls, 1)
	assert.deepEqual(generated.map(([path]) => path), ['one.wav', 'two.wav', 'three.wav'])
	assert.deepEqual(applied[2], ['one.wav', 'two.wav', 'three.wav'])
	let submittedPrompt
	subject.runSingleGeneration = async (...args) => { submittedPrompt = args[4] }
	await subject.startSingleGeneration(sourceNode, result)
	assert.equal(submittedPrompt, script, 'The voice description must never be spoken as part of the script')
	console.log('BreezeBlue previews passed: 1–3 candidates, validation, audio decoding, no save/TTS, settings opt-in, separate non-overlapping nodes, and script/description separation.')
} finally {
	delete globalThis.__request
	await cleanup()
}

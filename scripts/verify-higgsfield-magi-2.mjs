import assert from 'node:assert/strict'
import { testRuntime } from './test-runtime.mjs'

const { module: runtime, cleanup } = await testRuntime(`
export { getProvider } from './src/providers/registry'
export { migrateSettings, CURRENT_SETTINGS_SCHEMA_VERSION } from './src/settings-migrations'
export { createMcpToolRegistry } from './src/mcp-tool-registry'
export { decodeTaskSnapshots } from './src/task-queue'
export { validateMagi2Media } from './src/providers/higgsfield'
`)

try {
	const { getProvider, migrateSettings, createMcpToolRegistry, decodeTaskSnapshots, validateMagi2Media } = runtime
	const spec = getProvider('higgsfield')
	const credential = 'test-id:test-secret'
	const migrated = migrateSettings({ settingsSchemaVersion: 15, providers: { pika: 'existing-key' } })
	assert.ok(migrated.settings.settingsSchemaVersion >= 16)
	assert.equal(migrated.settings.settingsSchemaVersion, runtime.CURRENT_SETTINGS_SCHEMA_VERSION)
	assert.equal(migrated.settings.providers.higgsfield, '')
	assert.equal(migrated.settings.providers.pika, 'existing-key')
	assert.equal(spec.isConfigured(migrated.settings), false)
	assert.equal(migrateSettings({ providers: { higgsfield: 123 } }, undefined, { strict: true }).valid, false)

	const { settings } = migrateSettings({ providers: { higgsfield: credential } }, undefined, { strict: true })
	assert.equal(spec.isConfigured(settings), true)
	const listModels = createMcpToolRegistry({ getCanvas: () => null, getSettings: () => settings }).find(tool => tool.name === 'list_models')
	const listed = () => JSON.parse(listModels.handler({ type: 'video' }).content[0].text).find(model => model.id === 'magi-2')
	assert.equal(listed(), undefined)
	settings.modelPrefs['magi-2'] = { enabled: true, selectedProvider: 'higgsfield' }
	assert.equal(listed(), undefined)
	settings.providerModelPrefs.higgsfield = { 'magi-2': true }
	const modes = ['text-to-video', 'first-frame', 'first-last-frame', 'reference-to-video']
	assert.deepEqual(listed().modes, modes)
	assert.equal(listed().params.find(param => param.id === 'generate_audio').default, 'true')
	assert.equal(listed().params.find(param => param.id === 'seed').default, -1)

	const endpoint = 'https://api.higgsfield.ai/sand/magi-2/text-to-video'
	globalThis.__request = async request => {
		assert.equal(request.url, endpoint)
		assert.equal(request.method, 'POST')
		assert.equal(request.headers.Authorization, 'Key ' + credential)
		assert.deepEqual(JSON.parse(request.body), {})
		return { status: 400, json: { detail: ": 'prompt' is a required property" } }
	}
	assert.deepEqual(await spec.testConnection({ higgsfield: credential }), { ok: true, message: 'Connected.' })
	globalThis.__request = async () => ({ status: 401, json: { detail: 'Invalid credentials' } })
	assert.match((await spec.testConnection({ higgsfield: credential })).message, /invalid API key/)

	const fileBytes = new Uint8Array([1, 2, 3]).buffer
	const writes = new Map()
	const app = { vault: { adapter: {
		exists: async () => true,
		writeBinary: async (path, bytes) => writes.set(path, bytes),
	} } }
	const provider = spec.makeVideo({ settings, app, outputDir: 'assets' })
	const taskId = 'e2e-task-id'
	const statusUrl = `https://api.higgsfield.ai/requests/${taskId}/status`
	const mediaUrl = 'https://example.test/video.mp4'
	const prompt = 'A close-up of a rolling orange.'
	const mediaDefaults = { duration: 5, aspect_ratio: '16:9', resolution: '1080p', generate_audio: true }
	const defaults = { ...mediaDefaults, prompt }
	const submissions = []
	globalThis.__request = async request => {
		assert.equal(request.headers.Authorization, 'Key ' + credential)
		assert.match(request.headers['Idempotency-Key'], /^[a-f0-9-]{36}$/)
		submissions.push([request.url.split('/').at(-1), JSON.parse(request.body)])
		return { status: 202, json: { status: 'queued', request_id: taskId } }
	}
	assert.deepEqual(await provider.generateVideo(prompt), { done: false, taskId })
	await provider.generateVideo(prompt, { duration: '4', aspect_ratio: '9:16', generate_audio: 'false', seed: 0 })
	const image = 'https://example.test/start.jpg'
	const end = 'https://example.test/end.png'
	const audio = 'https://example.test/sound.wav'
	await provider.generateVideo('', { genMode: 'first-frame', refImages: [image] })
	await provider.generateVideo(prompt, { genMode: 'first-last-frame', refImages: [end, image] })
	await provider.generateVideo('', { genMode: 'reference-to-video', refAudios: [audio] })
	await provider.generateVideo(prompt, { genMode: 'reference-to-video', refImages: [end, image], refVideos: [mediaUrl], refAudios: [audio] })
	assert.deepEqual(submissions, [
		['text-to-video', defaults],
		['text-to-video', { ...defaults, duration: 4, aspect_ratio: '9:16', generate_audio: false, seed: 0 }],
		['image-to-video', { ...mediaDefaults, image_url: image }],
		['image-to-video', { ...defaults, image_url: end, end_image_url: image }],
		['reference-to-video', { ...mediaDefaults, audio_urls: [audio] }],
		['reference-to-video', { ...defaults, image_urls: [end, image], video_urls: [mediaUrl], audio_urls: [audio] }],
	])
	await assert.rejects(() => provider.generateVideo(prompt, { refAudios: [audio] }), /without media/)
	await assert.rejects(() => provider.generateVideo(prompt, { genMode: 'first-frame', refImages: [image, end] }), /exactly 1 image/)
	await assert.rejects(() => provider.generateVideo(prompt, { genMode: 'first-last-frame', refImages: [image] }), /exactly 2 images/)
	await assert.rejects(() => provider.generateVideo(prompt, { genMode: 'reference-to-video' }), /requires an image, video, or audio/)
	await assert.rejects(() => provider.generateVideo(prompt, { genMode: 'reference-to-video', refVideos: Array(6).fill(mediaUrl) }), /up to 10 images/)
	await assert.rejects(() => provider.generateVideo(prompt, { genMode: 'reference-to-video', refPdfs: ['https://example.test/file.pdf'] }), /PDF/)
	await assert.rejects(() => provider.generateVideo(prompt, { genMode: 'reference-to-video', refAudios: ['audio.wav'] }), /public HTTPS/)
	await assert.rejects(() => provider.generateVideo(prompt, { duration: 4.5 }), /whole number/)
	await assert.rejects(() => provider.generateVideo(prompt, { seed: 4294967296 }), /seed/)
	await assert.rejects(() => provider.generateVideo(' '), /requires a prompt/)
	assert.equal(submissions.length, 6, 'Invalid requests never reach Higgsfield')

	const refs = { images: [], videos: [], audios: [], pdfs: [] }
	const files = { vault: { adapter: { stat: async () => ({ type: 'file', size: 15_000_001 }) } } }
	await assert.rejects(() => validateMagi2Media(files, { ...refs, audios: ['sound.wav'] }), /15 MB/)
	await assert.rejects(() => validateMagi2Media(files, { ...refs, videos: ['clip.webm'] }), /MP4 or MOV/)
	await validateMagi2Media(files, { ...refs, images: ['start.png'], videos: ['clip.mov'] })

	const node = { id: 'prompt', text: '', getData: () => ({ id: 'prompt', type: 'text', text: '' }) }
	let edges = []
	const canvas = { nodes: new Map([[node.id, node]]), getEdgesForNode: () => edges, requestFrame: async () => {} }
	let dispatched
	const generate = createMcpToolRegistry({
		getCanvas: () => canvas,
		getSettings: () => settings,
		runGeneration: async (_node, result) => {
			dispatched = result
			return { placeholderIds: ['out'], expectedOutputType: 'video' }
		},
	}).find(tool => tool.name === 'generate').handler
	const connect = (...files) => { edges = files.map(file => ({ to: { node }, from: { node: { getData: () => ({ type: 'file', file }) } } })) }
	const args = { modelId: 'magi-2', nodeId: node.id }
	for (const [inputs, mode] of [
		[['one.jpg'], 'first-frame'],
		[['one.jpg', 'two.jpg'], 'first-last-frame'],
		[['one.jpg', 'two.jpg', 'three.jpg'], 'reference-to-video'],
		[['one.mp3'], 'reference-to-video'],
		[['one.jpg', 'one.mov', 'one.wav'], 'reference-to-video'],
	]) {
		connect(...inputs)
		await generate(args)
		assert.equal(dispatched.mode, mode)
		assert.equal(dispatched.prompt, '')
	}
	connect('one.jpg')
	await generate({ ...args, mode: 'reference-to-video' })
	assert.equal(dispatched.mode, 'reference-to-video', 'Explicit reference mode overrides first-frame inference')
	connect()
	node.text = prompt
	await generate(args)
	assert.equal(dispatched.mode, 'text-to-video')

	for (const apiModelId of ['sand/magi-2', 'sand/magi-2/text-to-video']) {
		const [snapshot] = decodeTaskSnapshots([{
			taskId, apiModelId, providerName: 'higgsfield', modelName: 'MAGI-2', canvasPath: 'test.canvas',
			sourceNodeId: 'prompt', placeholderNodeId: 'out', outputDir: 'assets', startedAt: 100,
		}])
		assert.equal(snapshot.checkWindowMs, 45 * 60 * 1000)
		assert.equal(snapshot.checkDeadlineAt, 100 + snapshot.checkWindowMs)
	}

	const resumed = spec.makeVideo({ settings, app, outputDir: 'assets' })
	for (const status of ['queued', 'in_progress', 'failed', 'nsfw', 'canceled']) {
		globalThis.__request = async request => {
			assert.equal(request.url, statusUrl)
			assert.equal(request.headers.Authorization, 'Key ' + credential)
			return { status: 200, json: { status } }
		}
		if (['queued', 'in_progress'].includes(status)) assert.deepEqual(await resumed.checkStatus(taskId), { done: false, taskId })
		else await assert.rejects(() => resumed.checkStatus(taskId), { kind: 'terminal' })
	}
	globalThis.__request = async () => ({ status: 429, headers: { 'Retry-After': '15' } })
	await assert.rejects(() => resumed.checkStatus(taskId), { kind: 'retryable', retryAfterMs: 15000 })
	globalThis.__request = async request => {
		if (request.url === statusUrl) return { status: 200, json: { status: 'completed', video: { url: mediaUrl } } }
		assert.equal(request.url, mediaUrl)
		assert.equal(request.headers, undefined)
		return { status: 200, arrayBuffer: fileBytes }
	}
	const phases = []
	const filePath = `assets/magi_2_${taskId}.mp4`
	assert.deepEqual(await resumed.checkStatus(taskId, phase => phases.push(phase)), { done: true, filePath })
	assert.deepEqual(phases, ['downloading'])
	assert.equal(writes.get(filePath), fileBytes)
	console.log('Higgsfield MAGI-2 settings, request, queue and download passed.')
} finally {
	await cleanup()
}

import assert from 'node:assert/strict'
import { testRuntime } from './test-runtime.mjs'

const { module: runtime, cleanup } = await testRuntime(`
export { getProvider } from './src/providers/registry'
export { migrateSettings, CURRENT_SETTINGS_SCHEMA_VERSION } from './src/settings-migrations'
export { createMcpToolRegistry } from './src/mcp-tool-registry'
`)

try {
	const { getProvider, migrateSettings, createMcpToolRegistry } = runtime
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
	assert.deepEqual(listed().modes, ['text-to-video'])
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
	const defaults = { prompt, duration: 5, aspect_ratio: '16:9', resolution: '1080p', generate_audio: true }
	const submissions = []
	globalThis.__request = async request => {
		assert.equal(request.url, endpoint)
		assert.equal(request.headers.Authorization, 'Key ' + credential)
		assert.match(request.headers['Idempotency-Key'], /^[a-f0-9-]{36}$/)
		submissions.push(JSON.parse(request.body))
		return { status: 202, json: { status: 'queued', request_id: taskId } }
	}
	assert.deepEqual(await provider.generateVideo(prompt), { done: false, taskId })
	await provider.generateVideo(prompt, { duration: '4', aspect_ratio: '9:16', generate_audio: 'false', seed: 0 })
	assert.deepEqual(submissions, [defaults, { ...defaults, duration: 4, aspect_ratio: '9:16', generate_audio: false, seed: 0 }])
	await assert.rejects(() => provider.generateVideo(prompt, { refAudios: ['audio.wav'] }), /without media/)
	await assert.rejects(() => provider.generateVideo(prompt, { duration: 4.5 }), /whole number/)
	await assert.rejects(() => provider.generateVideo(prompt, { seed: 4294967296 }), /seed/)
	await assert.rejects(() => provider.generateVideo(' '), /requires a prompt/)
	assert.equal(submissions.length, 2)

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

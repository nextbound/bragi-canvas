import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const tempDir = await mkdtemp(join(tmpdir(), 'bragi-mureka-music-'))

async function bundle(entryPoint, outfile, extraPlugins = [], banner) {
	await build({
		entryPoints: [entryPoint],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile,
		logLevel: 'silent',
		banner,
		plugins: [
			...extraPlugins,
			{
				name: 'mock-obsidian',
				setup(buildApi) {
					buildApi.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'mock-obsidian' }))
					buildApi.onLoad({ filter: /.*/, namespace: 'mock-obsidian' }, () => ({
						contents: `
							export async function requestUrl(options) { return process.__bragiMurekaRequestHandler(options) }
							export class Notice { constructor(message) { process.__bragiTaskNotices.push(message) } }
						`,
						loader: 'js',
					}))
				},
			},
		],
	})
}

try {
	const providerBundle = join(tempDir, 'mureka.mjs')
	await bundle('src/providers/mureka.ts', providerBundle)
	const {
		buildMurekaRequest,
		decodeMurekaTaskId,
		MurekaProvider,
		testMurekaConnection,
	} = await import(`${pathToFileURL(providerBundle).href}?t=${Date.now()}`)

	assert.deepEqual(buildMurekaRequest('combined text that must not leak', {
		modelId: 'auto',
		nodePrompt: 'dream pop, female vocal',
		generation_mode: 'prompt',
		upstreamPrompts: ['unused lyrics'],
	}), {
		path: '/v1/song/easy-generate',
		body: { model: 'auto', n: 1, stream: false, prompt: 'dream pop, female vocal' },
		taskKind: 'song',
	})
	assert.deepEqual(buildMurekaRequest('combined text', {
		modelId: 'mureka-9',
		nodePrompt: 'r&b, slow',
		generation_mode: 'lyrics',
		upstreamPrompts: ['[Verse]\nLine one', '[Chorus]\nLine two'],
	}), {
		path: '/v1/song/generate',
		body: {
			model: 'mureka-9',
			n: 1,
			stream: false,
			lyrics: '[Verse]\nLine one\n[Chorus]\nLine two',
			prompt: 'r&b, slow',
		},
		taskKind: 'song',
	})
	assert.deepEqual(buildMurekaRequest('cinematic ambient', {
		modelId: 'auto',
		generation_mode: 'instrumental',
	}), {
		path: '/v1/instrumental/generate',
		body: { model: 'auto', n: 1, stream: false, prompt: 'cinematic ambient' },
		taskKind: 'instrumental',
	})
	assert.throws(
		() => buildMurekaRequest('style', { generation_mode: 'lyrics', upstreamPrompts: [] }),
		/needs an upstream lyrics text node/,
	)
	assert.deepEqual(decodeMurekaTaskId('instrumental:435134'), { kind: 'instrumental', id: '435134' })

	const requests = []
	const writes = []
	const app = {
		vault: {
			adapter: {
				exists: async () => true,
				mkdir: async () => {},
				writeBinary: async (path, data) => writes.push({ path, data }),
			},
		},
	}
	const provider = new MurekaProvider('test-key', app, '_bragi/assets')

	process.__bragiMurekaRequestHandler = async (request) => {
		requests.push(request)
		return { status: 200, json: { id: 'song-job-1', status: 'preparing' } }
	}
	assert.deepEqual(await provider.generateAudio('combined', {
		mode: 'music',
		modelId: 'auto',
		generation_mode: 'lyrics',
		nodePrompt: 'pop rock',
		upstreamPrompts: ['actual lyrics'],
	}), { done: false, taskId: 'song:song-job-1' })
	assert.equal(requests[0].url, 'https://api.mureka.ai/v1/song/generate')
	assert.equal(requests[0].headers.Authorization, 'Bearer test-key')
	assert.deepEqual(JSON.parse(requests[0].body), {
		model: 'auto',
		n: 1,
		stream: false,
		lyrics: 'actual lyrics',
		prompt: 'pop rock',
	})

	process.__bragiMurekaRequestHandler = async (request) => {
		requests.push(request)
		return { status: 200, json: { id: 'inst-job-1', status: 'running' } }
	}
	assert.deepEqual(await provider.generateAudio('ambient', {
		mode: 'music', modelId: 'auto', generation_mode: 'instrumental',
	}), { done: false, taskId: 'instrumental:inst-job-1' })

	process.__bragiMurekaRequestHandler = async (request) => {
		requests.push(request)
		return { status: 200, json: { id: 'song-job-1', status: 'running' } }
	}
	assert.deepEqual(await provider.checkStatus('song:song-job-1'), { done: false, taskId: 'song:song-job-1' })
	assert.equal(requests.at(-1).url, 'https://api.mureka.ai/v1/song/query/song-job-1')

	process.__bragiMurekaRequestHandler = async (request) => {
		requests.push(request)
		if (request.url.includes('/v1/instrumental/query/')) {
			return { status: 200, json: { status: 'succeeded', choices: [{ url: 'https://cdn.example/music.mp3' }] } }
		}
		if (request.url === 'https://cdn.example/music.mp3') {
			return { status: 200, arrayBuffer: new Uint8Array([7, 8, 9]).buffer }
		}
		throw new Error(`Unexpected request ${request.url}`)
	}
	const completed = await provider.checkStatus('instrumental:inst-job-1')
	assert.equal(completed.done, true)
	assert.match(completed.filePath, /^_bragi\/assets\/mureka_music_inst-job-1_\d+\.mp3$/)
	assert.deepEqual([...new Uint8Array(writes[0].data)], [7, 8, 9])

	process.__bragiMurekaRequestHandler = async () => ({ status: 200, json: { status: 'failed', failed_reason: 'content rejected' } })
	await assert.rejects(() => provider.checkStatus('song:failed-job'), /content rejected/)
	process.__bragiMurekaRequestHandler = async () => ({ status: 200, json: { balance: 10 } })
	assert.deepEqual(await testMurekaConnection('valid-key'), { ok: true, message: 'Connected.' })
	process.__bragiMurekaRequestHandler = async () => ({ status: 401, json: { message: 'Unauthorized' } })
	assert.deepEqual(await testMurekaConnection('bad-key'), { ok: false, message: 'Invalid API key.' })

	const queueBundle = join(tempDir, 'task-queue.mjs')
	await bundle('src/task-queue.ts', queueBundle, [{
		name: 'mock-canvas-ops',
		setup(buildApi) {
			buildApi.onResolve({ filter: /canvas-ops$/ }, () => ({ path: 'canvas-ops', namespace: 'mock-canvas-ops' }))
			buildApi.onLoad({ filter: /.*/, namespace: 'mock-canvas-ops' }, () => ({
				contents: `
					export function replacePlaceholderWithFile(...args) { process.__bragiTaskReplacements.push(args) }
					export function markNodeFailed(...args) { process.__bragiTaskFailures.push(args) }
				`,
				loader: 'js',
			}))
		},
	}], { js: 'const window = process.__bragiTestWindow' })
	process.__bragiTestWindow = {
		setInterval: () => 1,
		clearInterval: () => {},
	}
	const { TaskQueue } = await import(`${pathToFileURL(queueBundle).href}?t=${Date.now()}`)
	process.__bragiTaskNotices = []
	process.__bragiTaskReplacements = []
	process.__bragiTaskFailures = []
	const queue = new TaskQueue()
	queue.addTask({
		snapshot: {
			taskId: 'song:audio-queue', providerName: 'mureka', apiModelId: 'auto', modelName: 'Mureka Music',
			canvasPath: 'Music.canvas', sourceNodeId: 'source', placeholderNodeId: 'placeholder', outputDir: '_bragi/assets',
			startedAt: Date.now(), outputType: 'audio',
		},
		provider: { name: 'Mureka', checkStatus: async () => ({ done: true, filePath: '_bragi/assets/result.mp3' }) },
		canvas: {}, placeholder: {}, sourceNode: {},
	})
	await queue.pollAll()
	assert.equal(queue.activeCount, 0)
	assert.equal(process.__bragiTaskReplacements.length, 1)
	assert.deepEqual(process.__bragiTaskNotices, ['Audio ready (Mureka Music)'])

	const legacyQueue = new TaskQueue()
	legacyQueue.addTask({
		snapshot: {
			taskId: 'legacy-video', providerName: 'pika', apiModelId: 'kling-3.0', modelName: 'Kling 3.0',
			canvasPath: 'Video.canvas', sourceNodeId: 'source', placeholderNodeId: 'placeholder', outputDir: '_bragi/assets',
			startedAt: Date.now(),
		},
		provider: { name: 'Pika', checkStatus: async () => ({ done: true, filePath: '_bragi/assets/result.mp4' }) },
		canvas: {}, placeholder: {}, sourceNode: {},
	})
	await legacyQueue.pollAll()
	assert.equal(process.__bragiTaskNotices.at(-1), 'Video ready (Kling 3.0)')

	const [mainSource, panelSource, settingsSource, migrationsSource] = await Promise.all([
		readFile('src/main.ts', 'utf8'),
		readFile('src/panel.ts', 'utf8'),
		readFile('src/settings.ts', 'utf8'),
		readFile('src/settings-migrations.ts', 'utf8'),
	])
	assert.match(mainSource, /snapshot\.outputType === 'audio'[\s\S]*makeAudio[\s\S]*makeVideo/, 'Resume must rebuild audio or video providers from outputType.')
	assert.match(mainSource, /outputType: 'audio'/, 'Async audio snapshots must persist outputType.')
	assert.match(panelSource, /model\?\.id === 'mureka-music' && params\.generation_mode === 'lyrics'/, 'Mureka lyrics mode must share the upstream lyrics guard.')
	assert.match(settingsSource, /mureka: string/, 'Settings must include the Mureka credential.')
	assert.match(migrationsSource, /CURRENT_SETTINGS_SCHEMA_VERSION = 11/, 'Adding Mureka must advance the settings schema version.')

	console.log('Mureka music and async audio queue checks passed.')
} finally {
	await rm(tempDir, { recursive: true, force: true })
}

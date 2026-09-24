import { testRuntime } from './test-runtime.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const tempDir = await mkdtemp(join(tmpdir(), 'bragi-seedance-2-5-'))
const bundlePath = join(tempDir, 'seedance-provider.mjs')

try {
	await build({
		entryPoints: ['src/providers/seedance.ts'],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile: bundlePath,
		logLevel: 'silent',
		plugins: [{
			name: 'mock-obsidian',
			setup(buildApi) {
				buildApi.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'mock-obsidian' }))
				buildApi.onLoad({ filter: /.*/, namespace: 'mock-obsidian' }, () => ({
					contents: `
						export async function requestUrl(options) {
							return process.__bragiSeedanceRequestHandler(options)
						}
					`,
					loader: 'js',
				}))
			},
		}],
	})

	const { buildSeedanceRequestBody, SeedanceProvider } = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`)
	const modelId = 'dreamina-seedance-2-5-260628'

	const firstLast = buildSeedanceRequestBody('Move from dawn to dusk', {
		modelId,
		genMode: 'first-last-frame',
		refImages: ['https://relay.example/first.png', 'https://relay.example/last.png'],
	})
	assert.equal(firstLast.duration, -1)
	assert.equal(firstLast.ratio, 'adaptive')
	assert.deepEqual(firstLast.content.slice(1).map(item => item.role), ['first_frame', 'last_frame'])

	const multimodal = buildSeedanceRequestBody('Use every reference', {
		modelId,
		genMode: 'video-ref',
		duration: '30',
		ratio: '21:9',
		resolution: '480p',
		generate_audio: 'false',
		output_format: 'mov',
		refImages: Array.from({ length: 30 }, (_, index) => `https://relay.example/image-${index}.png`),
		refVideos: Array.from({ length: 10 }, (_, index) => `https://relay.example/video-${index}.mp4`),
		refAudios: Array.from({ length: 10 }, (_, index) => `https://relay.example/audio-${index}.mp3`),
	})
	assert.equal(multimodal.content.length, 51)
	assert.equal(multimodal.generate_audio, false)
	assert.equal(multimodal.output_format, 'mov')

	const fullHd = buildSeedanceRequestBody('Render in full HD', {
		modelId,
		genMode: 'text-to-video',
		resolution: '1080p',
	})
	assert.equal(fullHd.resolution, '1080p')

	assert.throws(
		() => buildSeedanceRequestBody('Too many images', {
			modelId,
			genMode: 'image-ref',
			refImages: Array.from({ length: 31 }, (_, index) => `https://relay.example/image-${index}.png`),
		}),
		/up to 30 reference images/,
	)
	assert.throws(
		() => buildSeedanceRequestBody('Wrong ratio', {
			modelId,
			genMode: 'first-frame',
			ratio: '16:9',
			refImages: ['https://relay.example/first.png'],
		}),
		/requires adaptive ratio/,
	)
	assert.throws(
		() => buildSeedanceRequestBody('Edit the video', {
			modelId,
			genMode: 'video-edit',
			duration: '10',
			refVideos: ['https://relay.example/source.mp4'],
		}),
		/requires Auto \(-1\) duration/,
	)
	assert.throws(
		() => buildSeedanceRequestBody('No refs', { modelId, genMode: 'video-ref' }),
		/requires reference media/,
	)

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
	const provider = new SeedanceProvider(
		'test-key',
		app,
		'assets',
		'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks',
	)

	process.__bragiSeedanceRequestHandler = async (request) => {
		requests.push(request)
		return { status: 200, json: { id: 'task-25' }, text: '' }
	}
	assert.deepEqual(await provider.generateVideo('A paper boat sails', {
		modelId,
		genMode: 'text-to-video',
		output_format: 'mov',
	}), { done: false, taskId: 'task-25' })
	assert.equal(requests[0].url, 'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks')
	assert.equal(requests[0].headers.Authorization, 'Bearer test-key')
	assert.equal(JSON.parse(requests[0].body).model, modelId)

	const volcengineModelId = 'doubao-seedance-2-5-260628'
	const volcengineProvider = new SeedanceProvider('volcengine-key', app, 'assets')
	process.__bragiSeedanceRequestHandler = async (request) => {
		requests.push(request)
		return { status: 200, json: { id: 'volcengine-task-25' }, text: '' }
	}
	assert.deepEqual(await volcengineProvider.generateVideo('A kite crosses the sky', {
		modelId: volcengineModelId,
		genMode: 'text-to-video',
	}), { done: false, taskId: 'volcengine-task-25' })
	assert.equal(requests.at(-1).url, 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks')
	assert.equal(requests.at(-1).headers.Authorization, 'Bearer volcengine-key')
	assert.equal(JSON.parse(requests.at(-1).body).model, volcengineModelId)

	process.__bragiSeedanceRequestHandler = async (request) => {
		requests.push(request)
		if (request.url.endsWith('/task-25')) {
			return { status: 200, json: { status: 'succeeded', content: { video_url: 'https://cdn.example/result.mov?token=redacted' } } }
		}
		if (request.url.startsWith('https://cdn.example/result.mov')) {
			return { status: 200, arrayBuffer: new Uint8Array([1, 2, 3]).buffer }
		}
		throw new Error(`Unexpected request: ${request.url}`)
	}
	const completed = await provider.checkStatus('task-25')
	assert.match(completed.filePath, /^assets\/vid_\d+\.mov$/)
	assert.equal(writes.length, 1)
	assert.deepEqual([...new Uint8Array(writes[0].data)], [1, 2, 3])

	const catalog = await testRuntime("export {ALL_MODELS} from './src/models'; export {migrateSettings} from './src/settings-migrations';")
	try {
		const model = catalog.module.ALL_MODELS.find(model => model.id === 'seedance-2.5')
		assert.equal(model.supportedProviders.bytedance.apiModelId, 'doubao-seedance-2-5-260628')
		assert.equal(model.supportedProviders.byteplus.apiModelId, 'dreamina-seedance-2-5-260628')
		const settings = catalog.module.migrateSettings({settingsSchemaVersion:11,providers:{svnewapi:'test',bytedance:'test'},modelPrefs:{'seedance-2.5':{enabled:true,selectedProvider:'bytedance'}},providerModelPrefs:{bytedance:{'seedance-2.5':true}}}).settings
		assert.equal(settings.providerModelPrefs.svnewapi['seedance-2.5'], true)
		assert.equal(settings.modelPrefs['seedance-2.5'].selectedProvider, 'bytedance')
		assert.deepEqual(catalog.module.migrateSettings(settings).settings, settings)
	} finally { await catalog.cleanup() }

	console.log('Seedance 2.5 provider checks passed.')
} finally {
	delete process.__bragiSeedanceRequestHandler
	await rm(tempDir, { recursive: true, force: true })
}

import { testRuntime } from './test-runtime.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const tempDir = await mkdtemp(join(tmpdir(), 'bragi-apimart-minimax-h3-'))

try {
	const payloadBundle = join(tempDir, 'payload.mjs')
	const providerBundle = join(tempDir, 'provider.mjs')
	await build({
		entryPoints: ['src/providers/apimart-minimax-h3-payload.ts'],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile: payloadBundle,
		logLevel: 'silent',
	})
	await build({
		entryPoints: ['src/providers/apimart.ts'],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile: providerBundle,
		logLevel: 'silent',
		plugins: [{
			name: 'mock-obsidian',
			setup(buildApi) {
				buildApi.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'mock-obsidian' }))
				buildApi.onLoad({ filter: /.*/, namespace: 'mock-obsidian' }, () => ({
					contents: `
						export async function requestUrl(options) {
							return process.__bragiApimartH3RequestHandler(options)
						}
					`,
					loader: 'js',
				}))
			},
		}],
	})

	const { buildApimartMinimaxH3Request, MINIMAX_H3_MODEL_ID } = await import(`${pathToFileURL(payloadBundle).href}?t=${Date.now()}`)
	const { APIMartProvider } = await import(`${pathToFileURL(providerBundle).href}?t=${Date.now()}`)

	assert.equal(MINIMAX_H3_MODEL_ID, 'MiniMax-H3')
	assert.deepEqual(buildApimartMinimaxH3Request('A paper boat crosses a moonlit lake'), {
		model: 'MiniMax-H3',
		prompt: 'A paper boat crosses a moonlit lake',
		duration: 5,
		resolution: '2K',
		watermark: false,
		aspect_ratio: '16:9',
	})

	for (let duration = 4; duration <= 15; duration++) {
		assert.equal(buildApimartMinimaxH3Request('Duration boundary', { duration }).duration, duration)
	}
	for (const aspectRatio of ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16']) {
		assert.equal(
			buildApimartMinimaxH3Request('Ratio boundary', { aspect_ratio: aspectRatio }).aspect_ratio,
			aspectRatio,
		)
	}

	const firstFrame = buildApimartMinimaxH3Request('Wake into motion', {
		genMode: 'first-frame',
		refImages: ['https://temp.bragi.now/first.png'],
		aspect_ratio: '9:16',
		resolution: '768p',
		watermark: 'true',
	})
	assert.equal(firstFrame.first_frame_image, 'https://temp.bragi.now/first.png')
	assert.equal(firstFrame.last_frame_image, undefined)
	assert.equal(firstFrame.aspect_ratio, undefined)
	assert.equal(firstFrame.resolution, '768P')
	assert.equal(firstFrame.watermark, true)

	const firstLast = buildApimartMinimaxH3Request('Move from dawn into dusk', {
		genMode: 'first-last-frame',
		refImages: ['https://temp.bragi.now/first.png', 'https://temp.bragi.now/last.png'],
		duration: '15',
	})
	assert.equal(firstLast.first_frame_image, 'https://temp.bragi.now/first.png')
	assert.equal(firstLast.last_frame_image, 'https://temp.bragi.now/last.png')
	assert.equal(firstLast.image_urls, undefined)
	assert.equal(firstLast.aspect_ratio, undefined)

	const imageAudioRefs = buildApimartMinimaxH3Request('Keep the character and voice consistent', {
		genMode: 'image-ref',
		refImages: Array.from({ length: 9 }, (_, index) => `https://temp.bragi.now/image-${index}.png`),
		refAudios: Array.from({ length: 3 }, (_, index) => `https://temp.bragi.now/audio-${index}.mp3`),
		aspect_ratio: 'adaptive',
	})
	assert.equal(imageAudioRefs.image_urls.length, 9)
	assert.equal(imageAudioRefs.audio_urls.length, 3)
	assert.equal(imageAudioRefs.aspect_ratio, 'adaptive')

	const multimodalRefs = buildApimartMinimaxH3Request('Use every reference deliberately', {
		genMode: 'video-ref',
		refImages: ['https://temp.bragi.now/character.png'],
		refVideos: Array.from({ length: 3 }, (_, index) => `https://temp.bragi.now/motion-${index}.mp4`),
		refAudios: ['https://temp.bragi.now/voice.wav'],
		aspectRatio: '9:16',
	})
	assert.deepEqual(multimodalRefs.image_urls, ['https://temp.bragi.now/character.png'])
	assert.equal(multimodalRefs.video_urls.length, 3)
	assert.deepEqual(multimodalRefs.audio_urls, ['https://temp.bragi.now/voice.wav'])
	assert.equal(multimodalRefs.aspect_ratio, '9:16')

	assert.throws(() => buildApimartMinimaxH3Request('   '), /prompt is required/)
	assert.throws(() => buildApimartMinimaxH3Request('x'.repeat(7001)), /at most 7000 characters/)
	for (const duration of [3, 16, 4.5, 'not-a-number']) {
		assert.throws(() => buildApimartMinimaxH3Request('Bad duration', { duration }), /whole number from 4 to 15/)
	}
	assert.throws(() => buildApimartMinimaxH3Request('Bad resolution', { resolution: '1080P' }), /resolution must be 2K or 768P/)
	assert.throws(() => buildApimartMinimaxH3Request('Bad ratio', { aspect_ratio: '2:1' }), /does not support aspect ratio/)
	assert.throws(() => buildApimartMinimaxH3Request('Bad watermark', { watermark: 'yes' }), /watermark must be true or false/)
	assert.throws(() => buildApimartMinimaxH3Request('Bad mode', { genMode: 'video-edit' }), /does not support video-edit/)
	assert.throws(() => buildApimartMinimaxH3Request('T2V with ref', {
		refImages: ['https://temp.bragi.now/ref.png'],
	}), /does not accept reference media/)
	assert.throws(() => buildApimartMinimaxH3Request('Missing first frame', { genMode: 'first-frame' }), /requires exactly one reference image/)
	assert.throws(() => buildApimartMinimaxH3Request('Frame mixed with audio', {
		genMode: 'first-frame',
		refImages: ['https://temp.bragi.now/first.png'],
		refAudios: ['https://temp.bragi.now/voice.mp3'],
	}), /cannot be combined with reference video or audio/)
	assert.throws(() => buildApimartMinimaxH3Request('Missing last frame', {
		genMode: 'first-last-frame',
		refImages: ['https://temp.bragi.now/first.png'],
	}), /requires exactly two reference images/)
	assert.throws(() => buildApimartMinimaxH3Request('Audio alone', {
		refAudios: ['https://temp.bragi.now/voice.mp3'],
	}), /must be paired with a reference image or video/)
	assert.throws(() => buildApimartMinimaxH3Request('Image mode without image', {
		genMode: 'image-ref',
	}), /requires at least one reference image/)
	assert.throws(() => buildApimartMinimaxH3Request('Image mode with video', {
		genMode: 'image-ref',
		refImages: ['https://temp.bragi.now/character.png'],
		refVideos: ['https://temp.bragi.now/motion.mp4'],
	}), /use video-ref mode/)
	assert.throws(() => buildApimartMinimaxH3Request('Video mode without video', {
		genMode: 'video-ref',
		refImages: ['https://temp.bragi.now/character.png'],
	}), /requires at least one reference video/)
	assert.throws(() => buildApimartMinimaxH3Request('Too many images', {
		genMode: 'image-ref',
		refImages: Array.from({ length: 10 }, (_, index) => `https://temp.bragi.now/${index}.png`),
	}), /at most 9 reference images/)
	assert.throws(() => buildApimartMinimaxH3Request('Too many videos', {
		genMode: 'video-ref',
		refVideos: Array.from({ length: 4 }, (_, index) => `https://temp.bragi.now/${index}.mp4`),
	}), /at most 3 reference videos/)
	assert.throws(() => buildApimartMinimaxH3Request('Too many audios', {
		genMode: 'image-ref',
		refImages: ['https://temp.bragi.now/character.png'],
		refAudios: Array.from({ length: 4 }, (_, index) => `https://temp.bragi.now/${index}.mp3`),
	}), /at most 3 reference audio clips/)

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
	const provider = new APIMartProvider('test-key', app, 'assets')
	let taskCounter = 0
	process.__bragiApimartH3RequestHandler = async (request) => {
		requests.push(request)
		if (request.url === 'https://example.com/voice.mp3') {
			return {
				status: 200,
				headers: { 'Content-Type': 'audio/mpeg' },
				arrayBuffer: new Uint8Array([73, 68, 51]).buffer,
			}
		}
		if (request.url === 'https://temp.bragi.now/upload?ext=mp3') {
			return { status: 200, json: { url: 'https://temp.bragi.now/relayed-voice.mp3' } }
		}
		if (request.url === 'https://api.apimart.ai/v1/videos/generations') {
			taskCounter++
			return { status: 200, json: { code: 200, data: [{ status: 'submitted', task_id: `h3-task-${taskCounter}` }] } }
		}
		throw new Error(`Unexpected request: ${request.url}`)
	}

	assert.deepEqual(await provider.generateVideo('A silver train crosses the desert', {
		modelId: 'MiniMax-H3',
		genMode: 'text-to-video',
		duration: 6,
		resolution: '2K',
		aspect_ratio: '21:9',
	}), { done: false, taskId: 'h3-task-1' })
	const requestsAfterTextSubmit = requests.length
	await assert.rejects(
		() => provider.generateVideo('Do not misroute this mode', {
			modelId: 'MiniMax-H3',
			genMode: 'motion-control',
		}),
		/does not support motion-control mode/,
	)
	assert.equal(requests.length, requestsAfterTextSubmit, 'Invalid H3 modes must fail before any provider request.')
	assert.equal(requests[0].url, 'https://api.apimart.ai/v1/videos/generations')
	assert.equal(requests[0].headers.Authorization, 'Bearer test-key')
	assert.deepEqual(JSON.parse(requests[0].body), {
		model: 'MiniMax-H3',
		prompt: 'A silver train crosses the desert',
		duration: 6,
		resolution: '2K',
		watermark: false,
		aspect_ratio: '21:9',
	})

	assert.deepEqual(await provider.generateVideo('Match the person and voice', {
		modelId: 'MiniMax-H3',
		genMode: 'image-ref',
		refImages: ['https://temp.bragi.now/character.png'],
		refAudios: ['https://example.com/voice.mp3'],
	}), { done: false, taskId: 'h3-task-2' })
	const relayUpload = requests.find(request => request.url === 'https://temp.bragi.now/upload?ext=mp3')
	assert.equal(relayUpload.headers['Content-Type'], 'audio/mpeg')
	assert.match(relayUpload.headers.Authorization, /^Bearer /)
	const refSubmit = requests.filter(request => request.url === 'https://api.apimart.ai/v1/videos/generations').at(-1)
	assert.deepEqual(JSON.parse(refSubmit.body).audio_urls, ['https://temp.bragi.now/relayed-voice.mp3'])

	process.__bragiApimartH3RequestHandler = async (request) => {
		requests.push(request)
		if (request.url.endsWith('/tasks/pending-task')) {
			return { status: 200, json: { data: { status: 'processing' } } }
		}
		throw new Error(`Unexpected request: ${request.url}`)
	}
	assert.deepEqual(await provider.checkStatus('pending-task'), { done: false, taskId: 'pending-task' })

	process.__bragiApimartH3RequestHandler = async (request) => {
		requests.push(request)
		if (request.url.endsWith('/tasks/failed-task')) {
			return { status: 200, json: { data: { status: 'failed', error: { code: 'content_rejected', message: 'unsafe input' } } } }
		}
		throw new Error(`Unexpected request: ${request.url}`)
	}
	await assert.rejects(() => provider.checkStatus('failed-task'), /content_rejected.*unsafe input/)

	process.__bragiApimartH3RequestHandler = async (request) => {
		requests.push(request)
		if (request.url.endsWith('/tasks/completed-task')) {
			return { status: 200, json: { data: { status: 'completed', result: { videos: [{ url: 'https://cdn.example/h3-result.mp4' }] } } } }
		}
		if (request.url === 'https://cdn.example/h3-result.mp4') {
			return { status: 200, arrayBuffer: new Uint8Array([1, 2, 3, 4]).buffer }
		}
		throw new Error(`Unexpected request: ${request.url}`)
	}
	const completed = await provider.checkStatus('completed-task')
	assert.match(completed.filePath, /^assets\/apimart_video_\d+\.mp4$/)
	assert.equal(writes.length, 1)
	assert.deepEqual([...new Uint8Array(writes[0].data)], [1, 2, 3, 4])

	process.__bragiApimartH3RequestHandler = async () => ({
		status: 400,
		json: { error: { code: 'invalid_request_error', message: 'Invalid request parameters' } },
		text: '',
	})
	await assert.rejects(
		() => provider.generateVideo('Rejected request', { modelId: 'MiniMax-H3', genMode: 'text-to-video' }),
		/APIMart MiniMax-H3: invalid_request_error — Invalid request parameters/,
	)

	const catalog = await testRuntime("export {minimaxH3} from './src/models/minimax-h3'; export {inferMode} from './src/generation-mode'; export {migrateSettings} from './src/settings-migrations';")
	try {
		const {minimaxH3, inferMode, migrateSettings} = catalog.module
		assert.equal(minimaxH3.supportedProviders.apimart.apiModelId, 'MiniMax-H3')
		assert.equal(inferMode(minimaxH3.modes, 1, 0, 1), 'image-ref')
		assert.equal(inferMode(minimaxH3.modes, 0, 1, 1), 'video-ref')
		assert.equal(inferMode(minimaxH3.modes, 0, 0, 1, true), 'video-ref')
		assert.notEqual(migrateSettings({settingsSchemaVersion:14,providers:{apimart:'test-key'},modelPrefs:{'minimax-h3':{enabled:false}},providerModelPrefs:{apimart:{'minimax-h3':false}}}).settings.modelPrefs['minimax-h3']?.enabled, true)
	} finally { await catalog.cleanup() }

	console.log('APIMart MiniMax-H3 payload, provider, relay, polling, catalog, and input inference checks passed.')
} finally {
	delete process.__bragiApimartH3RequestHandler
	await rm(tempDir, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const tempDir = await mkdtemp(join(tmpdir(), 'bragi-pika-provider-'))
const bundlePath = join(tempDir, 'pika-provider.mjs')

try {
	await build({
		entryPoints: ['src/providers/pika.ts'],
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
							return process.__bragiPikaRequestHandler(options)
						}
					`,
					loader: 'js',
				}))
			},
		}],
	})

	const {
		buildPikaVideoRequest,
		PikaVideoProvider,
		testPikaConnection,
	} = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`)

	const stdText = buildPikaVideoRequest('A slow pan', {
		modelId: 'kling-3.0',
		genMode: 'text-to-video',
		mode: 'std',
		duration: '5',
		aspect_ratio: '16:9',
	})
	assert.equal(stdText.path, '/v1/media/kling/kling-3.0/text-to-video')
	assert.deepEqual(stdText.body, {
		prompt: 'A slow pan',
		duration: '5',
		aspect_ratio: '16:9',
	})

	const h3 = (genMode, extra = {}) => buildPikaVideoRequest('A slow pan', {
		modelId: 'minimax/h3', genMode, duration: 4, resolution: '768P', watermark: 'false', ...extra,
	})
	const image = 'https://relay.example/one.png'
	const image2 = 'https://relay.example/two.png'
	const video = 'https://relay.example/motion.mp4'
	const audio = 'https://relay.example/voice.wav'
	assert.deepEqual(h3('text-to-video'), {
		path: '/v1/media/minimax/h3/text-to-video',
		body: { prompt: 'A slow pan', duration: 4, resolution: '768P', aigc_watermark: false, ratio: '16:9' },
	})
	assert.deepEqual(h3('first-frame', { refImages: [image] }), {
		path: '/v1/media/minimax/h3/image-to-video',
		body: { prompt: 'A slow pan', duration: 4, resolution: '768P', aigc_watermark: false, first_frame_image: image },
	})
	assert.deepEqual(h3('first-last-frame', { refImages: [image, image2] }), {
		path: '/v1/media/minimax/h3/image-to-video',
		body: { prompt: 'A slow pan', duration: 4, resolution: '768P', aigc_watermark: false, first_frame_image: image, last_frame_image: image2 },
	})
	assert.deepEqual(h3('image-ref', { refImages: [image], refAudios: [audio] }), {
		path: '/v1/media/minimax/h3/reference-to-video',
		body: { prompt: 'A slow pan', duration: 4, resolution: '768P', aigc_watermark: false, ratio: 'adaptive', image_urls: [image], audio_urls: [audio] },
	})
	assert.deepEqual(h3('video-ref', { refImages: [image], refVideos: [video], refAudios: [audio] }), {
		path: '/v1/media/minimax/h3/reference-to-video',
		body: { prompt: 'A slow pan', duration: 4, resolution: '768P', aigc_watermark: false, ratio: 'adaptive', image_urls: [image], video_urls: [video], audio_urls: [audio] },
	})
	assert.deepEqual(h3('video-ref', { refAudios: [audio] }).body.audio_urls, [audio])
	assert.throws(() => h3('first-frame', { refImages: [image, image2] }), /exactly 1 image/)
	assert.throws(() => h3('video-ref'), /video or audio reference/)
	assert.throws(() => h3('image-ref', { refImages: [image], refVideos: [video] }), /no videos/)
	assert.throws(() => h3('image-ref', { refImages: [image], duration: 16 }), /4 to 15/)
	assert.throws(() => h3('image-ref', { refImages: [image], refAudios: ['data:audio/wav;base64,AAA'] }), /HTTP\(S\) reference URLs/)
	assert.throws(() => h3('video-ref', { refImages: Array(9).fill(image), refVideos: Array(3).fill(video), refAudios: [audio] }), /12 reference files/)

	const proImage = buildPikaVideoRequest('Blink and smile', {
		modelId: 'kling-3.0',
		genMode: 'first-frame',
		mode: 'pro',
		duration: '10',
		aspect_ratio: '9:16',
		refImages: ['https://relay.example/start.png'],
	})
	assert.equal(proImage.path, '/v1/media/kling/kling-3.0/image-to-video')
	assert.deepEqual(proImage.body, {
		prompt: 'Blink and smile',
		image: 'https://relay.example/start.png',
		duration: '10',
		aspect_ratio: '9:16',
	})

	const motion = buildPikaVideoRequest('Follow the dance', {
		modelId: 'kling-3.0',
		genMode: 'motion-control',
		refImages: ['https://relay.example/character.png'],
		refVideos: ['https://relay.example/motion.mp4'],
		character_orientation: 'video',
		keep_original_sound: 'yes',
	})
	assert.equal(motion.path, '/v1/media/kling/kling-3.0/motion-control')
	assert.deepEqual(motion.body, {
		prompt: 'Follow the dance',
		image_url: 'https://relay.example/character.png',
		video_url: 'https://relay.example/motion.mp4',
		character_orientation: 'video',
		keep_original_sound: 'yes',
	})

	assert.throws(
		() => buildPikaVideoRequest('Wake up', {
		modelId: 'kling-o3',
		genMode: 'first-frame',
		duration: 12,
		sound: 'on',
		refImages: ['https://relay.example/omni.png'],
		}),
		/does not support model "kling-o3"/,
	)

	assert.throws(
		() => buildPikaVideoRequest('x', { modelId: 'kling-3.0', genMode: 'first-last-frame' }),
		/does not support first-last-frame/,
	)
	assert.throws(
		() => buildPikaVideoRequest('x', { modelId: 'kling-o3', genMode: 'text-to-video' }),
		/does not support model "kling-o3"/,
	)
	assert.throws(
		() => buildPikaVideoRequest('x', { modelId: 'kling-3.0', genMode: 'first-frame', refImages: [] }),
		/requires one reference image/,
	)
	assert.throws(
		() => buildPikaVideoRequest('x', {
			modelId: 'kling-3.0',
			genMode: 'motion-control',
			refImages: ['https://relay.example/character.png'],
			refVideos: [],
		}),
		/requires one reference image and one reference video/,
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
	const provider = new PikaVideoProvider('test-key', app, 'assets')

	process.__bragiPikaRequestHandler = async (request) => {
		requests.push(request)
		return { status: 200, json: { id: 'job-1', status: 'queued' } }
	}
	const submit = await provider.generateVideo('Blink', {
		modelId: 'kling-3.0',
		genMode: 'first-frame',
		refImages: ['https://relay.example/start.png'],
	})
	assert.deepEqual(submit, { done: false, taskId: 'job-1' })
	assert.equal(requests[0].url, 'https://api.dev.pika.art/v1/media/kling/kling-3.0/image-to-video')
	assert.equal(requests[0].headers['X-API-Key'], 'test-key')

	process.__bragiPikaRequestHandler = async () => ({
		status: 403,
		json: { id: 'rejected-job', status: 'failed', error: { code: 'insufficient_balance', message: 'Insufficient org balance' } },
	})
	await assert.rejects(
		() => provider.generateVideo('Blink', { modelId: 'minimax/h3', genMode: 'text-to-video' }),
		/Insufficient org balance/,
	)

	process.__bragiPikaRequestHandler = async (request) => {
		requests.push(request)
		if (request.url.endsWith('/jobs/queued-job')) {
			return { status: 200, json: { id: 'queued-job', status: 'running' } }
		}
		throw new Error(`Unexpected request: ${request.url}`)
	}
	assert.deepEqual(await provider.checkStatus('queued-job'), {
		done: false,
		taskId: 'queued-job',
	})

	process.__bragiPikaRequestHandler = async (request) => {
		requests.push(request)
		return { status: 200, json: { id: 'failed-job', status: 'failed', error: 'render rejected' } }
	}
	await assert.rejects(() => provider.checkStatus('failed-job'), /render rejected/)
	process.__bragiPikaRequestHandler = async () => ({
		status: 200, json: { id: 'failed-job', status: 'failed', error: { code: 'provider_error', message: 'upstream generation failed' } },
	})
	await assert.rejects(() => provider.checkStatus('failed-job'), /upstream generation failed/)

	process.__bragiPikaRequestHandler = async (request) => {
		requests.push(request)
		if (request.url.endsWith('/jobs/complete-job')) {
			return {
				status: 200,
				json: {
					id: 'complete-job',
					status: 'completed',
					output: {
						media_type: 'video',
						video: { url: 'https://cdn.example/result.mp4', content_type: 'video/mp4' },
					},
				},
			}
		}
		if (request.url === 'https://cdn.example/result.mp4') {
			return { status: 200, arrayBuffer: new Uint8Array([1, 2, 3]).buffer }
		}
		throw new Error(`Unexpected request: ${request.url}`)
	}
	const complete = await provider.checkStatus('complete-job')
	assert.match(complete.filePath, /^assets\/pika_video_\d+\.mp4$/)
	assert.equal(writes.length, 1)
	assert.deepEqual([...new Uint8Array(writes[0].data)], [1, 2, 3])

	process.__bragiPikaRequestHandler = async (request) => {
		requests.push(request)
		if (request.url.endsWith('/jobs/content-job')) {
			return { status: 200, json: { id: 'content-job', status: 'completed' } }
		}
		if (request.url.endsWith('/jobs/content-job/content')) {
			return { status: 200, json: { url: 'https://cdn.example/content-result.mp4' } }
		}
		if (request.url === 'https://cdn.example/content-result.mp4') {
			return { status: 200, arrayBuffer: new Uint8Array([4, 5, 6]).buffer }
		}
		throw new Error(`Unexpected request: ${request.url}`)
	}
	const contentFallback = await provider.checkStatus('content-job')
	assert.match(contentFallback.filePath, /^assets\/pika_video_\d+\.mp4$/)
	assert.equal(writes.length, 2)

	process.__bragiPikaRequestHandler = async (request) => {
		requests.push(request)
		return { status: 200, json: { balance_micro_usd: 1000000 } }
	}
	assert.deepEqual(await testPikaConnection('valid-key'), { ok: true, message: 'Connected.' })
	assert.equal(requests.at(-1).url, 'https://api.dev.pika.art/billing/balance')
	process.__bragiPikaRequestHandler = async () => ({ status: 401, json: { message: 'Unauthorized' } })
	assert.deepEqual(await testPikaConnection('bad-key'), { ok: false, message: 'Invalid API key.' })

	const [settingsSource, migrationsSource, registrySource, modelSource, h3ModelSource, mainSource, modelRulesSource] = await Promise.all([
		readFile('src/settings.ts', 'utf8'),
		readFile('src/settings-migrations.ts', 'utf8'),
		readFile('src/providers/registry.ts', 'utf8'),
		readFile('src/models/kling.ts', 'utf8'),
		readFile('src/models/minimax-h3.ts', 'utf8'),
		readFile('src/main.ts', 'utf8'),
		readFile('docs/model-provider-rules.md', 'utf8'),
	])
	assert.match(settingsSource, /pika: string/, 'Settings type must include providers.pika.')
	assert.match(settingsSource, /pika: ''/, 'Default settings must include an empty Pika key.')
	assert.match(
		migrationsSource,
		/CURRENT_SETTINGS_SCHEMA_VERSION = (1[2-9]|[2-9]\d+)/,
		'Adding a provider credential must advance the settings schema version.',
	)
	assert.match(
		registrySource,
		/import \{ PikaVideoProvider, testPikaConnection \} from '\.\/pika'/,
		'Provider registry must import the Pika implementation and connection test.',
	)
	assert.match(
		registrySource,
		/id: 'pika'[\s\S]*?name: 'Pika'[\s\S]*?defaultRefDelivery: \{ image: 'relay', video: 'relay', audio: 'relay' \}[\s\S]*?makeVideo:/,
		'Provider registry must expose Pika as a relay-backed video provider.',
	)
	assert.match(
		registrySource,
		/testConnection: \(d\) => testPikaConnection\(d\.pika \|\| ''\)/,
		'Provider registry must use the non-generating Pika connection test.',
	)
	assert.match(
		modelSource,
		/id: 'kling-3\.0'[\s\S]*?pika: \{[\s\S]*?apiModelId: 'kling-3\.0'[\s\S]*?aggregated: true[\s\S]*?modes: \['text-to-video', 'first-frame', 'motion-control'\][\s\S]*?\}/,
		'Kling 3.0 must map Pika to the exact supported modes.',
	)
	assert.match(
		modelSource,
		/id: 'mode'[\s\S]*?providerOverrides: \{[\s\S]*?pika: \{ hidden: true \}/,
		'Kling 3.0 must hide the quality selector Pika does not support.',
	)
	assert.doesNotMatch(modelSource, /apiModelId: 'kling-o3'/, 'Pika must not expose an unavailable Kling O3 route.')
	assert.doesNotMatch(
		modelSource,
		/id: 'kling-3\.0-omni'[\s\S]*?providerOverrides: \{[^}]*pika/,
		'Kling 3.0 Omni params must not keep stale Pika provider overrides.',
	)
	assert.doesNotMatch(modelSource, /id: 'kling-o1'/, 'This change must not add a mismatched Kling O1 model.')
	assert.match(h3ModelSource, /pika: \{ apiModelId: 'minimax\/h3', aggregated: true \}/)
	assert.match(mainSource, /supportsMinimaxH3Refs = \(activeProvider === 'apimart' \|\| activeProvider === 'pika'\)/)
	assert.match(
		modelRulesSource,
		/## Pika Kling[\s\S]*kling-3\.0[\s\S]*does not list a compatible Kling 3\.0 Omni model/,
		'Provider rules must document the supported Pika Kling 3.0 route and unavailable Omni mapping.',
	)

	console.log('Pika provider checks passed.')
} finally {
	delete process.__bragiPikaRequestHandler
	await rm(tempDir, { recursive: true, force: true })
}

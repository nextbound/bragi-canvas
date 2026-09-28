import './test-window.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const tempDir = await mkdtemp(join(tmpdir(), 'bragi-xai-grok-'))

try {
	const providerBundle = join(tempDir, 'provider.mjs')
	const catalogBundle = join(tempDir, 'catalog.mjs')
	await build({
		entryPoints: ['src/providers/xai.ts'],
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
							return process.__bragiXaiRequestHandler(options)
						}
					`,
					loader: 'js',
				}))
			},
		}],
	})
	await build({
		entryPoints: ['src/models/grok.ts'],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile: catalogBundle,
		logLevel: 'silent',
	})

	const { XAIImageProvider, XAIVideoProvider } = await import(`${pathToFileURL(providerBundle).href}?t=${Date.now()}`)
	const { grokImagine, grokVideo } = await import(`${pathToFileURL(catalogBundle).href}?t=${Date.now()}`)
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

	assert.equal(grokImagine.id, 'grok-imagine')
	assert.equal(grokImagine.name, 'Grok Imagine')
	assert.equal(grokImagine.supportedProviders.xai.apiModelId, 'grok-imagine-image-2.0')
	assert.equal(grokImagine.supportedProviders.fal.apiModelId, 'xai/grok-imagine-image')
	const imageAspect = grokImagine.params.find(param => param.id === 'aspectRatio')
	const imageResolution = grokImagine.params.find(param => param.id === 'resolution')
	const imageQuality = grokImagine.params.find(param => param.id === 'quality')
	assert.equal(imageAspect.options.length, 14)
	assert.equal(imageAspect.default, 'auto')
	assert.equal(imageAspect.providerOverrides.fal.options.length, 9)
	assert.equal(imageResolution.providerOverrides.fal.hidden, true)
	assert.equal(imageQuality.providerOverrides.fal.hidden, true)

	assert.equal(grokVideo.id, 'grok-video')
	assert.equal(grokVideo.name, 'Grok Video')
	assert.equal(grokVideo.supportedProviders.xai.apiModelId, 'grok-imagine-video-1.5')
	assert.equal(grokVideo.supportedProviders.xai.aggregated, true)
	assert.deepEqual(grokVideo.modes, ['text-to-video', 'first-frame', 'image-ref', 'video-edit', 'video-extend'])
	assert.deepEqual(grokVideo.supportedProviders.fal.modes, ['text-to-video', 'first-frame', 'image-ref', 'video-extend'])
	assert.deepEqual(grokVideo.supportedProviders.svnewapi.modes, ['text-to-video', 'first-frame', 'image-ref', 'video-extend'])
	const durationParam = grokVideo.params.find(param => param.id === 'duration')
	assert.equal(durationParam.optionsByMode['image-ref'].length, 10)
	assert.equal(durationParam.providerOverrides.xai.optionsByMode['image-ref'].length, 15)
	assert.equal(durationParam.optionsByMode['video-extend'].length, 9)
	const resolutionParam = grokVideo.params.find(param => param.id === 'resolution')
	assert.equal(resolutionParam.optionsByMode['image-ref'].length, 2)

	let imageCounter = 0
	process.__bragiXaiRequestHandler = async request => {
		requests.push(request)
		if (request.url.startsWith('https://api.x.ai/v1/images/')) {
			imageCounter++
			return { status: 200, json: { data: [{ url: `https://cdn.example/image-${imageCounter}.jpg` }] } }
		}
		if (request.url.startsWith('https://cdn.example/image-')) {
			return { status: 200, arrayBuffer: new Uint8Array([255, 216, 255, 217]).buffer }
		}
		throw new Error(`Unexpected image request: ${request.url}`)
	}

	const imageProvider = new XAIImageProvider('test-key', app, 'assets')
	await imageProvider.generateImage('A glass observatory above the clouds', {
		modelId: 'grok-imagine-image-2.0',
		aspectRatio: 'auto',
		resolution: '2k',
		quality: 'low',
	})
	let request = requests.find(item => item.url.endsWith('/images/generations'))
	assert.equal(request.headers.Authorization, 'Bearer test-key')
	assert.deepEqual(JSON.parse(request.body), {
		model: 'grok-imagine-image-2.0',
		prompt: 'A glass observatory above the clouds',
		n: 1,
		resolution: '2k',
		quality: 'low',
		response_format: 'url',
	})

	await imageProvider.generateImage('Add a copper frame', {
		modelId: 'grok-imagine-image-2.0',
		aspectRatio: '16:9',
		resolution: '1k',
		quality: 'medium',
		refImages: ['https://refs.example/source.jpg'],
	})
	request = requests.filter(item => item.url.endsWith('/images/edits')).at(-1)
	assert.deepEqual(JSON.parse(request.body).image, { url: 'https://refs.example/source.jpg' })
	assert.equal(JSON.parse(request.body).images, undefined)

	await imageProvider.generateImage('Combine the subjects', {
		refImages: ['https://refs.example/1.jpg', 'https://refs.example/2.jpg', 'https://refs.example/3.jpg'],
	})
	request = requests.filter(item => item.url.endsWith('/images/edits')).at(-1)
	assert.deepEqual(JSON.parse(request.body).images, [
		{ url: 'https://refs.example/1.jpg' },
		{ url: 'https://refs.example/2.jpg' },
		{ url: 'https://refs.example/3.jpg' },
	])
	assert.equal(JSON.parse(request.body).image, undefined)
	await assert.rejects(
		() => imageProvider.generateImage('Too many', { refImages: ['1', '2', '3', '4'] }),
		/at most 3 reference images/,
	)
	await assert.rejects(() => imageProvider.generateImage('Bad quality', { quality: 'high' }), /low or medium/)

	let taskCounter = 0
	process.__bragiXaiRequestHandler = async requestOptions => {
		requests.push(requestOptions)
		if (/\/videos\/(generations|edits|extensions)$/.test(requestOptions.url)) {
			taskCounter++
			return { status: 200, json: { request_id: `task-${taskCounter}` } }
		}
		throw new Error(`Unexpected video request: ${requestOptions.url}`)
	}
	const videoProvider = new XAIVideoProvider('test-key', app, 'assets')

	assert.deepEqual(await videoProvider.generateVideo('Launch through the clouds', {
		modelId: 'grok-imagine-video-1.5', genMode: 'text-to-video', duration: 15,
		aspect_ratio: '9:16', resolution: '1080p',
	}), { done: false, taskId: 'task-1' })
	request = requests.filter(item => item.url.endsWith('/videos/generations')).at(-1)
	assert.deepEqual(JSON.parse(request.body), {
		model: 'grok-imagine-video-1.5', prompt: 'Launch through the clouds',
		duration: 15, aspect_ratio: '9:16', resolution: '1080p',
	})

	await videoProvider.generateVideo('Animate the portrait', {
		genMode: 'first-frame', duration: 1, aspect_ratio: '1:1', resolution: '1080p',
		refImages: ['https://refs.example/frame.jpg'],
	})
	request = requests.filter(item => item.url.endsWith('/videos/generations')).at(-1)
	assert.deepEqual(JSON.parse(request.body).image, { url: 'https://refs.example/frame.jpg' })

	const sevenRefs = Array.from({ length: 7 }, (_, index) => `https://refs.example/ref-${index}.jpg`)
	await videoProvider.generateVideo('Keep every subject consistent', {
		genMode: 'image-ref', duration: 15, aspect_ratio: '16:9', resolution: '720p', refImages: sevenRefs,
	})
	request = requests.filter(item => item.url.endsWith('/videos/generations')).at(-1)
	assert.equal(JSON.parse(request.body).reference_images.length, 7)

	await videoProvider.generateVideo('Change the coat to red', {
		genMode: 'video-edit', duration: 99, aspect_ratio: 'bad', resolution: 'bad',
		refVideos: ['https://refs.example/base.mp4'],
	})
	request = requests.filter(item => item.url.endsWith('/videos/edits')).at(-1)
	assert.deepEqual(JSON.parse(request.body), {
		model: 'grok-imagine-video', prompt: 'Change the coat to red',
		video: { url: 'https://refs.example/base.mp4' },
	})

	await videoProvider.generateVideo('Continue into a wide shot', {
		genMode: 'video-extend', duration: 2, refVideos: ['https://refs.example/base.mp4'],
	})
	request = requests.filter(item => item.url.endsWith('/videos/extensions')).at(-1)
	assert.deepEqual(JSON.parse(request.body), {
		model: 'grok-imagine-video', prompt: 'Continue into a wide shot',
		video: { url: 'https://refs.example/base.mp4' }, duration: 2,
	})

	await assert.rejects(() => videoProvider.generateVideo('Bad mode', { genMode: 'video-ref' }), /unsupported Grok Video mode/)
	await assert.rejects(() => videoProvider.generateVideo('Missing frame', { genMode: 'first-frame' }), /exactly one reference image/)
	await assert.rejects(() => videoProvider.generateVideo('Too many frames', { genMode: 'first-frame', refImages: ['1', '2'] }), /exactly one reference image/)
	await assert.rejects(() => videoProvider.generateVideo('Too many refs', { genMode: 'image-ref', refImages: [...sevenRefs, '8'] }), /at most 7/)
	await assert.rejects(() => videoProvider.generateVideo('Too large', { genMode: 'image-ref', refImages: ['1'], resolution: '1080p' }), /up to 720p/)
	await assert.rejects(() => videoProvider.generateVideo('Missing video', { genMode: 'video-edit' }), /exactly one upstream video/)
	await assert.rejects(() => videoProvider.generateVideo('Short extension', { genMode: 'video-extend', duration: 1, refVideos: ['v'] }), /2 to 10/)
	await assert.rejects(() => videoProvider.generateVideo('Text with ref', { genMode: 'text-to-video', refImages: ['1'] }), /does not accept reference images/)

	process.__bragiXaiRequestHandler = async requestOptions => {
		requests.push(requestOptions)
		if (requestOptions.url.endsWith('/videos/pending-http')) return { status: 202, json: {} }
		if (requestOptions.url.endsWith('/videos/pending-body')) return { status: 200, json: { status: 'pending' } }
		if (requestOptions.url.endsWith('/videos/failed')) {
			return { status: 200, json: { status: 'failed', error: { code: 'invalid_argument', message: 'unsafe input' } } }
		}
		if (requestOptions.url.endsWith('/videos/expired')) return { status: 200, json: { status: 'expired' } }
		if (requestOptions.url.endsWith('/videos/done')) {
			return { status: 200, json: { status: 'done', video: { url: 'https://cdn.example/result.mp4' } } }
		}
		if (requestOptions.url === 'https://cdn.example/result.mp4') {
			return { status: 200, arrayBuffer: new Uint8Array([0, 0, 0, 24]).buffer }
		}
		throw new Error(`Unexpected polling request: ${requestOptions.url}`)
	}
	assert.deepEqual(await videoProvider.checkStatus('pending-http'), { done: false, taskId: 'pending-http' })
	assert.deepEqual(await videoProvider.checkStatus('pending-body'), { done: false, taskId: 'pending-body' })
	await assert.rejects(() => videoProvider.checkStatus('failed'), /invalid_argument.*unsafe input/)
	await assert.rejects(() => videoProvider.checkStatus('expired'), /video expired.*no reason provided/)
	const done = await videoProvider.checkStatus('done')
	assert.equal(done.done, true)
	assert.match(done.filePath, /^assets\/grok_video_\d+\.mp4$/)
	assert.ok(writes.length >= 4)

	console.log('xAI Grok Imagine Image 2.0 and Video 1.5 checks passed.')
} finally {
	delete process.__bragiXaiRequestHandler
	await rm(tempDir, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const tempDir = await mkdtemp(join(tmpdir(), 'bragi-sonilo-music-'))
const live = process.argv.includes('--live')

async function bundle(input, name) {
	const outfile = join(tempDir, name)
	await build({
		entryPoints: [input], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
		plugins: [{
			name: 'mock-obsidian',
			setup(api) {
				api.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'mock-obsidian' }))
				api.onLoad({ filter: /.*/, namespace: 'mock-obsidian' }, () => ({
					contents: 'export async function requestUrl(request) { return process.__soniloRequest(request) }', loader: 'js',
				}))
			},
		}],
	})
	return import(pathToFileURL(outfile).href)
}

const response = (status, data, bytes = new Uint8Array()) => ({
	status, text: JSON.stringify(data), json: data, arrayBuffer: bytes.buffer,
})

const adapter = {
	exists: async () => true,
	mkdir: async () => {},
	writeBinary: async (path, bytes) => {
		const fullPath = join(tempDir, path)
		await mkdir(dirname(fullPath), { recursive: true })
		await writeFile(fullPath, Buffer.from(bytes))
	},
}

async function poll(provider, taskId, label) {
	for (let i = 0; i < 120; i++) {
		const result = await provider.checkStatus(taskId)
		if (result.done) {
			const fullPath = join(tempDir, result.filePath)
			const info = await stat(fullPath)
			assert.ok(info.size > 1000, `${label} file must contain real audio`)
			console.log(`${label}: success, ${info.size} bytes, ${fullPath}`)
			return
		}
		await delay(5000)
	}
	throw new Error(`${label}: timed out waiting for the existing task`)
}

try {
	const { SoniloProvider, buildSoniloRequest, encodeMultipartFields, testSoniloConnection } = await bundle('src/providers/sonilo.ts', 'sonilo.mjs')
	assert.deepEqual(buildSoniloRequest('  海边钢琴  ', { mode: 'music', duration: 5, output_format: 'mp3' }), {
		path: '/text-to-music', fields: { mode: 'async', output_format: 'mp3', variants_num: '1', prompt: '海边钢琴', duration: '5' },
	})
	assert.deepEqual(buildSoniloRequest('ambient', { mode: 'video-to-music', refVideos: ['https://example.com/a.mp4'], prompt_influence: 0.3 }), {
		path: '/video-to-music', fields: { mode: 'async', output_format: 'mp3', variants_num: '1', video_url: 'https://example.com/a.mp4', prompt: 'ambient', prompt_influence: '0.3' },
	})
	assert.match(new TextDecoder().decode(encodeMultipartFields({ prompt: '海边钢琴' }, 'test')), /海边钢琴/)
	assert.throws(() => buildSoniloRequest('x', { mode: 'music', duration: 4 }), /duration/)
	assert.throws(() => buildSoniloRequest('x', { mode: 'video-to-music', refVideos: [] }), /one upstream video/)

	const provider = new SoniloProvider('test-key', { vault: { adapter } }, 'assets')
	let calls = 0
	process.__soniloRequest = async (req) => {
		calls++
		if (req.url.endsWith('/text-to-music')) {
			assert.match(new TextDecoder().decode(req.body), /name="mode"\r\n\r\nasync/)
			return response(202, { task_id: 'mock-1', status: 'processing' })
		}
		if (req.url.endsWith('/tasks/mock-1')) return response(200, { status: 'succeeded', audio: [{ url: 'https://example.com/result.mp3', content_type: 'audio/mpeg' }] })
		if (req.url.endsWith('/result.mp3')) return response(200, {}, new Uint8Array([1, 2, 3]))
		if (req.url.endsWith('/account/services')) return response(200, { available_services: ['text_to_music', 'video_to_music'] })
		throw new Error(`Unexpected URL ${req.url}`)
	}
	const started = await provider.generateAudio('ambient', { mode: 'music', duration: 5 })
	assert.deepEqual(started, { done: false, taskId: 'sonilo:mock-1' })
	// A fresh provider instance can resume the persisted task ID after restart.
	const resumedProvider = new SoniloProvider('test-key', { vault: { adapter } }, 'assets')
	const completed = await resumedProvider.checkStatus(started.taskId)
	assert.ok(completed.done && completed.filePath.endsWith('.mp3'))
	assert.deepEqual(await readFile(join(tempDir, completed.filePath)), Buffer.from([1, 2, 3]))
	assert.deepEqual(await testSoniloConnection('test-key'), { ok: true, message: 'Connected.' })
	assert.equal(calls, 4)
	process.__soniloRequest = async () => response(402, { error: { message: 'Insufficient credits' } })
	await assert.rejects(() => provider.generateAudio('ambient', { mode: 'music', duration: 5 }), /Insufficient credits/)
	process.__soniloRequest = async () => response(429, { error: { message: 'Concurrent limit' } })
	await assert.rejects(() => provider.checkStatus('sonilo:rate-limited'), error => error.kind === 'retryable')
	console.log('Sonilo offline checks passed.')

	if (live) {
		const apiKey = process.env.SONILO_API_KEY
		const videoPath = process.env.SONILO_TEST_VIDEO_PATH
		if (!apiKey || !videoPath) throw new Error('SONILO_API_KEY and SONILO_TEST_VIDEO_PATH are required for live verification.')
		process.__soniloRequest = async (req) => {
			const http = await fetch(req.url, {
				method: req.method || 'GET', headers: req.headers,
				body: req.body ? Buffer.from(req.body) : undefined,
			})
			const arrayBuffer = await http.arrayBuffer()
			const contentType = http.headers.get('content-type') || ''
			const text = /json|text/.test(contentType) ? new TextDecoder().decode(arrayBuffer) : ''
			let json = {}
			try { json = JSON.parse(text) } catch { /* binary response */ }
			return { status: http.status, text, json, arrayBuffer }
		}
		const connection = await testSoniloConnection(apiKey)
		assert.ok(connection.ok, connection.message)
		const liveProvider = new SoniloProvider(apiKey, { vault: { adapter } }, 'assets')
		const textTask = await liveProvider.generateAudio('Gentle instrumental piano and soft strings, calm seaside at dawn, no vocals.', {
			mode: 'music', duration: 5, output_format: 'mp3',
		})
		console.log('Text music task accepted.')
		await poll(liveProvider, textTask.taskId, 'Text music')

		const { uploadToBragiRelay, BUILTIN_BRAGI_RELAY } = await bundle('src/providers/bragi-relay.ts', 'relay.mjs')
		const videoBytes = await readFile(videoPath)
		const videoUrl = await uploadToBragiRelay(BUILTIN_BRAGI_RELAY, videoBytes.buffer.slice(videoBytes.byteOffset, videoBytes.byteOffset + videoBytes.byteLength), 'source.mp4', 'video/mp4')
		assert.match(videoUrl, /^https:\/\//)
		console.log('Video uploaded through Bragi Relay.')
		const videoTask = await liveProvider.generateAudio('Soft cinematic instrumental score that follows the scene, no vocals.', {
			mode: 'video-to-music', refVideos: [videoUrl], prompt_influence: 0.5, output_format: 'mp3',
		})
		console.log('Video music task accepted.')
		await poll(liveProvider, videoTask.taskId, 'Video music')
	}
} finally {
	if (!live) await rm(tempDir, { recursive: true, force: true })
}

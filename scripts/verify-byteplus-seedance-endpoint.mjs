import './test-window.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const tempDir = await mkdtemp(join(tmpdir(), 'bragi-byteplus-seedance-endpoint-'))
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
							return process.__bragiBytePlusEndpointRequestHandler(options)
						}
					`,
					loader: 'js',
				}))
			},
		}],
	})

	const { SeedanceProvider } = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`)
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
	const customEndpoint = 'https://gateway.example.test/custom/seedance/tasks///'
	const provider = new SeedanceProvider('test-key', app, 'assets', customEndpoint)

	process.__bragiBytePlusEndpointRequestHandler = async (request) => {
		requests.push(request)
		return { status: 200, json: { id: requests.length === 1 ? 'custom-task-25' : 'custom-task-20' }, text: '' }
	}
	assert.deepEqual(await provider.generateVideo('A paper boat sails', {
		modelId: 'dreamina-seedance-2-5-260628',
		genMode: 'text-to-video',
	}, { catalogModelId: 'seedance-2.5' }), { done: false, taskId: 'custom-task-25' })
	assert.equal(requests[0].url, 'https://gateway.example.test/custom/seedance/tasks')
	assert.deepEqual(await provider.generateVideo('A paper boat sails', {
		modelId: 'dreamina-seedance-2-0-260128',
		genMode: 'text-to-video',
	}, { catalogModelId: 'seedance-2.0' }), { done: false, taskId: 'custom-task-20' })
	assert.equal(requests[1].url, 'https://gateway.example.test/custom/seedance/tasks')

	process.__bragiBytePlusEndpointRequestHandler = async (request) => {
		requests.push(request)
		if (request.url === 'https://gateway.example.test/custom/seedance/tasks/custom-task-25') {
			return { status: 200, json: { status: 'succeeded', content: { video_url: 'https://cdn.example/result.mp4' } }, text: '' }
		}
		if (request.url === 'https://cdn.example/result.mp4') {
			return { status: 200, arrayBuffer: new Uint8Array([1, 2, 3]).buffer }
		}
		throw new Error(`Unexpected request: ${request.url}`)
	}
	const completed = await provider.checkStatus('custom-task-25')
	assert.match(completed.filePath, /^assets\/vid_\d+\.mp4$/)
	assert.equal(writes.length, 1)

	const [settingsSource, registrySource, modelSource, providerRules] = await Promise.all([
		readFile('src/settings.ts', 'utf8'),
		readFile('src/providers/registry.ts', 'utf8'),
		readFile('src/models/seedance.ts', 'utf8'),
		readFile('docs/model-provider-rules.md', 'utf8'),
	])
	assert.match(settingsSource, /byteplusSeedanceEndpoint: string/)
	assert.match(settingsSource, /byteplusSeedanceEndpoint: BYTEPLUS_SEEDANCE_ENDPOINT/)
	assert.match(registrySource, /key: 'byteplusSeedanceEndpoint', label: 'Seedance endpoint'/)
	assert.match(registrySource, /new SeedanceProvider\(settings\.providers\.byteplus, app, outputDir, settings\.providers\.byteplusSeedanceEndpoint\)/)
	assert.match(registrySource, /testSeedanceEndpoint\([\s\S]*normalizeSeedanceEndpoint\(d\.byteplusSeedanceEndpoint, BYTEPLUS_SEEDANCE_ENDPOINT\)/)
	assert.match(modelSource, /id: 'seedance-2\.5'[\s\S]*byteplus:/)
	assert.match(modelSource, /id: 'seedance-2\.0'[\s\S]*byteplus:/)
	assert.match(providerRules, /override the complete Seedance task endpoint for Seedance 2\.0, 2\.0 Fast, and 2\.5/)

	console.log('BytePlus Seedance endpoint checks passed.')
} finally {
	delete process.__bragiBytePlusEndpointRequestHandler
	await rm(tempDir, { recursive: true, force: true })
}

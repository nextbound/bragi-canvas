import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const tempDir = await mkdtemp(path.join(tmpdir(), 'bragi-svnewapi-error-'))
const entry = path.join(tempDir, 'entry.ts')
const outfile = path.join(tempDir, 'svnewapi-error.mjs')

const obsidianStub = {
	name: 'obsidian-stub',
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'obsidian-stub' }))
		build.onLoad({ filter: /.*/, namespace: 'obsidian-stub' }, () => ({
			loader: 'js',
			contents: 'export const requestUrl = (...args) => globalThis.__bragiRequestUrl(...args);',
		}))
	},
}

const providerStub = {
	name: 'provider-stub',
	setup(build) {
		build.onResolve({ filter: /^\.\/(?:providers\/)?upload$/ }, () => ({ path: 'upload', namespace: 'provider-stub' }))
		build.onResolve({ filter: /^\.\/openai-image-size$/ }, () => ({ path: 'openai-image-size', namespace: 'provider-stub' }))
		build.onResolve({ filter: /^\.\/seedream$/ }, () => ({ path: 'seedream', namespace: 'provider-stub' }))
		build.onLoad({ filter: /^upload$/, namespace: 'provider-stub' }, () => ({
			loader: 'js',
			contents: 'export const uploadRef = async () => "https://refs.test/ref.png";',
		}))
		build.onLoad({ filter: /^openai-image-size$/, namespace: 'provider-stub' }, () => ({
			loader: 'js',
			contents: 'export const resolveOpenAIImageSize = () => "1024x1024";',
		}))
		build.onLoad({ filter: /^seedream$/, namespace: 'provider-stub' }, () => ({
			loader: 'js',
			contents: 'export const resolveSeedreamImageSize = () => "2048x2048";',
		}))
	},
}

const jsonError = 'BytePlus CreateAsset: InvalidParameter.FpsTooLow - Frame rate is too low'

try {
	const providerPath = path.resolve('src/providers/svnewapi.ts')
	await writeFile(entry, `
		import { SvNewApiVideoProvider } from ${JSON.stringify(providerPath)}
		import { ensureSvNewApiAsset } from ${JSON.stringify(path.resolve('src/svnewapi-asset-flow.ts'))}

		export async function runAssetRegisterFailure() {
			const stages = [], requests = []
			globalThis.__bragiRequestUrl = async options => {
				requests.push(options.url)
				return { status: 502, json: { error: 'upstream unavailable, request id: req_asset' }, text: '' }
			}
			try {
				await ensureSvNewApiAsset({ app: { vault: { adapter: { readBinary: async () => new ArrayBuffer(1) } } } }, { nodes: new Map() }, 'reference.png', 'sv-seedance-2.5', { baseUrl: 'https://gateway.test', apiKey: 'key' }, stage => stages.push(stage))
			} catch (error) { return { message: error.message, stages, requests } }
			throw new Error('Expected asset registration to fail')
		}

		const provider = () => new SvNewApiVideoProvider('key', {}, 'out', 'https://gateway.test')

		export async function runJsonError() {
			globalThis.__bragiRequestUrl = async () => ({
				status: 502,
				json: { error: ${JSON.stringify(jsonError)} },
				text: JSON.stringify({ error: ${JSON.stringify(jsonError)} }),
			})
			await provider().generateVideo('prompt', { modelId: 'sv-seedance-2.0' })
		}

		export async function runPlainTextError() {
			globalThis.__bragiRequestUrl = async () => {
				const response = { status: 502, text: 'error code: 502\\n' }
				Object.defineProperty(response, 'json', {
					get() { throw new SyntaxError("Unexpected token 'e'") },
				})
				return response
			}
			await provider().generateVideo('prompt', { modelId: 'sv-seedance-2.0' })
		}

		export async function runCompletedSeedance25TaskFailure() {
			globalThis.__bragiRequestUrl = async () => ({
				status: 200,
				json: {
					id: 'task_seedance25_failed',
					task_id: 'task_seedance25_failed',
					object: 'video',
					model: 'sv-seedance-2.5',
					status: 'failed',
					progress: 100,
					error: {
						code: 'OutputAudioSensitiveContentDetected',
						message: 'The request failed because the output audio may contain sensitive information. Request id: req_123',
					},
					metadata: { url: '' },
				},
				text: '',
			})
			await provider().checkStatus('task_seedance25_failed')
		}

		export async function runCompletedNonSeedanceTaskFailure() {
			globalThis.__bragiRequestUrl = async () => ({
				status: 200,
				json: {
					id: 'task_other_failed',
					task_id: 'task_other_failed',
					object: 'video',
					model: 'sv-grok-video',
					status: 'failed',
					progress: 100,
					error: {
						code: 'upstream_failure',
						message: 'The upstream video request failed.',
					},
					metadata: { url: '' },
				},
				text: '',
			})
			await provider().checkStatus('task_other_failed')
		}
	`)

	await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile,
		logLevel: 'silent',
		plugins: [obsidianStub, providerStub],
	})

	const mod = await import(pathToFileURL(outfile).href)
	const assetFailure = await mod.runAssetRegisterFailure()
	assert.match(assetFailure.message, /HTTP 502/)
	assert.match(assetFailure.message, /Video generation has not started/)
	assert.match(assetFailure.message, /request id: req_asset/)
	assert.deepEqual(assetFailure.stages, ['Uploading reference', 'Registering reference'])
	assert.deepEqual(assetFailure.requests, ['https://gateway.test/v1/assets'], 'Asset failures must not submit a video')
	const expectedJsonMessage = `SV NewAPI video: ${jsonError}`
	await assert.rejects(
		mod.runJsonError(),
		error => error instanceof Error && error.message === expectedJsonMessage,
		'JSON error strings from SVRouter should be shown without the JSON envelope',
	)
	await assert.rejects(
		mod.runPlainTextError(),
		error => error instanceof Error && error.message === 'SV NewAPI video: error code: 502',
		'plain-text SVRouter errors should preserve the HTTP body',
	)
	await assert.rejects(
		mod.runCompletedSeedance25TaskFailure(),
		error => error instanceof Error && error.message === 'SV NewAPI video: OutputAudioSensitiveContentDetected — The request failed because the output audio may contain sensitive information. Request id: req_123',
		'a completed Seedance 2.5 task should expose both its provider error code and full message',
	)
	await assert.rejects(
		mod.runCompletedNonSeedanceTaskFailure(),
		error => error instanceof Error && error.message === 'SV NewAPI video: The upstream video request failed.',
		'non-Seedance task failures should retain their existing message-only presentation',
	)

	console.log('SV NewAPI error response checks passed.')
} finally {
	await rm(tempDir, { recursive: true, force: true })
}

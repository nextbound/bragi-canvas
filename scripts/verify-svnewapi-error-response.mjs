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
		build.onResolve({ filter: /^\.\/upload$/ }, () => ({ path: 'upload', namespace: 'provider-stub' }))
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

	console.log('SV NewAPI error response checks passed.')
} finally {
	await rm(tempDir, { recursive: true, force: true })
}

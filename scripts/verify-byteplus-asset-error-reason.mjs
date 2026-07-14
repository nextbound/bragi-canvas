import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const tempDir = await mkdtemp(path.join(tmpdir(), 'bragi-byteplus-asset-error-'))
const entry = path.join(tempDir, 'entry.ts')
const outfile = path.join(tempDir, 'byteplus-asset-error.mjs')

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
		build.onResolve({ filter: /^\.\/volcengine-sig$/ }, () => ({ path: 'volcengine-sig', namespace: 'provider-stub' }))
		build.onResolve({ filter: /^\.\/providers\/upload$/ }, () => ({ path: 'upload', namespace: 'provider-stub' }))
		build.onLoad({ filter: /^volcengine-sig$/, namespace: 'provider-stub' }, () => ({
			loader: 'js',
			contents: 'export const signVolcRequest = async () => ({ url: "https://byteplus.test", method: "POST", headers: {}, body: "{}" });',
		}))
		build.onLoad({ filter: /^upload$/, namespace: 'provider-stub' }, () => ({
			loader: 'js',
			contents: 'export const uploadRef = async () => "https://refs.test/ref.png";',
		}))
	},
}

try {
	await writeFile(entry, `
		import { waitForActive as waitForBytePlusActive } from '${path.resolve('src/providers/byteplus-assets.ts').replaceAll('\\', '\\\\')}'
		import { ensureSvNewApiAsset } from '${path.resolve('src/svnewapi-asset-flow.ts').replaceAll('\\', '\\\\')}'

		export async function runBytePlusWait() {
			globalThis.__bragiRequestUrl = async () => ({
				status: 200,
				json: {
					Result: {
						Status: 'Failed',
						Error: {
							Code: 'ModerationFailed',
							Message: 'reference image contains an unsupported face',
						},
					},
				},
				text: '',
			})
			await waitForBytePlusActive({ accessKey: 'ak', secretKey: 'sk', groupId: 'group' }, 'asset-1')
		}

		export async function runSvNewApiAssetFlow() {
			let call = 0
			globalThis.__bragiRequestUrl = async ({ url }) => {
				call += 1
				if (url.endsWith('/v1/assets')) {
					return { status: 200, json: { id: 'asset-1', status: 'Processing' }, text: '' }
				}
				return {
					status: 200,
					json: {
						status: 'Failed',
						Result: {
							Error: {
								Code: 'ModerationFailed',
								Message: 'gateway saw BytePlus moderation failure',
							},
						},
					},
					text: '',
				}
			}
			const plugin = {
				app: {
					vault: {
						adapter: {
							readBinary: async () => new ArrayBuffer(1),
						},
					},
				},
			}
			const canvas = { nodes: new Map() }
			await ensureSvNewApiAsset(plugin, canvas, 'refs/face.png', 'seedance', { baseUrl: 'https://gateway.test', apiKey: 'key' })
			if (call !== 2) throw new Error('expected create + status calls')
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

	await assert.rejects(
		mod.runBytePlusWait(),
		/reference image contains an unsupported face/,
		'BytePlus terminal failure should include Result.Error.Message',
	)

	await assert.rejects(
		mod.runSvNewApiAssetFlow(),
		/gateway saw BytePlus moderation failure/,
		'SV NewAPI asset status failures should include nested Result.Error.Message when present',
	)

	console.log('BytePlus asset error reason checks passed.')
} finally {
	await rm(tempDir, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const tempDir = await mkdtemp(path.join(tmpdir(), 'bragi-legnext-image-result-'))
const entry = path.join(tempDir, 'entry.ts')
const outfile = path.join(tempDir, 'legnext-image-result.mjs')

const obsidianStub = {
	name: 'obsidian-stub',
	setup(build) {
		build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'obsidian-stub' }))
		build.onLoad({ filter: /.*/, namespace: 'obsidian-stub' }, () => ({
			loader: 'js',
			contents: 'export const requestUrl = () => { throw new Error("requestUrl should not be called"); };',
		}))
	},
}

try {
	await writeFile(entry, `
		export { selectLegnextImageUrl } from ${JSON.stringify(path.resolve('src/providers/legnext.ts'))}
	`)

	await esbuild.build({
		entryPoints: [entry],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile,
		logLevel: 'silent',
		plugins: [obsidianStub],
	})

	const { selectLegnextImageUrl } = await import(pathToFileURL(outfile).href)

	assert.equal(
		selectLegnextImageUrl({
			image_url: 'https://cdn.legnext.ai/grid.png',
			image_urls: [
				'https://cdn.legnext.ai/image-0.png',
				'https://cdn.legnext.ai/image-1.png',
			],
		}),
		'https://cdn.legnext.ai/image-0.png',
		'Legnext must prefer the first individual image over the four-image grid.',
	)

	assert.equal(
		selectLegnextImageUrl({ image_url: 'https://cdn.legnext.ai/grid.png' }),
		'https://cdn.legnext.ai/grid.png',
		'Legnext must keep the composite image as a backward-compatible fallback.',
	)

	assert.equal(
		selectLegnextImageUrl({ image_urls: ['', 'https://cdn.legnext.ai/image-1.png'] }),
		'https://cdn.legnext.ai/image-1.png',
		'Legnext must ignore empty individual image URLs.',
	)

	assert.equal(
		selectLegnextImageUrl({ image_url: '', image_urls: [] }),
		undefined,
		'Legnext must reject empty image results.',
	)

	console.log('Legnext image result checks passed.')
} finally {
	await rm(tempDir, { recursive: true, force: true })
}

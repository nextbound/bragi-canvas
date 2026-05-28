import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const tempDir = await mkdtemp(path.join(tmpdir(), 'bragi-update-check-'))
const outfile = path.join(tempDir, 'update-check-core.mjs')

try {
	await esbuild.build({
		entryPoints: ['src/update-check-core.ts'],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile,
		logLevel: 'silent',
	})

	const core = await import(pathToFileURL(outfile).href)
	const now = 1_700_000_000_000

	assert.equal(core.normalizeVersion('v1.17.0'), '1.17.0')
	assert.equal(core.compareVersions('1.17.0', '1.16.0'), 1)
	assert.equal(core.isNewerVersion('v1.17.0', '1.16.0'), true)
	assert.equal(core.isNewerVersion('1.16.0', '1.16.0'), false)

	assert.equal(core.shouldUseCachedRelease({
		lastCheckedAt: now - 1000,
		latestVersion: '1.17.0',
		latestReleaseUrl: 'https://example.test/release',
	}, now), true)
	assert.equal(core.shouldUseCachedRelease({
		lastCheckedAt: now - core.UPDATE_CHECK_TTL_MS - 1,
		latestVersion: '1.17.0',
		latestReleaseUrl: 'https://example.test/release',
	}, now), false)

	assert.equal(core.shouldShowAutomaticUpdatePrompt({
		lastPromptedVersion: '1.17.0',
		lastPromptedAt: now - 1000,
	}, '1.17.0', now), false)
	assert.equal(core.shouldShowAutomaticUpdatePrompt({
		lastPromptedVersion: '1.17.0',
		lastPromptedAt: now - core.UPDATE_PROMPT_SUPPRESSION_MS - 1,
	}, '1.17.0', now), true)
	assert.equal(core.shouldShowAutomaticUpdatePrompt({
		lastPromptedVersion: '1.17.0',
		lastPromptedAt: now - 1000,
	}, '1.18.0', now), true)

	const state = {}
	core.markUpdatePrompted(state, '1.17.0', now)
	assert.deepEqual(state, { lastPromptedVersion: '1.17.0', lastPromptedAt: now })

	console.log('update-check logic ok')
} finally {
	await rm(tempDir, { recursive: true, force: true })
}

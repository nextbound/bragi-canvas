// Static, no-network catalog check. Bundles the model catalog + provider
// registry with esbuild (aliasing `obsidian` to a stub) and runs
// validateCatalog so any agent adding a model/provider stays compliant.
import esbuild from 'esbuild'
import path from 'path'
import os from 'os'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { pathToFileURL, fileURLToPath } from 'url'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))

// Relative imports (resolved from scriptsDir) so an absolute path containing
// special characters (e.g. an apostrophe in the directory name) can't break
// the generated entry module.
const entry = `
import { ALL_MODELS } from '../src/models/index.ts'
import { PROVIDERS } from '../src/providers/registry.ts'
import { validateCatalog } from '../src/models/validate-catalog.ts'
export const errors = validateCatalog(ALL_MODELS, PROVIDERS.map(p => ({ id: p.id, defaultRefDelivery: p.defaultRefDelivery })))
export const modelCount = ALL_MODELS.length
`

const result = await esbuild.build({
	stdin: { contents: entry, resolveDir: scriptsDir, sourcefile: 'check-catalog-entry.ts', loader: 'ts' },
	bundle: true,
	format: 'esm',
	platform: 'node',
	write: false,
	logLevel: 'silent',
	alias: { obsidian: path.resolve(scriptsDir, 'obsidian-stub.mjs') },
})

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bragi-catalog-'))
const tmpFile = path.join(tmpDir, 'catalog.mjs')
writeFileSync(tmpFile, result.outputFiles[0].text)

try {
	const { errors, modelCount } = await import(pathToFileURL(tmpFile).href)
	if (errors.length > 0) {
		console.error(`Catalog check FAILED (${errors.length} issue${errors.length === 1 ? '' : 's'}):`)
		for (const err of errors) console.error(`  - ${err}`)
		process.exit(1)
	}
	console.log(`Catalog check passed: ${modelCount} models valid.`)
} finally {
	rmSync(tmpDir, { recursive: true, force: true })
}

// Extensibility audit: headlessly exercises the SAME logic the canvas panel and
// MCP server use (provider-effective modes, per-provider param overrides/hidden,
// mode-filtered params, modality capability, voice-mode routing) for every
// model x provider x mode in the catalog. This is the closest thing to "running
// it on the canvas" without the Obsidian GUI: it runs the real code paths and
// reports any combination that would render an invalid/empty/inconsistent UI.
import esbuild from 'esbuild'
import path from 'path'
import os from 'os'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { pathToFileURL, fileURLToPath } from 'url'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))

const entry = `
import { ALL_MODELS, getProviderModes, isAggregated } from '../src/models/index.ts'
import { PROVIDERS, getProvider } from '../src/providers/registry.ts'
import { getRefDelivery } from '../src/provider-model-prefs.ts'

const REF_MODALITY_FOR_TYPE = { image: ['image'], video: ['image', 'video', 'audio'], text: ['image', 'video', 'audio', 'pdf'], audio: ['audio'] }

// Mirrors panel.ts / mcp-tool-registry.ts exactly.
function applyProviderOverride(param, provider) {
	const o = provider ? param.providerOverrides?.[provider] : undefined
	return o ? { ...param, ...o } : param
}
function paramVisibleForMode(param, mode) {
	return !param.modes || (!!mode && param.modes.includes(mode))
}
function paramHiddenForProvider(param, provider) {
	return !!(provider && param.providerOverrides?.[provider]?.hidden)
}

const MAKER_FOR_TYPE = { image: 'makeImage', video: 'makeVideo', text: 'makeText', audio: 'makeAudio' }

const anomalies = []
const rows = []
let modeCombos = 0

for (const model of ALL_MODELS) {
	for (const providerId of Object.keys(model.supportedProviders)) {
		const cfg = model.supportedProviders[providerId]
		const spec = getProvider(providerId)
		const modes = getProviderModes(model, providerId)
		const editable = !cfg.aggregated && cfg.editableApiModelId === true

		// 1. Provider must exist and be able to run this modality.
		if (!spec) {
			anomalies.push(\`\${model.id} / \${providerId}: provider not in registry\`)
		} else {
			const maker = MAKER_FOR_TYPE[model.type]
			if (!spec[maker]) anomalies.push(\`\${model.id} / \${providerId}: provider has no \${maker} for type "\${model.type}"\`)
		}

		// 2. Provider must expose at least one mode.
		if (modes.length === 0) {
			anomalies.push(\`\${model.id} / \${providerId}: exposes zero modes (modes subset disjoint from model.modes)\`)
		}

		// 3. Aggregated + editable is contradictory.
		if (cfg.aggregated && editable) {
			anomalies.push(\`\${model.id} / \${providerId}: aggregated and editableApiModelId both set\`)
		}

		// 4. For each effective mode, the rendered param UI must be valid.
		const effModes = modes.length ? modes : [null]
		for (const mode of effModes) {
			modeCombos++
			const visible = model.params
				.filter(p => paramVisibleForMode(p, mode) && !paramHiddenForProvider(p, providerId))
				.map(p => applyProviderOverride(p, providerId))
			for (const p of visible) {
				if (p.type === 'select') {
					const opts = (mode && p.optionsByMode?.[mode]) || p.options
					if (!opts || opts.length === 0) {
						if (p.id !== 'voice') anomalies.push(\`\${model.id} / \${providerId} / \${mode} / param "\${p.id}": select has no options\`)
						continue
					}
					if (!opts.some(o => String(o.value) === String(p.default))) {
						anomalies.push(\`\${model.id} / \${providerId} / \${mode} / param "\${p.id}": default "\${p.default}" not in options [\${opts.map(o => o.value).join(', ')}]\`)
					}
				} else if (p.type === 'range' || p.type === 'number') {
					if (p.min !== undefined && p.max !== undefined && p.min > p.max) {
						anomalies.push(\`\${model.id} / \${providerId} / \${mode} / param "\${p.id}": min \${p.min} > max \${p.max}\`)
					}
					const d = Number(p.default)
					if (p.min !== undefined && d < p.min) anomalies.push(\`\${model.id} / \${providerId} / \${mode} / param "\${p.id}": default \${d} < min \${p.min}\`)
					if (p.max !== undefined && d > p.max) anomalies.push(\`\${model.id} / \${providerId} / \${mode} / param "\${p.id}": default \${d} > max \${p.max}\`)
				}
			}
		}

		// 5. Audio voice-mode routing: declared modelIds must be non-empty.
		if (model.type === 'audio' && model.voiceConfig?.modelIds) {
			for (const [vmode, id] of Object.entries(model.voiceConfig.modelIds)) {
				if (!id || !String(id).trim()) anomalies.push(\`\${model.id} / \${providerId}: voiceConfig.modelIds.\${vmode} is empty\`)
			}
		}

		const delivery = (REF_MODALITY_FOR_TYPE[model.type] || [])
			.map(m => \`\${m}:\${getRefDelivery(model, providerId, m).delivery}\`)
			.join(' ')

		rows.push({
			model: model.id,
			type: model.type,
			provider: providerId,
			apiModelId: cfg.apiModelId,
			aggregated: !!cfg.aggregated,
			editable,
			modes: modes.join('|') || '(none)',
			delivery,
		})
	}
}

export const report = {
	models: ALL_MODELS.length,
	providers: PROVIDERS.length,
	pairs: rows.length,
	modeCombos,
	anomalies,
	rows,
}
`

const result = await esbuild.build({
	stdin: { contents: entry, resolveDir: scriptsDir, sourcefile: 'audit-catalog-entry.ts', loader: 'ts' },
	bundle: true,
	format: 'esm',
	platform: 'node',
	write: false,
	logLevel: 'silent',
	alias: { obsidian: path.resolve(scriptsDir, 'obsidian-stub.mjs') },
})

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'bragi-audit-'))
const tmpFile = path.join(tmpDir, 'audit.mjs')
writeFileSync(tmpFile, result.outputFiles[0].text)

try {
	const { report } = await import(pathToFileURL(tmpFile).href)
	console.log(`Catalog extensibility audit`)
	console.log(`  models: ${report.models}, providers: ${report.providers}`)
	console.log(`  model x provider pairs: ${report.pairs}`)
	console.log(`  model x provider x mode combinations exercised: ${report.modeCombos}`)
	console.log('')

	// Group rows by model for a readable matrix.
	const byModel = new Map()
	for (const r of report.rows) {
		if (!byModel.has(r.model)) byModel.set(r.model, [])
		byModel.get(r.model).push(r)
	}
	for (const [model, rs] of byModel) {
		console.log(`${model} [${rs[0].type}]`)
		for (const r of rs) {
			const flags = [r.aggregated ? 'aggregated' : null, r.editable ? 'editable-id' : 'locked-id'].filter(Boolean).join(', ')
			console.log(`    ${r.provider.padEnd(14)} id=${r.apiModelId.padEnd(34)} modes=${r.modes}  (${flags})`)
			console.log(`    ${' '.repeat(14)} delivery: ${r.delivery}`)
		}
	}

	console.log('')
	if (report.anomalies.length === 0) {
		console.log(`AUDIT PASSED: ${report.modeCombos} combinations, no anomalies.`)
	} else {
		console.log(`AUDIT found ${report.anomalies.length} anomal${report.anomalies.length === 1 ? 'y' : 'ies'}:`)
		for (const a of report.anomalies) console.log(`  - ${a}`)
		process.exitCode = 1
	}
} finally {
	rmSync(tmpDir, { recursive: true, force: true })
}

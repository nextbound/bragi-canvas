import assert from 'node:assert/strict'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const [action, vaultArgument, evidenceArgument, configDirectory] = process.argv.slice(2)
if (!['prepare', 'run'].includes(action) || !vaultArgument || !evidenceArgument) {
	throw new Error('Usage: node scripts/verify-breezeblue-live.mjs prepare|run VAULT EVIDENCE_DIR [CONFIG_DIR]')
}
const vault = resolve(vaultArgument)
const evidence = resolve(evidenceArgument)
const modelId = 'breeze-tts-2-multilingual'
const port = 17779

async function rpc(name, args = {}) {
	const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
	})
	assert.equal(response.status, 200)
	const body = await response.json()
	if (body.error || body.result?.isError) throw new Error(`MCP ${name} failed`)
	return JSON.parse(body.result.content[0].text)
}

if (action === 'prepare') {
	assert.ok(configDirectory, 'Pass the configuration directory name for the isolated fixture vault')
	const entries = await readdir(vault).catch(error => { if (error.code === 'ENOENT') return []; throw error })
	const markerPath = join(vault, 'breezeblue-qa-fixture.json')
	if (entries.length) {
		const marker = await readFile(markerPath, 'utf8').then(JSON.parse).catch(() => null)
		assert.equal(marker?.kind, 'bragi-breezeblue-qa', 'Preparation must not overwrite an existing user vault')
	}
	const input = createInterface({ input: process.stdin, output: process.stdout, terminal: false })
	const apiKey = (await input.question('API key (input must be hidden by the caller): ')).trim()
	input.close()
	assert.ok(apiKey)
	const response = await fetch('https://api.breeze.blue/v1/models', { headers: { 'xi-api-key': apiKey } })
	assert.equal(response.status, 200, 'The supplied key must authenticate the models request')
	const models = await response.json()
	const chosen = models.find(model => (model.model_id || model.id) === modelId)
	assert.ok(chosen, 'The requested multilingual model must be available to this account')
	const pluginDir = join(vault, configDirectory, 'plugins/bragi-canvas')
	await mkdir(pluginDir, { recursive: true })
	await mkdir(evidence, { recursive: true })
	await writeFile(markerPath, JSON.stringify({ kind: 'bragi-breezeblue-qa' }) + '\n')
	for (const file of ['main.js', 'styles.css', 'manifest.json']) await copyFile(resolve(file), join(pluginDir, file))
	await writeFile(join(vault, configDirectory, 'community-plugins.json'), JSON.stringify(['bragi-canvas']))
	await writeFile(join(vault, configDirectory, 'core-plugins.json'), JSON.stringify(['canvas', 'file-explorer', 'switcher', 'command-palette']))
	await writeFile(join(pluginDir, 'data.json'), JSON.stringify({
		providers: { breezeblue: apiKey },
		modelPrefs: { [modelId]: { enabled: true, selectedProvider: 'breezeblue' } },
		providerModelPrefs: { breezeblue: { [modelId]: true } },
		mcpEnabled: true, mcpPort: port, outputDir: '_bragi/assets',
	}, null, 2))
	await writeFile(join(vault, 'BreezeBlue Voice Design QA.canvas'), JSON.stringify({ nodes: [], edges: [] }))
	await writeFile(join(evidence, 'live-account.json'), JSON.stringify({ authenticated: true, selectedModel: modelId, languages: chosen.languages?.map(language => language.language_id) || [] }, null, 2) + '\n')
	console.log('\nAuthentication and model availability passed. Isolated test vault prepared; the key is only in its runtime settings.')
} else {
	const cases = JSON.parse(await readFile(join(vault, 'live-cases.json'), 'utf8'))
	const active = await rpc('get_active_canvas_info')
	assert.equal(active.path, 'BreezeBlue Voice Design QA.canvas')
	const model = (await rpc('list_models', { type: 'audio' })).find(value => value.id === modelId)
	assert.deepEqual(model.voiceSources, ['design'])
	assert.equal(model.voiceDesignOutput, 'audio-previews')
	assert.deepEqual(model.params.find(param => param.id === 'preview_count').options.map(option => option.value), ['1', '2', '3'])
	const results = []
	for (const [index, test] of cases.entries()) {
		const y = index * 760
		await rpc('create_group_node', { label: test.name, x: -30, y: y - 60, width: 1440, height: 730 })
		const description = await rpc('create_text_node', { text: test.description, x: 0, y, width: 320, height: 200 })
		const script = await rpc('create_text_node', { text: test.text, x: 400, y, width: 320, height: 200 })
		await rpc('connect_nodes', { fromId: description.id, toId: script.id })
		const params = test.useDefault ? {} : { preview_count: test.count }
		const startedAt = Date.now()
		const started = await rpc('generate', { nodeId: script.id, modelId, mode: 'tts', params, batchCount: 1 })
		assert.equal(started.placeholderIds.length, 1)
		let outputs
		for (let poll = 0; poll < 180; poll++) {
			await delay(3000)
			const nodes = await rpc('list_nodes')
			const pending = nodes.find(node => node.id === started.placeholderIds[0])
			if (pending?.bragiError || pending?.bragiFailed || pending?.color === '1') throw new Error(`${test.name} failed; inspect the test canvas`)
			if (pending) continue
			const edges = await rpc('list_edges')
			const outputIds = edges.filter(edge => edge.fromNode === script.id).map(edge => edge.toNode)
			outputs = nodes.filter(node => outputIds.includes(node.id) && node.type === 'file')
			if (outputs.length === test.count) break
		}
		assert.equal(outputs?.length, test.count, `${test.name} must create every requested candidate`)
		const audio = []
		for (const node of outputs) {
			const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,sample_rate,channels', '-of', 'json', join(vault, node.file)], { encoding: 'utf8' }))
			assert.ok(Number(probe.format.duration) > 0.2)
			assert.ok(Number(probe.format.size) > 1000)
			execFileSync('ffmpeg', ['-v', 'error', '-i', join(vault, node.file), '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] })
			audio.push({ file: node.file, duration: Number(probe.format.duration), bytes: Number(probe.format.size), ...probe.streams[0] })
		}
		const videoPrompt = await rpc('create_text_node', { text: 'A person speaks naturally with the connected audio as the voice reference.', x: 1500, y, width: 320, height: 200 })
		await rpc('connect_nodes', { fromId: outputs[0].id, toId: videoPrompt.id })
		const upstream = await rpc('get_upstream', { id: videoPrompt.id })
		assert.ok(upstream.audios.includes(outputs[0].file), 'The generated candidate must be recognized as an upstream audio reference')
		results.push({ name: test.name, language: test.language, requestedCandidates: test.count, returnedCandidates: outputs.length, usedDefault: !!test.useDefault, elapsedSeconds: (Date.now() - startedAt) / 1000, audio, downstreamAudioReference: true })
		await writeFile(join(evidence, 'live-results.json'), JSON.stringify(results, null, 2) + '\n')
		console.log(`${test.name}: ${outputs.length} valid playable audio file(s); downstream audio reference passed.`)
	}
	assert.equal((await rpc('list_pending_tasks')).length, 0)
	console.log(`Live canvas verification passed: ${results.length} cases, ${results.reduce((sum, item) => sum + item.returnedCandidates, 0)} audio candidates.`)
}

import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

// Dedicated synthetic QA vault only. Each named case is submitted at most once.
const [vaultArg, evidenceArg, portArg = '17782'] = process.argv.slice(2)
assert.ok(vaultArg && evidenceArg, 'Usage: node scripts/verify-kling4-live.mjs QA_VAULT EVIDENCE_DIR [PORT]')
const vault = resolve(vaultArg), evidence = resolve(evidenceArg)
await mkdir(evidence, { recursive: true })
const file = join(evidence, 'live-results.json')
const results = await readFile(file, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return []; throw error })
const redact = value => String(value).replace(/https?:\/\/[^\s"<>]+/g, '[redacted URL]').slice(0, 1200)
const save = () => writeFile(file, JSON.stringify(results, null, 2) + '\n')
async function rpc(name, args = {}) {
	const response = await fetch(`http://127.0.0.1:${Number(portArg)}/mcp`, {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(30000),
	})
	assert.equal(response.status, 200)
	const body = await response.json()
	if (body.error || body.result?.isError) throw new Error(redact(body.error?.message || body.result?.content?.[0]?.text))
	return JSON.parse(body.result.content[0].text)
}
assert.equal((await rpc('get_active_canvas_info')).path, 'Kling 4.0 QA.canvas')
const model = (await rpc('list_models', { type: 'video' })).find(m => m.id === 'kling-4.0')
assert.ok(model?.modes.includes('keyframes'))
const frames = (...entries) => `[Keyframes]\n${entries.join('\n')}\n[/Keyframes]\nA smooth continuous tracking shot of a blue toy car moving to the right, soft daylight.`
const cases = [
	{ name: 'text-720p', mode: 'text-to-video', prompt: 'A small blue toy car moves slowly across a green tabletop. Static camera, soft daylight, gentle stereo background sound.' },
	{ name: 'first-frame-no-prompt', mode: 'first-frame', prompt: '', images: [1] },
	{ name: 'first-last-no-prompt', mode: 'first-last-frame', prompt: '', images: [1, 4] },
	{ name: 'keyframes-with-last', mode: 'keyframes', images: [1, 2, 3, 4], prompt: frames('@Image1: Car on the left.', '@Image2: Car moves to the center.', '@Image3: Car moves right.', '[@Image4]: Car reaches the right side.') },
	{ name: 'keyframes-open-ending', mode: 'keyframes', images: [1, 2, 3], prompt: frames('@Image1: Car on the left.', '@Image2: Car moves to the center.', '@Image3: Car moves right.') },
	{ name: 'single-image-reference', mode: 'image-ref', images: [1], prompt: 'Use @Image1 as a reference for the blue toy car and green tabletop. Show a gentle cinematic orbit around the toy.' },
	{ name: 'multimodal-reference', mode: 'video-ref', images: [1], video: true, audio: true, prompt: 'Use the blue car in @Image1, the scene in @Video1 and the soft tone in @Audio1. The toy car moves gently to the right.', params: { audio_setting: 'auto' } },
	{ name: 'audio-only-reference', mode: 'video-ref', audio: true, prompt: 'A small blue toy car rolls across a green tabletop. Use @Audio1 as the musical reference.' },
	{ name: 'edit-source-length-keep-audio', mode: 'video-edit', video: true, images: [1], prompt: 'Replace the background with a light beige tabletop while preserving the blue toy car from @Image1.', params: { edit_duration: 'source', audio_setting: 'origin' } },
	{ name: 'edit-1080p-regenerate-audio', mode: 'video-edit', video: true, prompt: 'Change the tabletop to light beige and add a soft bell sound as the camera gently moves.', params: { edit_duration: '4', audio_setting: 'auto', resolution: '1080p', aspect_ratio: '9:16' }, expectedDuration: 4 },
	{ name: 'extend-open-ending', mode: 'video-extend', video: true, prompt: 'Continue the video: the blue toy car gently rolls to the right across the green tabletop.', expectedDuration: 6 },
	{ name: 'extend-target-last-frame', mode: 'video-extend', video: true, images: [4], prompt: 'Extend the video smoothly until the blue toy car reaches the position in the target ending frame.', expectedDuration: 6 },
]

async function submit(test, index) {
	const node = await rpc('create_text_node', { text: test.prompt, x: 500, y: index * 650, width: 400, height: 260 })
	for (const [i, number] of (test.images || []).entries()) {
		const image = await rpc('create_file_node', { filePath: `refs/frame-${number}.png`, x: -400 + i * 220, y: index * 650 - 180, width: 200, height: 113 })
		await rpc('connect_nodes', { fromId: image.id, toId: node.id })
	}
	for (const [kind, path] of [['video', 'refs/source.mp4'], ['audio', 'refs/chime.mp3']]) {
		if (!test[kind]) continue
		const ref = await rpc('create_file_node', { filePath: path, x: 0, y: index * 650 + (kind === 'audio' ? 200 : 0), width: 320, height: 180 })
		await rpc('connect_nodes', { fromId: ref.id, toId: node.id })
	}
	const result = { name: test.name, mode: test.mode, sourceNodeId: node.id, startedAt: new Date().toISOString(), status: 'submission-starting', params: { duration: 3, resolution: '720p', ...test.params }, expectedDuration: test.expectedDuration || 3 }
	results.push(result); await save()
	try {
		const started = await rpc('generate', { nodeId: node.id, modelId: model.id, mode: test.mode, params: result.params })
		assert.equal(started.placeholderIds.length, 1)
		result.placeholderId = started.placeholderIds[0]; result.status = 'pending'
	} catch (error) { result.status = 'submission-error'; result.error = redact(error.message) }
	await save(); console.log(`${result.name}: ${result.status}`)
}

async function inspectPending() {
	const nodes = await rpc('list_nodes'), edges = await rpc('list_edges'), tasks = await rpc('list_pending_tasks')
	const rawCanvas = JSON.parse(await readFile(join(vault, 'Kling 4.0 QA.canvas'), 'utf8'))
	for (const result of results.filter(r => r.status === 'pending')) {
		const placeholder = nodes.find(n => n.id === result.placeholderId)
		const output = edges.filter(e => e.fromNode === result.sourceNodeId).map(e => nodes.find(n => n.id === e.toNode)).find(n => n?.type === 'file')
		if (output) {
			try {
				const path = join(vault, output.file)
				const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,codec_type,width,height,channels', '-of', 'json', path], { encoding: 'utf8' }))
				execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] })
				const videoStream = probe.streams.find(s => s.codec_type === 'video')
				assert.ok(videoStream)
				assert.equal(Math.min(videoStream.width, videoStream.height), Number.parseInt(result.params.resolution))
				assert.ok(Math.abs(Number(probe.format.duration) - result.expectedDuration) < 0.3, 'Output duration must match the workflow')
				assert.equal(probe.streams.find(s => s.codec_type === 'audio')?.channels, 2, 'Every Kling 4 output must include stereo audio')
				result.status = 'passed'; result.file = output.file; result.probe = probe
				result.elapsedSeconds = (Date.now() - Date.parse(result.startedAt)) / 1000
				console.log(`${result.name}: passed, downloaded and decoded video + stereo audio`)
			} catch (error) { result.status = 'output-check-failed'; result.error = redact(error.message); console.log(`${result.name}: ${result.error}`) }
		} else if (placeholder?.color === '1' || rawCanvas.nodes.find(n => n.id === result.placeholderId)?.bragiGenerationFailed) {
			result.status = 'failed'; result.error = redact(rawCanvas.nodes.find(n => n.id === result.placeholderId)?.bragiGenError || placeholder.text); console.log(`${result.name}: ${result.error}`)
		} else {
			const task = tasks.find(t => t.placeholderNodeId === result.placeholderId)
			if (task?.state === 'needs-attention') { result.status = 'needs-attention'; result.error = redact(task.lastError); console.log(`${result.name}: needs attention`) }
		}
	}
	await save()
}

for (let tick = 0; tick < 360; tick++) {
	if (results.some(r => r.status === 'pending')) await inspectPending()
	const remaining = cases.filter(test => !results.some(r => r.name === test.name))
	if (!remaining.length && !results.some(r => r.status === 'pending')) break
	const slots = 3 - results.filter(r => r.status === 'pending').length
	for (const test of remaining.slice(0, slots)) await submit(test, cases.indexOf(test))
	if (tick % 6 === 0) console.log(`Progress: ${results.filter(r => r.status === 'passed').length}/${cases.length} passed; ${results.filter(r => r.status === 'pending').length} pending`)
	await delay(10000)
}
console.log(`Live results: ${results.map(r => `${r.name}=${r.status}`).join(', ')}`)
if (results.length !== cases.length || results.some(r => r.status !== 'passed')) process.exitCode = 1

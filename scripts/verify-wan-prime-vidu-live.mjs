import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

// Run only against a dedicated QA vault with the candidate build and synthetic fixtures.
// This script submits three billable tasks once; it never retries generation.
const [vaultArg, evidenceArg, portArg = '17781'] = process.argv.slice(2)
assert.ok(vaultArg && evidenceArg, 'Usage: node scripts/verify-wan-prime-vidu-live.mjs QA_VAULT EVIDENCE_DIR [PORT]')
const vault = resolve(vaultArg), evidence = resolve(evidenceArg)
const evidenceFile = join(evidence, 'live-results.json')
const results = await readFile(evidenceFile, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return []; throw error })
const redact = value => String(value).replace(/https?:\/\/[^\s"<>]+/g, '[redacted URL]').slice(0, 1000)
async function rpc(name, args = {}) {
 const response = await fetch(`http://127.0.0.1:${Number(portArg)}/mcp`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
  signal: AbortSignal.timeout(30000),
 })
 assert.equal(response.status, 200)
 const body = await response.json()
 if (body.error || body.result?.isError) throw new Error(redact(body.error?.message || body.result?.content?.[0]?.text))
 return JSON.parse(body.result.content[0].text)
}
const active = await rpc('get_active_canvas_info')
assert.equal(active.path, 'Wan Prime and Vidu QA.canvas')
if (!results.length) assert.equal(active.nodeCount, 0, 'Use a fresh QA canvas')
const models = await rpc('list_models', { type: 'video' })
const wan = models.find(m => m.id === 'wan-3.0'), vidu = models.find(m => m.id === 'vidu-q4-preview')
assert.ok(wan?.params.find(p => p.id === 'variant')?.options.some(o => o.value === 'prime'))
assert.deepEqual(vidu?.modes, ['first-frame', 'image-ref'])
const cases = [
 { name: 'wan-prime-text', modelId: wan.id, mode: 'text-to-video', prompt: 'A small blue toy car rolls slowly across a green tabletop, static camera, soft daylight.', params: { variant: 'prime', duration: 2, resolution: '480P', audio: 'false', ratio: '16:9' } },
 { name: 'vidu-empty-first-frame', modelId: vidu.id, mode: 'first-frame', prompt: '', image: true, params: { duration: 3, resolution: '540p', audio: 'false' } },
 { name: 'vidu-single-reference-audio', modelId: vidu.id, mode: 'image-ref', prompt: 'A blue toy car like the reference rolls slowly across the green ground. Use the connected sound as a soft chime. Static camera.', image: true, audio: true, params: { duration: 3, resolution: '720p', audio: 'true', aspect_ratio: '16:9' } },
]
const save = () => writeFile(evidenceFile, JSON.stringify(results, null, 2) + '\n')
for (const [i, test] of cases.entries()) {
 if (results.some(r => r.name === test.name)) continue
 const y = i * 520
 const node = await rpc('create_text_node', { text: test.prompt, x: 400, y, width: 340, height: 190 })
 if (test.image) {
  const image = await rpc('create_file_node', { filePath: 'refs/toy-car.png', x: 0, y, width: 320, height: 180 })
  await rpc('connect_nodes', { fromId: image.id, toId: node.id })
 }
 if (test.audio) {
  const audio = await rpc('create_file_node', { filePath: 'refs/chime.mp3', x: 0, y: y + 220, width: 320, height: 110 })
  await rpc('connect_nodes', { fromId: audio.id, toId: node.id })
 }
 const result = { name: test.name, modelId: test.modelId, mode: test.mode, params: test.params, sourceNodeId: node.id, startedAt: new Date().toISOString(), status: 'submission-starting' }
 results.push(result); await save()
 try {
  const started = await rpc('generate', { nodeId: node.id, modelId: test.modelId, mode: test.mode, params: test.params })
  assert.equal(started.placeholderIds.length, 1)
  result.placeholderId = started.placeholderIds[0]; result.status = 'pending'
 } catch (error) { result.status = 'submission-error'; result.error = redact(error.message) }
 await save(); console.log(`${result.name}: ${result.status}`)
}
for (let poll = 0; poll < 90 && results.some(r => r.status === 'pending'); poll++) {
 await delay(10000)
 const nodes = await rpc('list_nodes'), edges = await rpc('list_edges'), tasks = await rpc('list_pending_tasks')
 for (const result of results.filter(r => r.status === 'pending')) {
  const placeholder = nodes.find(n => n.id === result.placeholderId)
  const outputs = edges.filter(e => e.fromNode === result.sourceNodeId).map(e => nodes.find(n => n.id === e.toNode)).filter(n => n?.type === 'file')
  if (outputs.length) {
   const output = outputs[0]
   const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_name,codec_type,width,height', '-of', 'json', join(vault, output.file)], { encoding: 'utf8' }))
   execFileSync('ffmpeg', ['-v', 'error', '-i', join(vault, output.file), '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] })
   assert.ok(Math.abs(Number(probe.format.duration) - result.params.duration) < 0.2, 'Output duration must match the requested short clip')
   assert.equal(probe.streams.find(s => s.codec_type === 'video')?.height, Number.parseInt(result.params.resolution), 'Output resolution must match the request')
   assert.equal(probe.streams.some(s => s.codec_type === 'audio'), result.params.audio === 'true', 'Audio on/off must match the request')
   result.status = 'passed'; result.file = output.file; result.probe = probe
   result.elapsedSeconds = (Date.now() - Date.parse(result.startedAt)) / 1000
   console.log(`${result.name}: passed; playable downloaded MP4`)
  } else if (placeholder?.color === '1') {
   result.status = 'failed'; result.error = redact(placeholder.text)
   console.log(`${result.name}: failed; ${result.error}`)
  } else {
   const task = tasks.find(t => t.placeholderNodeId === result.placeholderId)
   if (task?.state === 'needs-attention') { result.status = 'needs-attention'; result.error = redact(task.lastError) }
  }
 }
 await save()
 if (poll % 6 === 5 && results.some(r => r.status === 'pending')) console.log(`Waiting: ${results.filter(r => r.status === 'pending').map(r => r.name).join(', ')}`)
}
for (const r of results.filter(r => r.status === 'pending')) r.status = 'pending-after-timeout'
await save()
console.log(`Live results: ${results.map(r => `${r.name}=${r.status}`).join(', ')}`)
if (results.some(r => r.status !== 'passed')) process.exitCode = 1

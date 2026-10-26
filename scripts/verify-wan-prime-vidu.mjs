import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { testRuntime } from './test-runtime.mjs'

const runtime = await testRuntime(`
export { APIMartProvider } from './src/providers/apimart';
export { DashScopeVideoProvider } from './src/providers/dashscope';
export { buildApimartViduRequest } from './src/providers/apimart-vidu-payload';
export { resolveWan30ApiModelId } from './src/providers/wan30-variant';
export { allowsEmptyPrompt } from './src/generation-prompt';
export { createMcpToolRegistry } from './src/mcp-tool-registry';
export { ALL_MODELS } from './src/models';
`)
try {
 const { APIMartProvider, DashScopeVideoProvider, buildApimartViduRequest: build, resolveWan30ApiModelId, allowsEmptyPrompt, createMcpToolRegistry, ALL_MODELS } = runtime.module
 const image = 'https://temp.bragi.now/test-image.png', audio = 'https://temp.bragi.now/test-audio.mp3'
 const first = { genMode: 'first-frame', refImages: [image] }
 const ref = { genMode: 'image-ref', refImages: [image], refAudios: [audio] }
 assert.equal(build('', first).prompt, undefined)
 assert.equal(build('', { ...first, aspect_ratio: 'stale-ratio' }).aspect_ratio, undefined)
 assert.deepEqual(build('Reference', ref).image_with_roles, [{ url: image, role: 'reference_image' }])
 assert.deepEqual(build('Reference', ref).audio_urls, [audio])
 assert.equal(build('Reference', { ...ref, resolution: '4k', audio: 'false', duration: 16, seed: 0 }).resolution, '4K')
 assert.equal(build('Reference', { ...ref, audio: 'false' }).audio, false)
 for (const [prompt, params, error] of [
  ['', ref, /requires a prompt/], ['x', { ...first, refImages: [] }, /exactly one/],
  ['x', { ...first, refAudios: [audio] }, /no reference audio/],
  ['x', { ...ref, refImages: Array(16).fill(image) }, /1 to 15/],
  ['x', { ...ref, refAudios: Array(4).fill(audio) }, /at most 3/],
  ['x', { ...ref, refVideos: ['https://example.test/video.mp4'] }, /does not accept/],
  ['x', { ...ref, refPdfs: ['https://example.test/brief.pdf'] }, /does not accept/],
  ['x', { ...first, genMode: 'text-to-video' }, /supports only/],
  ['x', { ...first, genMode: 'first-last-frame' }, /supports only/],
  ...[2, 17, 3.5].map(duration => ['x', { ...first, duration }, /whole number/]),
  ['x', { ...first, resolution: '480p' }, /resolution/],
  ['x', { ...first, audio: 'off' }, /audio must/],
  ['x', { ...first, seed: -1 }, /seed must/],
  ['x'.repeat(20001), first, /20000/],
 ]) assert.throws(() => build(prompt, params), error)
 const requests = [], writes = []
 const app = { vault: { adapter: { exists: async () => true, stat: async () => ({ size: 100 }), writeBinary: async (path, data) => writes.push({ path, data }) } } }
 globalThis.__request = async request => {
  requests.push(request)
  return { status: 200, json: { data: [{ task_id: 'vidu-task' }], output: { task_id: 'wan-task' } } }
 }
 const apimart = new APIMartProvider('test-key', app, 'assets')
 await apimart.generateVideo('', { ...first, modelId: 'viduq4-preview' })
 assert.equal(JSON.parse(requests.at(-1).body).first_frame_image, image)
 await apimart.generateVideo('Reference', { ...ref, modelId: 'viduq4-preview' })
 assert.equal(requests.at(-1).url, 'https://api.apimart.ai/v1/videos/generations')
 assert.equal(JSON.parse(requests.at(-1).body).model, 'viduq4-preview')
 const count = requests.length
 await assert.rejects(() => apimart.generateVideo('x', { ...first, modelId: 'viduq4-preview', duration: 2 }), /whole number/)
 assert.equal(requests.length, count, 'Invalid inputs must not upload or submit')
 const wan = new DashScopeVideoProvider('test-key', app, 'assets')
 const wanModel = ALL_MODELS.find(m => m.id === 'wan-3.0')
 assert.equal(wanModel.params.find(p => p.id === 'variant').default, 'standard')
 for (const mode of wanModel.modes) {
  const params = { modelId: 'wan3.0-video', genMode: mode, refImages: mode === 'first-last-frame' ? [image, image] : mode === 'first-frame' || mode === 'image-ref' ? [image] : [], refVideos: mode === 'video-ref' ? ['https://example.test/clip.mp4'] : [] }
  await wan.generateVideo('Test', params)
  const standard = JSON.parse(requests.at(-1).body)
  await wan.generateVideo('Test', { ...params, variant: 'prime' })
  assert.deepEqual(JSON.parse(requests.at(-1).body), { ...standard, model: 'wan3.0-video-prime' })
  assert.equal(JSON.parse(requests.at(-1).body).parameters.variant, undefined)
 }
 await assert.rejects(() => wan.generateVideo('x', { modelId: 'wan3.0-video', variant: 'unknown' }), /variant/)
 // Polling uses the original task and saves the completed media.
 globalThis.__request = async request => {
  requests.push(request)
  return request.url.includes('/tasks/')
   ? { status: 200, json: { data: { status: 'completed', result: { videos: [{ url: ['https://example.test/result.mp4'] }] } } } }
   : { status: 200, arrayBuffer: new Uint8Array([1, 2, 3]).buffer }
 }
 assert.equal((await apimart.checkStatus('vidu-task')).done, true)
 assert.match(writes[0].path, /assets\/apimart_video_.*\.mp4$/)
 assert.ok(requests.some(r => r.url === 'https://api.apimart.ai/v1/tasks/vidu-task'))
 globalThis.__request = async () => ({ status: 200, json: { data: { status: 'failed', error: { message: 'Invalid reference audio duration' } } } })
 await assert.rejects(() => apimart.checkStatus('vidu-task'), /Invalid reference audio duration/)
 // Exercise the real MCP handlers, including disabled models and empty prompt nodes.
 const source = { id: 'source', text: '', getData: () => ({ id: 'source', type: 'text', text: source.text }) }
 const imageNode = { id: 'image', getData: () => ({ id: 'image', type: 'file', file: 'refs/frame.png' }) }
 const audioNode = { id: 'audio', getData: () => ({ id: 'audio', type: 'file', file: 'refs/sound.mp3' }) }
 const edge = node => ({ from: { node }, to: { node: source }, getData: () => ({ fromNode: node.id, toNode: source.id, toEnd: 'arrow' }) })
 let edges = [edge(imageNode)], captures = []
 const canvas = { nodes: new Map([[source.id, source], [imageNode.id, imageNode], [audioNode.id, audioNode]]), getEdgesForNode: () => edges, requestFrame: async () => {}, getData: () => ({ nodes: [], edges: [] }) }
 const settings = { providers: { apimart: 'test', dashscope: 'test' }, modelPrefs: {}, providerModelPrefs: {}, modelOrder: { video: [], image: [], text: [], audio: [] } }
 const registry = createMcpToolRegistry({ app, getCanvas: () => canvas, getSettings: () => settings, runGeneration: async (_, result) => { captures.push(result); return { placeholderIds: ['result'], expectedOutputType: 'video' } } })
 const generate = registry.find(t => t.name === 'generate').handler
 const list = () => JSON.parse(registry.find(t => t.name === 'list_models').handler({ type: 'video' }).content[0].text)
 assert.equal(list().some(m => m.id === 'vidu-q4-preview'), false)
 await assert.rejects(() => generate({ nodeId: source.id, modelId: 'vidu-q4-preview' }), /not enabled/)
 settings.modelPrefs['vidu-q4-preview'] = { enabled: true, selectedProvider: 'apimart' }
 settings.providerModelPrefs.apimart = { 'vidu-q4-preview': true }
 assert.deepEqual(list().find(m => m.id === 'vidu-q4-preview').modes, ['first-frame', 'image-ref'])
 await generate({ nodeId: source.id, modelId: 'vidu-q4-preview' })
 assert.equal(captures.at(-1).mode, 'first-frame'); assert.equal(captures.at(-1).prompt, '')
 edges.push(edge(audioNode)); source.text = 'Use the image and sound.'
 await generate({ nodeId: source.id, modelId: 'vidu-q4-preview' })
 assert.equal(captures.at(-1).mode, 'image-ref')
 source.text = ''
 await assert.rejects(() => generate({ nodeId: source.id, modelId: 'vidu-q4-preview' }), /no prompt text/)
 assert.equal(allowsEmptyPrompt('wan-3.0', 'first-frame', 1, 0), false)
 // Execute production canvas dispatch to verify reference delivery and Prime queue metadata.
 const main = await readFile('src/main.ts', 'utf8')
 const ast = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true)
 const cls = ast.statements.find(n => ts.isClassDeclaration(n) && n.name?.text === 'BragiCanvas')
 const method = cls.members.find(m => m.name?.getText(ast) === 'runSingleGeneration').getText(ast)
 const code = ts.transpileModule(`class Subject { ${method} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
 const failures = [], queued = [], delivered = []
 let modelId = 'vidu-q4-preview'
 let audioPath = 'refs/sound.mp3'
 const deps = { buildApimartViduRequest: build, resolveWan30ApiModelId, getOrderedImages: () => modelId.startsWith('vidu') ? ['refs/frame.png'] : [], getOrderedAudios: () => modelId.startsWith('vidu') ? [audioPath] : [], getProvider: () => ({ makeVideo: () => ({ generateVideo: async (_, params) => { delivered.push(params); return { done: false, taskId: 'task' } } }) }), setGeneratingStatus: () => {}, Notice: class {}, markNodeFailed: (_, error) => failures.push(error), errorMessage: String }
 const Subject = new Function(...Object.keys(deps), code + ';return Subject')(...Object.values(deps))
 const subject = new Subject(); subject.app = app; subject.settings = { providers: {} }; subject.getCanvasPath = () => 'test.canvas'
 subject.prepareReferenceMedia = async (_, __, kind, path) => `https://temp.bragi.now/${kind}/${path}`
 subject.taskQueue = { addTask: async task => queued.push(task.snapshot) }
 await subject.runSingleGeneration(source, { model: ALL_MODELS.find(m => m.id === modelId), activeProvider: 'apimart', apiModelId: 'viduq4-preview', mode: 'image-ref', params: {} }, canvas, { id: 'result' }, 'Reference', { videos: [], audios: [], pdfs: [] }, [], 'test.canvas', 'assets')
 assert.deepEqual(failures, []); assert.equal(delivered[0].refAudios.length, 1); assert.match(delivered[0].refAudios[0], /sound\.mp3$/)
 audioPath = 'refs/sound.wav'
 await subject.runSingleGeneration(source, { model: ALL_MODELS.find(m => m.id === modelId), activeProvider: 'apimart', apiModelId: 'viduq4-preview', mode: 'image-ref', params: {} }, canvas, { id: 'bad-audio' }, 'Reference', { videos: [], audios: [], pdfs: [] }, [], 'test.canvas', 'assets')
 assert.match(failures.pop(), /must be MP3/)
 assert.equal(delivered.length, 1, 'Invalid audio format must not submit a generation')
 audioPath = 'refs/sound.mp3'; app.vault.adapter.stat = async () => ({ size: 50 * 1024 * 1024 + 1 })
 await subject.runSingleGeneration(source, { model: ALL_MODELS.find(m => m.id === modelId), activeProvider: 'apimart', apiModelId: 'viduq4-preview', mode: 'image-ref', params: {} }, canvas, { id: 'large-file' }, 'Reference', { videos: [], audios: [], pdfs: [] }, [], 'test.canvas', 'assets')
 assert.match(failures.pop(), /50 MB/)
 assert.equal(delivered.length, 1, 'Oversized references must not submit a generation')
 modelId = 'wan-3.0'
 await subject.runSingleGeneration(source, { model: wanModel, activeProvider: 'dashscope', apiModelId: 'wan3.0-video', mode: 'text-to-video', params: { variant: 'prime' } }, canvas, { id: 'result' }, 'Test', { videos: [], audios: [], pdfs: [] }, [], 'test.canvas', 'assets')
 assert.deepEqual(failures, []); assert.equal(queued.at(-1).apiModelId, 'wan3.0-video-prime')
 console.log('Wan Prime and Vidu: payload boundaries, provider routing, polling/download, MCP opt-in/empty prompt/mode inference, canvas audio delivery, and Prime queue identity passed.')
} finally {
 delete globalThis.__request
 await runtime.cleanup()
}

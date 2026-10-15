import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { testRuntime } from './test-runtime.mjs'

const runtime = await testRuntime(`
export { createMcpToolRegistry } from './src/mcp-tool-registry';
export { getOrderedAudios } from './src/audio-refs';
export { getOrderedImages } from './src/ref-thumbnails';
export { getUpstreamInputs } from './src/edge-parser';
export { getSeedanceReferenceLimits } from './src/seedance-capabilities';
export { prepareTextInputs } from './src/text-input-prep';
export { ALL_MODELS } from './src/models';
`)

try {
	const { createMcpToolRegistry, getOrderedAudios, getOrderedImages, getUpstreamInputs, getSeedanceReferenceLimits, prepareTextInputs, ALL_MODELS } = runtime.module
	let savedOrder
	const node = { id: 'prompt', getData: () => ({ type: 'text', text: '<Audio 1> speaks.', bragiAudioOrder: savedOrder }) }
	const fileNode = (id, file) => ({ id, getData: () => ({ type: 'file', file }) })
	const sources = [fileNode('alice', 'alice.mp3'), fileNode('bob', 'bob.mp3'), fileNode('alice-copy', 'alice.mp3'), fileNode('face', 'face.png')]
	const edge = source => ({ from: { node: source }, to: { node }, getData: () => ({ toEnd: 'arrow', fromEnd: 'none' }) })
	const canvas = { nodes: new Map([[node.id, node], ...sources.map(source => [source.id, source])]), getEdgesForNode: () => sources.map(edge) }
	const app = { vault: { adapter: { stat: async () => ({ size: 1 }), readBinary: async path => new TextEncoder().encode(path).buffer } } }
	const listing = createMcpToolRegistry({ getCanvas: () => canvas, app }).find(tool => tool.name === 'get_upstream')

	// Execute the production dispatcher so the assertion covers references sent to
	// the provider, rather than a second implementation of the ordering rule.
	const source = await readFile('src/main.ts', 'utf8')
	const ast = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true)
	const cls = ast.statements.find(statement => ts.isClassDeclaration(statement) && statement.name?.text === 'BragiCanvas')
	const method = cls.members.find(member => member.name?.getText(ast) === 'runSingleGeneration').getText(ast)
	const code = ts.transpileModule(`class Subject { ${method} }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
	const submitted = [], failures = []
	const provider = { generateVideo: async (_prompt, params) => { submitted.push(params); return { done: false, taskId: 'ordering-task' } } }
	const dependencies = {
		getOrderedAudios, getOrderedImages, getSeedanceReferenceLimits,
		getProvider: () => ({ makeVideo: () => provider }),
		setGeneratingStatus: () => {}, Notice: class {},
		markNodeFailed: (_node, error) => failures.push(error), errorMessage: String,
	}
	const Subject = new Function(...Object.keys(dependencies), `${code}; return Subject`)(...Object.values(dependencies))
	const subject = new Subject()
	subject.app = app
	subject.settings = { providers: {} }
	subject.getCanvasPath = () => 'ordering.canvas'
	subject.taskQueue = { addTask: async () => {} }
	subject.prepareReferenceMedia = async (_provider, _model, _modality, path) => `https://media.example.test/${path}`

	for (const { order, expected } of [
		{ order: ['bob.mp3', 'alice.mp3'], expected: ['bob.mp3', 'alice.mp3'] },
		{ order: undefined, expected: ['alice.mp3', 'bob.mp3'] },
		{ order: ['removed.mp3', 'bob.mp3'], expected: ['bob.mp3', 'alice.mp3'] },
	]) {
		savedOrder = order
		const result = await listing.handler({ id: node.id })
		const listed = JSON.parse(result.content[0].text).audios
		assert.deepEqual(listed, expected, 'MCP audio numbering must follow visible drag order, ignore removed refs, append new refs, and deduplicate files')

		for (const [modelId, activeProvider] of [['fast-h3-omni', 'svnewapi'], ['minimax-h3', 'apimart'], ['minimax-h3', 'pika']]) {
			const model = ALL_MODELS.find(candidate => candidate.id === modelId)
			const previousCount = submitted.length
			await subject.runSingleGeneration(node, {
				model, activeProvider, apiModelId: model.supportedProviders[activeProvider].apiModelId,
				mode: 'image-ref', params: {},
			}, canvas, { id: 'result' }, '<Audio 1> speaks.', getUpstreamInputs(canvas, node), [], 'ordering.canvas', 'assets')
			assert.deepEqual(failures, [], `${activeProvider}/${modelId} dispatch must succeed`)
			assert.equal(submitted.length, previousCount + 1)
			assert.deepEqual(submitted.at(-1).refAudios, listed.map(path => `https://media.example.test/${path}`), `${activeProvider}/${modelId} must submit the same audio numbering reported by MCP`)
		}

		const prepared = await prepareTextInputs(app, canvas, node, 'qwen-3-6-plus', 'dashscope', getUpstreamInputs(canvas, node))
		const textAudioPaths = prepared.refAudios.map(ref => Buffer.from(ref.split(',')[1], 'base64').toString())
		assert.deepEqual(textAudioPaths, listed, 'Multimodal text preparation must preserve the same audio numbering as MCP and video generation')
	}
	console.log('MCP, Reactor, APIMart/Pika video, and multimodal text audio ordering passed, including fallback, stale refs, and duplicate edges.')
} finally {
	await runtime.cleanup()
}

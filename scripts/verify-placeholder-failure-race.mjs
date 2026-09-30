import assert from 'node:assert/strict'
import { testRuntime } from './test-runtime.mjs'
const { module: { createPlaceholderNode, markNodeFailed, replacePlaceholderWithFile, setGeneratingStatus, sweepInterruptedPlaceholders }, cleanup } = await testRuntime(`
export { createPlaceholderNode, markNodeFailed, replacePlaceholderWithFile, setGeneratingStatus, sweepInterruptedPlaceholders } from './src/canvas-ops'
`)

// Canvas runtime modeled on Obsidian 1.13.7: importData reuses node objects by ID
// and overwrites their data, and clear=true drops nodes missing from the snapshot.
// requestSave snapshots canvas.data for the debounced view save. An adapter write
// to the .canvas file is an external edit, so the file watcher later reloads the
// whole canvas from disk; the view's own save never triggers that reload.
function workspace() {
	let disk = '{"nodes":[],"edges":[]}', seq = 0
	const watcher = []
	class Node {
		constructor(canvas, id) { this.canvas = canvas; this.id = id; this.data = { id } }
		get x() { return this.data.x }
		get y() { return this.data.y }
		getData() { return structuredClone(this.data) }
		setData(data) { this.data = structuredClone({ ...data, id: this.id }) }
		setText(text) { this.data.text = text; return Promise.resolve() }
		destroy() { this.destroyed = true }
	}
	const reload = () => { canvas.importData(JSON.parse(disk), true); canvas.data = JSON.parse(disk) }
	const view = {
		file: { path: 'Race.canvas' }, dirty: false,
		app: { vault: { adapter: { write: async (path, text) => { disk = text; watcher.push(reload) } } } },
		save: async () => { view.dirty = false; disk = JSON.stringify(canvas.data) },
	}
	const canvas = {
		view, nodes: new Map(), edges: [], data: {},
		createTextNode({ text, pos, size }) {
			const node = new Node(this, `node-${++seq}`)
			node.setData({ type: 'text', text, x: pos.x, y: pos.y, width: size.width, height: size.height })
			this.nodes.set(node.id, node)
			return node
		},
		getData() { return { nodes: [...this.nodes.values()].map(node => node.getData()), edges: structuredClone(this.edges) } },
		importData(data, clear) {
			const seen = new Set()
			for (const nodeData of data.nodes) {
				let node = this.nodes.get(nodeData.id)
				if (!node) { node = new Node(this, nodeData.id); this.nodes.set(node.id, node) }
				node.setData(nodeData)
				seen.add(node.id)
			}
			if (clear) for (const [id, node] of this.nodes) if (!seen.has(id)) { this.nodes.delete(id); node.destroy() }
			this.edges = structuredClone(data.edges)
		},
		removeNode(node) { this.nodes.delete(node.id); node.destroy() },
		requestSave() { this.data = this.getData(); view.dirty = true },
	}
	const sources = ['pro', 'flash', 'v45'].map((id, i) => ({ id, type: 'text', text: `Prompt ${id}`, x: 0, y: i * 700, width: 320, height: 160 }))
	canvas.importData({ nodes: sources, edges: [] })
	canvas.requestSave(); void view.save()
	return {
		canvas,
		deliverFileEvents: () => { while (watcher.length) watcher.shift()() },
		runDebouncedSave: () => { if (view.dirty) void view.save() },
		disk: id => JSON.parse(disk).nodes.find(node => node.id === id),
	}
}
const upstream = 'Seedream: ModelNotOpen — Your account has not activated the model doubao-seedream-5-0-flash-260915.'
const state = node => node.getData().bragiGenerationFailed ? node.getData().bragiGenFailureTitle : node.getData().bragiGenerating ? 'generating' : node.getData().type

try {
	// Reported race: Pro, Flash and 4.5 start back to back and Flash is rejected
	// before the file watcher reports the placeholder writes. The failure must
	// survive, reach disk, and not be swept as interrupted.
	let w = workspace()
	const place = (id, name) => createPlaceholderNode(w.canvas, name, w.canvas.nodes.get(id), { w: 400, h: 300 })
	const pro = place('pro', 'Seedream 5.0 Pro'), flash = place('flash', 'Seedream 5.0 Flash'), v45 = place('v45', 'Seedream 4.5')
	assert.equal(w.disk(v45.id)?.bragiGenerating, true, 'A new placeholder is saved immediately')
	markNodeFailed(flash, upstream)
	w.deliverFileEvents()
	assert.equal(state(w.canvas.nodes.get(flash.id)), 'Generation Failed', 'Placeholder writes must not reload the canvas over a newer failure')
	w.runDebouncedSave()
	assert.equal(w.disk(flash.id).bragiGenerationFailed, true, 'The pending save must write the failure, not the generating snapshot')
	assert.equal(w.disk(flash.id).bragiGenerating, undefined)
	assert.equal(sweepInterruptedPlaceholders(w.canvas, id => id === pro.id || id === v45.id), 0)
	assert.equal(w.canvas.nodes.get(flash.id).getData().bragiGenError, upstream)

	// A stale snapshot applied after the failure (undo, external reload) brings
	// `bragiGenerating` back. The sweep restores the recorded failure; genuinely
	// untracked placeholders are still reported as interrupted.
	const beforeFailure = structuredClone(w.canvas.getData())
	beforeFailure.nodes.find(node => node.id === flash.id).bragiGenerating = true
	delete beforeFailure.nodes.find(node => node.id === flash.id).bragiGenerationFailed
	w.canvas.importData(beforeFailure, true)
	assert.equal(state(w.canvas.nodes.get(flash.id)), 'generating')
	assert.equal(sweepInterruptedPlaceholders(w.canvas, id => id === pro.id), 1)
	assert.equal(state(w.canvas.nodes.get(flash.id)), 'Generation Failed')
	assert.equal(w.canvas.nodes.get(flash.id).getData().bragiGenError, upstream)
	assert.equal(state(w.canvas.nodes.get(v45.id)), 'Generation Interrupted')

	// Resuming a placeholder clears its recorded failure, so a later real
	// interruption is not masked by the old message.
	setGeneratingStatus(flash, { label: 'Waiting for provider' })
	assert.equal(sweepInterruptedPlaceholders(w.canvas, id => id === pro.id), 1)
	assert.equal(state(w.canvas.nodes.get(flash.id)), 'Generation Interrupted')

	// A reload that replaces runtime node objects must not strand late writes on
	// the object captured when generation started.
	w = workspace()
	const failing = createPlaceholderNode(w.canvas, 'Seedream 5.0 Flash', w.canvas.nodes.get('flash'))
	const succeeding = createPlaceholderNode(w.canvas, 'Seedream 5.0 Pro', w.canvas.nodes.get('pro'))
	const snapshot = w.canvas.getData()
	w.canvas.importData({ nodes: snapshot.nodes.filter(node => node.id !== failing.id && node.id !== succeeding.id), edges: [] }, true)
	w.canvas.importData(snapshot, true)
	const liveSucceeding = w.canvas.nodes.get(succeeding.id)
	assert.notEqual(w.canvas.nodes.get(failing.id), failing)
	markNodeFailed(failing, upstream)
	assert.equal(state(w.canvas.nodes.get(failing.id)), 'Generation Failed')
	replacePlaceholderWithFile(w.canvas, succeeding, '_bragi/assets/pro.jpg', w.canvas.nodes.get('pro'))
	assert.equal(liveSucceeding.destroyed, true, 'The live placeholder is removed, not left behind as a generating node')
	assert.equal(w.canvas.nodes.has(succeeding.id), false)
	assert.ok([...w.canvas.nodes.values()].some(node => node.getData().file === '_bragi/assets/pro.jpg'))

	console.log('Placeholder failure race: concurrent failure survives placeholder saves, reaches disk, survives stale snapshots and replaced node objects.')
} finally { await cleanup() }

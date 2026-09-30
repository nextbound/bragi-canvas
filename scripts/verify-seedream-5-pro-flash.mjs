import assert from 'node:assert/strict'
import { testRuntime } from './test-runtime.mjs'

const runtime = await testRuntime(`
export { SeedreamProvider, SEEDREAM_SIZE_MAP } from './src/providers/seedream';
export { ALL_MODELS, isApiModelIdEditable } from './src/models';
export { validateCatalog } from './src/models/validate-catalog';
export { resolveApiModelId } from './src/provider-model-prefs';
`)

// Seedream 5.0 Pro / Flash method-2 limits from the Volcengine and BytePlus image API docs.
const PRO_FLASH_MIN_PIXELS = 921_600
const PRO_FLASH_MAX_PIXELS = 4_624_220

try {
	const { SeedreamProvider, SEEDREAM_SIZE_MAP, ALL_MODELS, isApiModelIdEditable, resolveApiModelId, validateCatalog } = runtime.module

	const pro = ALL_MODELS.find(m => m.id === 'seedream-5.0-pro')
	const flash = ALL_MODELS.find(m => m.id === 'seedream-5.0-flash')
	assert.ok(pro && flash, 'Seedream 5.0 Pro and Flash must be registered in ALL_MODELS.')
	assert.equal(pro.supportedProviders.bytedance.apiModelId, 'doubao-seedream-5-0-pro-260628')
	assert.equal(flash.supportedProviders.bytedance.apiModelId, 'doubao-seedream-5-0-flash-260915')
	assert.equal(pro.supportedProviders.byteplus.apiModelId, 'dola-seedream-5-0-pro-260628')
	assert.equal(flash.supportedProviders.byteplus.apiModelId, 'dola-seedream-5-0-flash-260915')
	for (const model of [pro, flash]) {
		for (const providerId of ['bytedance', 'byteplus']) {
			assert.equal(isApiModelIdEditable(model, providerId), true, `${model.name} on ${providerId} must accept ep- endpoint ids.`)
			// A stored endpoint override reaches the request unchanged.
			const settings = { apiModelIdOverrides: { [providerId]: { [model.id]: 'ep-20260930-custom' } } }
			assert.equal(resolveApiModelId(settings, providerId, model), 'ep-20260930-custom')
		}
		const resolution = model.params.find(p => p.id === 'resolution')
		assert.deepEqual(resolution.options.map(o => o.value), ['1K', '1.5K', '2K'])
		assert.equal(resolution.default, '2K')
		const ratios = model.params.find(p => p.id === 'aspectRatio').options.map(o => o.value)
		for (const tier of resolution.options.map(o => o.value)) {
			for (const ratio of ratios) {
				const size = SEEDREAM_SIZE_MAP[tier]?.[ratio]
				assert.ok(size, `${model.name} ${tier} ${ratio} must have a pixel size.`)
				const [w, h] = size.split('x').map(Number)
				assert.ok(w * h >= PRO_FLASH_MIN_PIXELS && w * h <= PRO_FLASH_MAX_PIXELS, `${tier} ${ratio} (${size}) is outside the Pro / Flash pixel range.`)
			}
		}
	}
	// Every Volcengine / BytePlus model accepts a custom inference endpoint in place of its model ID.
	const arkModels = ALL_MODELS.filter(m => m.supportedProviders.bytedance || m.supportedProviders.byteplus)
	assert.ok(arkModels.length >= 8)
	for (const model of arkModels) {
		for (const providerId of ['bytedance', 'byteplus'].filter(id => model.supportedProviders[id])) {
			assert.equal(isApiModelIdEditable(model, providerId), true, `${model.id} on ${providerId} must keep its API model ID editable.`)
		}
	}
	const locked = { ...pro, supportedProviders: { ...pro.supportedProviders, bytedance: { apiModelId: 'doubao-seedream-5-0-pro-260628' } } }
	assert.ok(
		validateCatalog([locked], [{ id: 'bytedance' }, { id: 'byteplus' }]).some(e => /must set editableApiModelId/.test(e)),
		'check:catalog must reject a Volcengine / BytePlus entry with a locked model ID.',
	)

	assert.deepEqual(pro.params.find(p => p.id === 'optimizeMode').options.map(o => o.value), ['standard', 'fast'])
	assert.equal(flash.params.find(p => p.id === 'optimizeMode'), undefined, 'Flash rejects the fast prompt-optimization mode.')

	const requests = []
	const writes = []
	let reply
	globalThis.__request = async request => {
		requests.push(request)
		return reply
	}
	const app = { vault: { adapter: { exists: async () => true, mkdir: async () => {}, writeBinary: async path => { writes.push(path) } } } }
	const provider = new SeedreamProvider('test', app, 'assets')
	const b64 = bytes => Buffer.from(bytes).toString('base64')
	const ok = bytes => ({ status: 200, text: '', json: { data: [{ b64_json: b64(bytes) }] } })
	const jpeg = [0xff, 0xd8, 0xff, 0xe0, 0x00]
	const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

	reply = ok(jpeg)
	const fast = await provider.generateImage('Test', { modelId: 'dola-seedream-5-0-pro-260628', resolution: '1.5K', aspectRatio: '16:9', optimizeMode: 'fast', refImages: ['https://example.test/a.png'] })
	let body = JSON.parse(requests.at(-1).body)
	assert.equal(requests.at(-1).throw, false, 'Upstream 4xx bodies must reach the error formatter.')
	assert.equal(body.model, 'dola-seedream-5-0-pro-260628')
	assert.equal(body.size, '2048x1152')
	assert.deepEqual(body.optimize_prompt_options, { mode: 'fast' })
	assert.deepEqual(body.image, ['https://example.test/a.png'])
	assert.equal('sequential_image_generation' in body, false, 'Seedream 5.0 Pro / Flash reject sequential_image_generation.')
	assert.match(fast.filePath, /^assets\/img_\d+\.jpg$/, 'JPEG output must be saved with a .jpg extension.')

	reply = ok(png)
	const standard = await provider.generateImage('Test', { modelId: 'ep-seedream-flash', resolution: '1K', aspectRatio: '21:9', optimizeMode: 'standard' })
	body = JSON.parse(requests.at(-1).body)
	assert.equal(body.model, 'ep-seedream-flash')
	assert.equal(body.size, '1568x672')
	assert.equal('optimize_prompt_options' in body, false, 'The upstream default standard mode is not sent.')
	assert.equal('image' in body, false)
	assert.match(standard.filePath, /\.png$/)

	reply = {
		status: 404,
		text: '',
		json: { error: { code: 'ModelNotOpen', message: 'Your account has not activated the model doubao-seedream-5-0-flash-260915.' } },
	}
	await assert.rejects(
		provider.generateImage('Test', { modelId: 'doubao-seedream-5-0-flash-260915' }),
		/Seedream: ModelNotOpen — Your account has not activated the model/,
	)
	reply = { status: 400, text: '', json: { error: { code: 'InvalidParameter', message: 'number of reference images cannot exceed 10' } } }
	await assert.rejects(
		provider.generateImage('Test', { modelId: 'doubao-seedream-5-0-pro-260628', refImages: Array(11).fill('https://example.test/a.png') }),
		/InvalidParameter — number of reference images cannot exceed 10/,
	)
	assert.equal(writes.length, 2)

	console.log('Seedream 5.0 Pro / Flash: catalog ids, editable Volcengine / BytePlus ids, 1K–2K sizes, fast mode, request body, output extension and upstream errors passed.')
} finally {
	await runtime.cleanup()
}

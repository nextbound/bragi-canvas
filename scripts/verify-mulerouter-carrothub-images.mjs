import { existsSync, readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const modelSource = readFileSync('src/models/wan.ts', 'utf8')
const modelIndexSource = readFileSync('src/models/index.ts', 'utf8')
const registrySource = readFileSync('src/providers/registry.ts', 'utf8')
const providerSource = readFileSync('src/providers/mulerouter.ts', 'utf8')

function assertOrder(source, first, second, message) {
	const firstIndex = source.indexOf(first)
	const secondIndex = source.indexOf(second)
	assert.notEqual(firstIndex, -1, `${message}: missing "${first}"`)
	assert.notEqual(secondIndex, -1, `${message}: missing "${second}"`)
	assert.ok(firstIndex < secondIndex, message)
}

for (const modelId of ['z-image-spicy', 'qwen-image-edit-spicy']) {
	assert.match(modelSource, new RegExp(`id: '${modelId}'`), `${modelId} must be registered in the model catalogue`)
	assert.match(
		modelSource,
		new RegExp(`mulerouter: \\{ apiModelId: '${modelId}' \\}`),
		`${modelId} must be connected to MuleRouter`,
	)
}

assert.match(modelSource, /modes: \['text-to-image'\]/, 'Z-Image Spicy must expose text-to-image mode')
assert.match(modelSource, /modes: \['image-ref-to-image'\]/, 'Qwen Image Edit Spicy must expose image-ref-to-image mode')
assert.match(modelSource, /id: 'aspectRatio'[\s\S]*default: '2:3'/, 'Z-Image Spicy must expose fixed aspect-ratio choices')
assert.doesNotMatch(modelSource, /id: 'seed'/, 'MuleRouter image models must not expose seed')
assert.doesNotMatch(modelSource, /id: 'width'|id: 'height'/, 'Z-Image Spicy must not expose free width/height params')
assertOrder(modelIndexSource, 'zImageSpicy', 'qwenImageEditSpicy', 'MuleRouter image models must be included in image catalogue order')

assert.match(registrySource, /MuleRouterImageProvider/, 'MuleRouter registry must import the image provider')
assert.match(registrySource, /makeImage: \(\{ settings, app, outputDir \}\) =>[\s\S]*new MuleRouterImageProvider/, 'MuleRouter must expose makeImage')

for (const endpoint of [
	'/vendors/carrothub/v1/z-image-spicy/generation',
	'/vendors/carrothub/v1/qwen-image-edit-spicy/generation',
]) {
	assert.match(providerSource, new RegExp(endpoint.replace(/[/.]/g, '\\$&')), `provider must call ${endpoint}`)
}
assert.match(providerSource, /class MuleRouterImageProvider implements ImageProvider/, 'MuleRouter image provider must implement ImageProvider')
assert.match(providerSource, /Z_IMAGE_SIZES/, 'MuleRouter image provider must map aspect ratios to fixed Z-Image dimensions')
assert.doesNotMatch(providerSource, /body\.seed|parseOptionalSeed/, 'MuleRouter image provider must not send seed')
assert.match(providerSource, /pollImageTask/, 'MuleRouter image provider must poll async image tasks')
assert.match(providerSource, /extractImageUrl/, 'MuleRouter image provider must extract completed image URLs')

const skillModelsPath = '../skill/bragi-canvas/references/models.md'
if (existsSync(skillModelsPath)) {
	const skillModelsSource = readFileSync(skillModelsPath, 'utf8')
	for (const modelId of ['z-image-spicy', 'qwen-image-edit-spicy']) {
		assert.match(skillModelsSource, new RegExp(`\`${modelId}\``), `skill docs must mention ${modelId}`)
	}
	assert.match(skillModelsSource, /MuleRouter key →/, 'skill docs must keep the MuleRouter provider availability note')
}

console.log('MuleRouter CarrotHub image model checks passed.')

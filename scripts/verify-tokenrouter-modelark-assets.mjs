import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const settingsSource = readFileSync('src/settings.ts', 'utf8')
const registrySource = readFileSync('src/providers/registry.ts', 'utf8')
const assetFlowSource = readFileSync('src/tokenrouter-asset-flow.ts', 'utf8')
const modelArkAssetSource = readFileSync('src/providers/tokenrouter-modelark-assets.ts', 'utf8')
const mainSource = readFileSync('src/main.ts', 'utf8')

function assertOrder(source, first, second, message) {
	const firstIndex = source.indexOf(first)
	const secondIndex = source.indexOf(second)
	assert.notEqual(firstIndex, -1, `${message}: missing "${first}"`)
	assert.notEqual(secondIndex, -1, `${message}: missing "${second}"`)
	assert.ok(firstIndex < secondIndex, message)
}

assert.match(
	settingsSource,
	/tokenrouterModelArkAssetGroupId: string/,
	'TokenRouter settings must include optional ModelArk shared asset group id',
)

assert.match(
	settingsSource,
	/tokenrouterModelArkAssetGroupId: ''/,
	'TokenRouter shared asset group id must default to empty',
)

assert.match(
	registrySource,
	/key: 'tokenrouterModelArkAssetGroupId', label: 'ModelArk asset group ID \(optional\)'/,
	'TokenRouter provider settings must expose the shared ModelArk asset group field',
)

assert.match(
	assetFlowSource,
	/plugin\.settings\.providers\.tokenrouterModelArkAssetGroupId/,
	'TokenRouter ModelArk credentials must read the optional shared group id',
)

assert.match(
	assetFlowSource,
	/new WeakMap<Canvas, Promise<string>>\(\)/,
	'TokenRouter ModelArk group creation must use an in-memory singleflight lock per canvas',
)

assertOrder(
	assetFlowSource,
	'if (sharedGroupId) return sharedGroupId',
	'const existing = getCachedGroupId(canvas)',
	'configured shared group must win before canvas-scoped auto-create cache',
)

assert.match(
	assetFlowSource,
	/shared group is only the ModelArk upload container[\s\S]*explicit asset ids collected from the current canvas edges/,
	'asset flow must document that shared groups are containers, not implicit generation context',
)

assert.match(
	assetFlowSource,
	/isSharedGroupConfigured\(creds\)[\s\S]*shared asset group not found or inaccessible/,
	'configured shared group not-found errors must be actionable and must not silently recreate a different group',
)

assert.match(
	modelArkAssetSource,
	/TokenRouter ModelArk asset group quota reached/,
	'TokenRouter ModelArk group quota errors must be translated into an actionable message',
)

assert.doesNotMatch(
	modelArkAssetSource,
	/GET',\s*'\/asset-groups|\/asset-groups\?/,
	'Bragi must not list/search ModelArk groups and accidentally select unrelated historical state',
)

assert.match(
	mainSource,
	/provider\.generateVideo\(finalPrompt, \{ \.\.\.params, modelId: apiModelId, genMode: mode, refImages, refAudios, refVideos \}\)/,
	'video generation must pass only the current explicit reference arrays',
)

assert.doesNotMatch(
	mainSource,
	/listModelArk|searchModelArk|assetGroupAssets|groupAssets/,
	'video generation must not inject implicit assets from a shared group',
)

console.log('TokenRouter ModelArk asset flow checks passed.')

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

function assertContains(source, needle, message) {
	assert.ok(source.includes(needle), `${message}: missing "${needle}"`)
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
	/key: 'tokenrouterModelArkAssetGroupId', label: 'Asset group ID \(optional\)'/,
	'TokenRouter provider settings must expose the shared ModelArk asset group field with the unified label',
)

assert.match(
	registrySource,
	/key: 'byteplusProjectName', label: 'Asset group ID \(optional\)'/,
	'BytePlus provider settings must use the unified asset group label',
)

assert.match(
	registrySource,
	/key: 'token360AssetGroupId', label: 'Asset group ID \(optional\)'/,
	'Token360 provider settings must use the unified asset group label',
)

assert.match(
	assetFlowSource,
	/plugin\.settings\.providers\.tokenrouterModelArkAssetGroupId/,
	'TokenRouter ModelArk credentials must read the optional shared group id',
)

assertContains(
	assetFlowSource,
	'if (!apiKey || !groupId) return null',
	'TokenRouter ModelArk asset credentials must require both API key and configured group id',
)

assert.doesNotMatch(
	assetFlowSource,
	/createModelArkAssetGroup|getOrCreateGroupId|tokenrouterModelArkGroupId|WeakMap<Canvas/,
	'TokenRouter must not auto-create or cache ModelArk asset groups when no group id is configured',
)

assertContains(
	assetFlowSource,
	'createModelArkAsset(creds, creds.groupId, url, assetType)',
	'TokenRouter ModelArk asset upload must use only the configured group id',
)

assert.match(
	assetFlowSource,
	/asset group not found or inaccessible[\s\S]*creds\.groupId/,
	'configured ModelArk group not-found errors must be actionable and must not silently recreate a different group',
)

assert.doesNotMatch(
	modelArkAssetSource,
	/createModelArkAssetGroup|POST',\s*'\/asset-groups'|TokenRouter ModelArk asset group quota reached/,
	'Bragi must not create TokenRouter ModelArk asset groups',
)

assert.doesNotMatch(
	modelArkAssetSource,
	/GET',\s*'\/asset-groups|\/asset-groups\?/,
	'Bragi must not list/search ModelArk groups and accidentally select unrelated historical state',
)

assertOrder(
	mainSource,
	'const tokenRouterModelArkCreds = (activeProvider === \'tokenrouter\' && isSeedanceModel && hasSeedanceMediaRefs)',
	'const supportsSeedanceAssetRefs = isNativeSeedance || !!tokenRouterModelArkCreds',
	'TokenRouter asset:// refs must only be enabled after configured ModelArk credentials are known',
)

assertOrder(
	mainSource,
	'const supportsSeedanceAssetRefs = isNativeSeedance || !!tokenRouterModelArkCreds',
	'const assetIdMap = supportsSeedanceAssetRefs ? getAssetIds(canvas, node, activeProvider) : {}',
	'TokenRouter no-groupId path must not read existing tokenrouter asset id cache',
)

assertOrder(
	mainSource,
	'if (bytePlusCreds) {',
	'else if (assetIdMap[imgPath]) {',
	'BytePlus image refs must validate cached asset ids through ensureBytePlusAsset before direct asset:// fallback',
)

assertOrder(
	mainSource,
	'else if (tokenRouterModelArkCreds) {',
	'else if (assetIdMap[imgPath]) {',
	'TokenRouter image refs must validate cached asset ids through ensureTokenRouterModelArkAsset before direct asset:// fallback',
)

assertOrder(
	mainSource,
	'else if (token360AssetCreds) {',
	'else if (assetIdMap[imgPath]) {',
	'Token360 image refs must validate cached asset ids through ensureToken360Asset before direct asset:// fallback',
)

assert.match(
	mainSource,
	/else if \(activeProvider === 'tokenrouter' && isSeedanceModel\) \{[\s\S]*uploadRef\(undefined, binary, `ref\.\$\{ext\}`, imageMimeType\(imgPath\)\)/,
	'TokenRouter Seedance no-groupId image refs must be uploaded as relay URLs, not data URIs or asset:// refs',
)

assert.match(
	mainSource,
	/else if \(tokenRouterModelArkCreds\) \{[\s\S]*ensureTokenRouterModelArkAsset\(this, canvas, imgPath, tokenRouterModelArkCreds\)/,
	'TokenRouter Seedance configured group path must upload image refs through ModelArk assets',
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

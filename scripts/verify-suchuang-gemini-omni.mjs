import { existsSync, readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const modelSource = readFileSync('src/models/omni-flash.ts', 'utf8')
const registrySource = readFileSync('src/providers/registry.ts', 'utf8')
const settingsSource = readFileSync('src/settings.ts', 'utf8')
const migrationsSource = readFileSync('src/settings-migrations.ts', 'utf8')
const providerSource = readFileSync('src/providers/suchuang.ts', 'utf8')
const packageSource = readFileSync('package.json', 'utf8')

assert.match(modelSource, /suchuang: \{ apiModelId: 'google_omni' \}/, 'Omni-Flash-Ext must include Suchuang model mapping')
assert.match(settingsSource, /suchuang: string/, 'settings type must include providers.suchuang')
assert.match(settingsSource, /suchuang: ''/, 'default settings must include an empty Suchuang key')
assert.match(migrationsSource, /CURRENT_SETTINGS_SCHEMA_VERSION = \d+/, 'settings schema version must be defined (bumped for the new provider key)')

assert.match(registrySource, /SuchuangVideoProvider, testSuchuangConnection/, 'registry must import the Suchuang provider')
assert.match(registrySource, /id: 'suchuang'[\s\S]*name: 'SuChuang'[\s\S]*makeVideo:/, 'registry must expose SuChuang as a video provider')
assert.match(registrySource, /testConnection: \(d\) => testSuchuangConnection\(d\.suchuang \|\| ''\)/, 'registry must use the non-billing Suchuang connection test')
const legacyProviderNamePattern = new RegExp(`id: '${['wu', 'yin'].join('')}'|name: '\\u901f\\u521b API'|name: '\\u901f\\u521bAPI'`)
assert.doesNotMatch(registrySource, legacyProviderNamePattern, 'registry must expose the provider as suchuang, not a localized or legacy name')

for (const endpoint of ['/video_google_omni', '/detail']) {
	assert.match(providerSource, new RegExp(endpoint.replace(/[/.]/g, '\\$&')), `Suchuang provider must call ${endpoint}`)
}
assert.match(providerSource, /url\.searchParams\.set\('key', apiKey\)/, 'Suchuang requests must include key query auth')
assert.match(providerSource, /'Authorization': this\.apiKey/, 'Suchuang requests must include Authorization header auth')
assert.match(providerSource, /body\.images = urls\.join\(','\)/, 'Suchuang image refs must be sent as comma-separated images')
assert.match(providerSource, /arrayParam\(params\?\.refImages\)\.slice\(0, 7\)/, 'Suchuang must cap reference images at 7')
assert.match(providerSource, /does not support reference video inputs/, 'Suchuang must reject reference video inputs clearly')
assert.match(providerSource, /supports 720p and 1080p only/, 'Suchuang must reject 4K with a clear provider-specific error')
assert.match(providerSource, /status === '0' \|\| status === '1'/, 'Suchuang status parser must treat 0/1 as pending')
assert.match(providerSource, /status === '2'/, 'Suchuang status parser must treat 2 as success')
assert.match(providerSource, /status === '3'/, 'Suchuang status parser must treat 3 as failure')
assert.match(providerSource, /recordParam\(body\?\.data\)/, 'Suchuang status/task parsing must handle object or JSON-string data payloads')
assert.match(providerSource, /extractSuchuangVideoUrl/, 'Suchuang provider must expose tolerant final URL extraction')
assert.match(providerSource, /uploadRef\(undefined,[\s\S]*suchuang-ref/, 'Suchuang reference images must route through Bragi Relay')

assert.match(packageSource, /"test:suchuang-gemini-omni": "node scripts\/verify-suchuang-gemini-omni\.mjs"/, 'package script must run Suchuang checks')

const skillModelsPath = '../skill/bragi-canvas/references/models.md'
if (existsSync(skillModelsPath)) {
	const skillModelsSource = readFileSync(skillModelsPath, 'utf8')
	assert.match(skillModelsSource, /Omni-Flash-Ext[\s\S]*APIMart \/ SuChuang/, 'skill docs must list SuChuang for Omni-Flash-Ext')
	assert.match(skillModelsSource, /SuChuang key → Omni-Flash-Ext/, 'skill docs must include SuChuang provider availability')
}

console.log('SuChuang Gemini Omni provider checks passed.')

import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const mainSource = readFileSync('src/main.ts', 'utf8')
const textGenSource = readFileSync('src/providers/text-gen.ts', 'utf8')
const tokenRouterSource = readFileSync('src/providers/tokenrouter.ts', 'utf8')
const modelSource = readFileSync('src/models/text-gen.ts', 'utf8')
const capabilitySource = readFileSync('src/models/text-input-capabilities.ts', 'utf8')
const mcpToolRegistrySource = readFileSync('src/mcp-tool-registry.ts', 'utf8')

assert.match(
	modelSource,
	/id: 'gemini-3\.5-flash'[\s\S]*gemini: \{ apiModelId: 'gemini-3\.5-flash' \}[\s\S]*tokenrouter: \{ apiModelId: 'google\/gemini-3\.5-flash' \}/,
	'Gemini 3.5 Flash must be registered for Gemini and TokenRouter',
)

assert.match(
	mainSource,
	/provider\.generateText\(finalPrompt, \{ modelId: apiModelId, refImages, refVideos, refAudios, refPdfs \}\)/,
	'text generation must pass collected upstream video/audio/PDF refs to text providers',
)

assert.match(
	mainSource,
	/validateTextInputs\(model\.id, activeProvider, \{[\s\S]*videos: uniqueVideos\.length,[\s\S]*audios: uniqueAudios\.length,[\s\S]*\}, apiModelId\)/,
	'text generation must fail clearly when upstream file refs are used with unsupported providers',
)

assert.match(
	capabilitySource,
	/does not support upstream \$\{kindLabel\(kind\)\} for text generation\./,
	'text input validation must include a clear unsupported-reference error',
)

assert.match(
	mainSource,
	/const uniquePdfs = \[\.\.\.new Set\(upstream\.pdfs\)\]/,
	'text generation must collect upstream PDF refs',
)

assert.match(
	textGenSource,
	/const refVideos = Array\.isArray\(params\?\.refVideos\) \? params\.refVideos\.filter\(\(ref\): ref is string => typeof ref === 'string'\) : \[\]/,
	'Gemini text provider must read refVideos defensively',
)

assert.match(
	textGenSource,
	/const refAudios = Array\.isArray\(params\?\.refAudios\) \? params\.refAudios\.filter\(\(ref\): ref is string => typeof ref === 'string'\) : \[\]/,
	'Gemini text provider must read refAudios defensively',
)

assert.match(
	textGenSource,
	/const refPdfs = Array\.isArray\(params\?\.refPdfs\) \? params\.refPdfs\.filter\(\(ref\): ref is string => typeof ref === 'string'\) : \[\]/,
	'Gemini text provider must read refPdfs defensively',
)

assert.match(
	textGenSource,
	/import \{ uploadRef \} from '\.\/upload'[\s\S]*await uploadRef\(undefined, copyToArrayBuffer\(decoded\.bytes\), `\$\{label\}\.\$\{extensionForMime\(decoded\.mimeType\)\}`, decoded\.mimeType\)/,
	'Gemini text provider must upload file refs through Bragi Relay before passing fileData URLs',
)

assert.match(
	textGenSource,
	/parts\.push\(\{ fileData: file \}\)/,
	'Gemini text provider must send uploaded file refs as fileData parts',
)

assert.match(
	tokenRouterSource,
	/const refPdfs: string\[\] = Array\.isArray\(params\?\.refPdfs\) \? params\.refPdfs : \[\]/,
	'TokenRouter text provider must receive upstream PDF refs for live payload testing',
)

assert.match(
	tokenRouterSource,
	/type: 'file'[\s\S]*file_data: ref/,
	'TokenRouter text provider must send file refs as OpenAI-compatible file content parts',
)

assert.match(
	tokenRouterSource,
	/private videoContentPart\(ref: string, basename: string\): unknown \{[\s\S]*if \(isHttpUrl\(ref\)\) \{[\s\S]*type: 'video_url'[\s\S]*video_url: \{ url: ref \}[\s\S]*return this\.fileContentPart\(ref, basename\)/,
	'TokenRouter text provider must send relay video URLs as video_url parts',
)

assert.match(
	mcpToolRegistrySource,
	/audios: upstream\.audios[\s\S]*pdfs: upstream\.pdfs/,
	'MCP get_upstream must expose audio and PDF refs',
)

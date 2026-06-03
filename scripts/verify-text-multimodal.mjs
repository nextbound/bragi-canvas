import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const mainSource = readFileSync('src/main.ts', 'utf8')
const textGenSource = readFileSync('src/providers/text-gen.ts', 'utf8')
const tokenRouterSource = readFileSync('src/providers/tokenrouter.ts', 'utf8')
const modelSource = readFileSync('src/models/text-gen.ts', 'utf8')
const mcpToolRegistrySource = readFileSync('src/mcp-tool-registry.ts', 'utf8')
const capabilitiesSource = readFileSync('src/models/text-input-capabilities.ts', 'utf8')
const prepSource = readFileSync('src/text-input-prep.ts', 'utf8')
const registrySource = readFileSync('src/providers/registry.ts', 'utf8')
const dashscopeTextSource = readFileSync('src/providers/dashscope-text.ts', 'utf8')

assert.match(
	capabilitiesSource,
	/export function getTextInputCapability/,
	'capability matrix must expose getTextInputCapability',
)

assert.match(
	capabilitiesSource,
	/export function validateTextInputs/,
	'capability matrix must expose validateTextInputs',
)

assert.match(
	prepSource,
	/export async function prepareTextInputs/,
	'text input prep pipeline must expose prepareTextInputs',
)

assert.doesNotMatch(
	mainSource,
	/textProviderSupportsFileRefs/,
	'main.ts must not use coarse textProviderSupportsFileRefs gate',
)

assert.match(
	mainSource,
	/validateTextInputs\(model\.id, activeProvider/,
	'main.ts must validate text inputs before generation',
)

assert.match(
	mainSource,
	/prepareTextInputs\(this\.app, canvas, node, model\.id, activeProvider, upstream, apiModelId\)/,
	'main.ts must prepare text refs through the shared prep pipeline',
)

assert.match(
	mainSource,
	/provider\.generateText\(finalPrompt, \{ modelId: apiModelId, refImages, refVideos, refAudios, refPdfs \}\)/,
	'text generation must pass collected upstream video/audio/PDF refs to text providers',
)

assert.match(
	mcpToolRegistrySource,
	/supportedInputs: listSupportedInputLabels\(capability\)/,
	'MCP list_models must expose supportedInputs for text models',
)

assert.match(
	mcpToolRegistrySource,
	/unsupportedInputs: listUnsupportedInputLabels\(capability\)/,
	'MCP list_models must expose unsupportedInputs for text models',
)

assert.match(
	textGenSource,
	/type: 'document'/,
	'Anthropic text provider must send PDF refs as document blocks',
)

assert.match(
	textGenSource,
	/type: 'input_file'/,
	'OpenAI-compatible Responses providers must send PDF refs as input_file blocks',
)

assert.match(
	textGenSource,
	/export class XAITextProvider/,
	'xAI text provider must use Responses API directly',
)

assert.match(
	dashscopeTextSource,
	/multimodal-generation\/generation/,
	'DashScope text provider must call multimodal-generation endpoint',
)

assert.match(
	dashscopeTextSource,
	/\{ file: url \}/,
	'DashScope text provider must send PDF refs as file parts',
)

assert.match(
	modelSource,
	/dashscope: \{ apiModelId: 'qwen3\.6-plus' \}/,
	'Qwen 3.6 Plus must register DashScope provider',
)

assert.match(
	registrySource,
	/new DashScopeTextProvider\(settings\.providers\.dashscope\)/,
	'DashScope text provider must be registered in provider registry',
)

assert.match(
	registrySource,
	/new XAITextProvider\(settings\.providers\.xai\)/,
	'xAI text provider must replace OpenAI chat wrapper in registry',
)

assert.match(
	modelSource,
	/id: 'gemini-3\.5-flash'[\s\S]*gemini: \{ apiModelId: 'gemini-3\.5-flash' \}[\s\S]*tokenrouter: \{ apiModelId: 'google\/gemini-3\.5-flash' \}/,
	'Gemini 3.5 Flash must be registered for Gemini and TokenRouter',
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
	textGenSource,
	/for \(const ref of refImages\)[\s\S]*parseDataUri\(ref\)[\s\S]*fileDataPart\(ref, imageMimeTypeFromRef\(ref\), 'image'\)/,
	'Gemini text provider must preserve uploaded image URLs as fileData parts',
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

console.log('verify-text-multimodal: all static checks passed')

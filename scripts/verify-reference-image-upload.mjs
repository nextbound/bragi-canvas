import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const helperSource = readFileSync('src/providers/image-upload-prep.ts', 'utf8')
const uploadSource = readFileSync('src/providers/upload.ts', 'utf8')
const token360FlowSource = readFileSync('src/token360-asset-flow.ts', 'utf8')
const openaiSource = readFileSync('src/providers/openai.ts', 'utf8')
const tokenrouterSource = readFileSync('src/providers/tokenrouter.ts', 'utf8')
const agentSource = readFileSync('AGENT.md', 'utf8')

function assertOrder(source, first, second, message) {
	const firstIndex = source.indexOf(first)
	const secondIndex = source.indexOf(second)
	assert.notEqual(firstIndex, -1, `${message}: missing "${first}"`)
	assert.notEqual(secondIndex, -1, `${message}: missing "${second}"`)
	assert.ok(firstIndex < secondIndex, message)
}

assert.match(
	helperSource,
	/export async function prepareReferenceUpload/,
	'reference upload helper must expose the shared preparation function',
)

assert.match(
	helperSource,
	/sourceMime\.startsWith\('image\/'\)/,
	'reference upload helper must detect image uploads before applying image normalization',
)

assert.match(
	helperSource,
	/isPngOrJpeg\(sourceMime\)[\s\S]*contentType: normalizedMime/,
	'reference upload helper must pass through PNG/JPEG uploads with normalized content type',
)

assert.match(
	helperSource,
	/convertImageToPng\(bytes, sourceMime, context\)[\s\S]*contentType: 'image\/png'/,
	'reference upload helper must convert non-PNG/JPEG image uploads to PNG',
)

assert.match(
	helperSource,
	/image decode timed out/,
	'reference upload helper must fail stuck image decodes instead of leaving generation placeholders hanging',
)

assertOrder(
	uploadSource,
	'prepareReferenceUpload(fileData, fileName, contentType',
	'uploadToBragiRelay(BUILTIN_BRAGI_RELAY, prepared.bytes, prepared.fileName, prepared.contentType)',
	'Bragi Relay uploads must normalize reference images before sending bytes to the relay',
)

assert.match(
	token360FlowSource,
	/import \{ imageMimeTypeFromFileName, prepareReferenceUpload \} from '\.\/providers\/image-upload-prep'/,
	'Token360 asset flow must reuse the shared reference upload helper',
)

assert.doesNotMatch(
	token360FlowSource,
	/function (convertImageToPng|sniffImageExt|imageExtToMime)/,
	'Token360 asset flow must not keep provider-local image conversion helpers',
)

assert.match(
	openaiSource,
	/prepareReferenceUpload\([\s\S]*'OpenAI image edit upload'[\s\S]*appendFile\('image\[\]', prepared\.fileName, prepared\.contentType/,
	'OpenAI image edit multipart uploads must use the shared image normalization helper',
)

assert.match(
	tokenrouterSource,
	/prepareReferenceUpload\([\s\S]*'TokenRouter image edit upload'[\s\S]*appendMultipartFile\(parts, boundary, 'image\[\]', prepared\.fileName, prepared\.contentType/,
	'TokenRouter image edit multipart uploads must use the shared image normalization helper',
)

assert.match(
	agentSource,
	/preserve PNG\/JPEG bytes as-is and convert every other image format to PNG/,
	'AGENT.md must document the reference image upload normalization rule',
)

console.log('Reference image upload normalization checks passed.')

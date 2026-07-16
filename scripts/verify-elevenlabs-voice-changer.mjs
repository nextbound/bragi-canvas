import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const mainSource = readFileSync('src/main.ts', 'utf8')
const providerSource = readFileSync('src/providers/elevenlabs.ts', 'utf8')
const providerTypesSource = readFileSync('src/providers/types.ts', 'utf8')
const toolbarSource = readFileSync('src/toolbar.ts', 'utf8')
const stylesSource = readFileSync('src/styles.css', 'utf8')
const voiceChangerHandler = mainSource.match(/async handleVoiceChanger\(node: CanvasNode\): Promise<void> \{[\s\S]*?\n\t\}\n\n\t\/\*\*\n\t \* Speech to Text/)?.[0] || ''

function assertOrder(source, first, second, message) {
	const firstIndex = source.indexOf(first)
	const secondIndex = source.indexOf(second)
	assert.notEqual(firstIndex, -1, `${message}: missing "${first}"`)
	assert.notEqual(secondIndex, -1, `${message}: missing "${second}"`)
	assert.ok(firstIndex < secondIndex, message)
}

assert.match(
	providerTypesSource,
	/export interface VoiceChangeOptions \{[\s\S]*voiceId: string[\s\S]*audioBytes: ArrayBuffer[\s\S]*\}/,
	'Audio provider types must describe the source audio and target voice ID.',
)
assert.match(
	providerTypesSource,
	/changeVoice\?\(options: VoiceChangeOptions\): Promise<GenerateAudioResult>/,
	'Audio providers must expose Voice Changer as a capability instead of a text-to-audio mode.',
)
assert.match(
	providerSource,
	/async changeVoice\(options: VoiceChangeOptions\)[\s\S]*'audio'[\s\S]*appendMultipartField\(parts, boundary, 'model_id', modelId\)/,
	'ElevenLabs Voice Changer must send the selected source audio and speech-to-speech model as multipart fields.',
)
assert.match(
	providerSource,
	/modelId = options\.modelId \|\| 'eleven_multilingual_sts_v2'/,
	'ElevenLabs Voice Changer must default to the multilingual speech-to-speech model.',
)
assert.match(
	providerSource,
	/\/v1\/speech-to-speech\/\$\{encodeURIComponent\(options\.voiceId\)\}\?output_format=/,
	'ElevenLabs Voice Changer must address the target voice ID in the speech-to-speech endpoint.',
)
assert.match(
	providerSource,
	/return this\.saveAudio\(response\.arrayBuffer, 'voice_changer'\)/,
	'Voice Changer responses must be saved as new local audio files.',
)

assert.match(
	toolbarSource,
	/onVoiceChanger\?: \(node: CanvasNode\) => void,[\s\S]*canVoiceChanger\?: \(node: CanvasNode\) => boolean/,
	'The audio toolbar must accept a Voice Changer action and dynamic availability predicate.',
)
assert.match(
	toolbarSource,
	/enabled \? 'Voice changer' : 'Set up voice changer and connect one incoming audio'/,
	'The toolbar must use the approved active and disabled tooltip copy.',
)
assert.match(
	toolbarSource,
	/if \(!enabled\) \{[\s\S]*classList\.add\('is-disabled'\)[\s\S]*aria-disabled/,
	'The unavailable Voice Changer action must remain visible but disabled.',
)
assert.match(
	stylesSource,
	/\.bragi-voice-changer\.is-disabled[\s\S]*cursor: not-allowed/,
	'The disabled Voice Changer button must retain hover support for its requirement tooltip.',
)

assert.match(
	mainSource,
	/private canVoiceChanger\(node: CanvasNode\): boolean \{\s*if \(!this\.settings\.providers\.elevenlabs\) return false\s*return getUpstreamInputs\(getCanvasFromNode\(node\), node\)\.audios\.length === 1\s*\}/,
	'Voice Changer must require ElevenLabs and exactly one directed incoming audio reference.',
)
assert.match(
	mainSource,
	/createPlaceholderNode\(canvas, 'Voice changer', node, computeOutputSize\('audio'\)\)/,
	'Every click must immediately create a normal audio generation placeholder from the selected source node.',
)
assertOrder(
	voiceChangerHandler,
	"createPlaceholderNode(canvas, 'Voice changer', node, computeOutputSize('audio'))",
	'await applyUpstreamVoiceReference(',
	'The output placeholder must exist before voice cloning or conversion begins.',
)
assert.match(
	voiceChangerHandler,
	/applyUpstreamVoiceReference\([\s\S]*incomingAudios,[\s\S]*provider\.changeVoice\([\s\S]*audioBytes: sourceBytes/,
	'The incoming audio must supply the target voice while the selected node supplies the converted source audio.',
)
assert.match(
	voiceChangerHandler,
	/replacePlaceholderWithFile\(canvas, placeholder, result\.filePath, node\)/,
	'Each Voice Changer call must replace its own right-side placeholder with a new audio node.',
)
assert.match(
	mainSource,
	/const voiceCloneInFlight = new Map<string, Promise<VoiceCloneResult>>\(\)[\s\S]*voiceCloneInFlight\.get\(cloneKey\)[\s\S]*voiceCloneInFlight\.set\(cloneKey, clonePromise\)/,
	'Parallel conversions must share an in-flight target voice clone without serializing the conversions themselves.',
)
assert.doesNotMatch(
	mainSource,
	/(voiceChangerInFlight|isChangingVoice|changingVoiceNodes)/,
	'Voice Changer must not add a processing lock that prevents parallel clicks.',
)

const tempDir = mkdtempSync(join(tmpdir(), 'bragi-elevenlabs-voice-changer-'))
const bundledProvider = join(tempDir, 'elevenlabs-provider.mjs')
try {
	await build({
		entryPoints: ['src/providers/elevenlabs.ts'],
		outfile: bundledProvider,
		bundle: true,
		format: 'esm',
		platform: 'node',
		plugins: [{
			name: 'mock-obsidian',
			setup(buildApi) {
				buildApi.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'mock-obsidian' }))
				buildApi.onLoad({ filter: /.*/, namespace: 'mock-obsidian' }, () => ({
					contents: `
						export async function requestUrl(options) {
							process.__bragiElevenLabsRequest = options
							return { status: 200, arrayBuffer: new Uint8Array([9, 8, 7]).buffer }
						}
					`,
					loader: 'js',
				}))
			},
		}],
	})

	const { ElevenLabsProvider } = await import(pathToFileURL(bundledProvider).href)
	const writes = []
	const app = {
		vault: {
			adapter: {
				exists: async () => true,
				mkdir: async () => {},
				writeBinary: async (path, data) => writes.push({ path, data }),
			},
		},
	}
	const provider = new ElevenLabsProvider('test-key', app, '_bragi/assets')
	const result = await provider.changeVoice({
		voiceId: 'target/voice',
		modelId: 'eleven_multilingual_sts_v2',
		audioBytes: new Uint8Array([1, 2, 3, 4]).buffer,
		filename: 'source.wav',
		mimeType: 'audio/wav',
	})
	const request = process.__bragiElevenLabsRequest
	assert.equal(request.method, 'POST', 'Voice Changer must use POST.')
	assert.equal(
		request.url,
		'https://api.elevenlabs.io/v1/speech-to-speech/target%2Fvoice?output_format=mp3_44100_128',
		'Voice Changer must encode the target voice ID and request the default MP3 output.',
	)
	assert.equal(request.headers['xi-api-key'], 'test-key', 'Voice Changer must authenticate with the configured ElevenLabs key.')
	assert.match(request.headers['Content-Type'], /^multipart\/form-data; boundary=/, 'Voice Changer must send multipart audio.')
	const multipart = Buffer.from(request.body).toString('latin1')
	assert.match(multipart, /name="audio"; filename="source\.wav"\r\nContent-Type: audio\/wav/, 'Multipart audio must preserve the source filename and MIME type.')
	assert.match(multipart, /name="model_id"\r\n\r\neleven_multilingual_sts_v2/, 'Multipart audio must include the multilingual speech-to-speech model.')
	assert.equal(writes.length, 1, 'A successful response must write exactly one output file.')
	assert.match(writes[0].path, /^_bragi\/assets\/voice_changer_\d+\.mp3$/, 'The output must be a new Voice Changer MP3 asset.')
	assert.deepEqual([...new Uint8Array(writes[0].data)], [9, 8, 7], 'The provider must save the binary ElevenLabs response unchanged.')
	assert.equal(result.filePath, writes[0].path, 'The provider result must point to the saved output asset.')
} finally {
	delete process.__bragiElevenLabsRequest
	rmSync(tempDir, { recursive: true, force: true })
}

console.log('ElevenLabs Voice Changer checks passed.')

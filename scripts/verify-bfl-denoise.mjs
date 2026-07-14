import { existsSync, readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const mainSource = readFileSync('src/main.ts', 'utf8')
const panelSource = readFileSync('src/panel.ts', 'utf8')
const toolbarSource = readFileSync('src/toolbar.ts', 'utf8')
const providerSource = readFileSync('src/providers/bfl.ts', 'utf8')
const runpodSource = readFileSync('src/providers/runpod.ts', 'utf8')
const registrySource = readFileSync('src/providers/registry.ts', 'utf8')
const modelSource = readFileSync('src/models/flux.ts', 'utf8')
const modelIndexSource = readFileSync('src/models/index.ts', 'utf8')
const settingsSource = readFileSync('src/settings.ts', 'utf8')

function assertOrder(source, first, second, message) {
	const firstIndex = source.indexOf(first)
	const secondIndex = source.indexOf(second)
	assert.notEqual(firstIndex, -1, `${message}: missing "${first}"`)
	assert.notEqual(secondIndex, -1, `${message}: missing "${second}"`)
	assert.ok(firstIndex < secondIndex, message)
}

assert.match(
	modelSource,
	/id: 'flux-2-klein-9b'[\s\S]*name: 'FLUX\.2 Klein 9B'[\s\S]*type: 'image'/,
	'FLUX.2 Klein 9B must be registered as an image model.',
)
assert.match(
	modelSource,
	/bfl: \{ apiModelId: 'flux-2-klein-9b', refDelivery: \{ image: 'inline' \} \}/,
	'FLUX.2 Klein 9B must be connected to BFL with inline image references.',
)
assert.match(
	modelSource,
	/runpod: \{ apiModelId: 'flux-2-klein-9b', refDelivery: \{ image: 'inline' \} \}/,
	'FLUX.2 Klein 9B must be connected to RunPod with inline image references.',
)
assert.match(
	modelSource,
	/modes: \['text-to-image', 'image-ref-to-image'\]/,
	'FLUX.2 Klein 9B must support both normal image generation and image-ref denoise.',
)
assert.match(
	modelSource,
	/inferModeFromInputs: true/,
	'FLUX.2 Klein 9B must infer text-to-image versus image-ref mode from upstream inputs.',
)
assert.match(
	panelSource,
	/modes\.length <= 1 \|\| selectedModel\.inferModeFromInputs[\s\S]*inferMode\(modes, upstreamImageCount, upstreamVideoCount\)/,
	'The generation bar must hide inferred mode selectors while preserving upstream mode inference.',
)
assert.match(
	modelSource,
	/\{ label: '1K', value: '1024' \}[\s\S]*\{ label: '2K', value: '2048' \}[\s\S]*\{ label: '3K', value: '3072' \}[\s\S]*providerOverrides: \{[\s\S]*runpod: \{[\s\S]*options: \[[\s\S]*\{ label: '1K', value: '1024' \}[\s\S]*\{ label: '2K', value: '2048' \}/,
	'BFL must expose 1K/2K/3K while RunPod stays within its 1K/2K deployment limit.',
)
for (const hiddenParam of ['seed', 'safetyTolerance', 'outputFormat', 'enableColorMatch']) {
	assert.doesNotMatch(
		modelSource,
		new RegExp(`id: '${hiddenParam}'`),
		`${hiddenParam} must not be exposed in the FLUX.2 Klein generation bar.`,
	)
}
assert.match(
	modelSource,
	/params: \[[\s\S]*id: 'aspectRatio'[\s\S]*id: 'targetLongEdge'[\s\S]*\]/,
	'FLUX.2 Klein generation bar must retain only aspect ratio and long-edge controls.',
)
assert.match(
	modelIndexSource,
	/import \{ flux2Klein9b \} from '\.\/flux'/,
	'Model index must import the FLUX.2 Klein 9B catalog entry.',
)
assertOrder(
	modelIndexSource,
	'// Image',
	'flux2Klein9b,',
	'FLUX.2 Klein 9B must be listed in the image model catalog.',
)

assert.match(registrySource, /id: 'bfl'/, 'Provider registry must include BFL.')
assert.match(
	registrySource,
	/fields: \[\{ key: 'bfl', label: 'API Key', placeholder: 'bfl_\.\.\.', type: 'password' \}\]/,
	'BFL provider must expose an API key setting.',
)
assert.match(
	registrySource,
	/makeImage: \(\{ settings, app, outputDir \}\) =>\s*\n\s*new BflImageProvider\(settings\.providers\.bfl, app, outputDir\)/,
	'BFL provider must expose image generation.',
)
assert.match(settingsSource, /\bbfl: string\b/, 'Settings type must include a BFL key.')
assert.match(settingsSource, /\bbfl: '',/, 'Default settings must initialize the BFL key.')
assert.match(registrySource, /id: 'runpod'/, 'Provider registry must include RunPod.')
assert.match(
	registrySource,
	/fields: \[\{ key: 'runpod', label: 'API Key', placeholder: 'rpa_\.\.\.', type: 'password' \}\]/,
	'RunPod provider must expose an API key setting.',
)
assert.match(
	registrySource,
	/makeImage: \(\{ settings, app, outputDir \}\) =>\s*\n\s*new RunPodFluxImageProvider\(settings\.providers\.runpod, app, outputDir\)/,
	'RunPod provider must expose image generation.',
)
assert.match(settingsSource, /\brunpod: string\b/, 'Settings type must include a RunPod key.')
assert.match(settingsSource, /\brunpod: '',/, 'Default settings must initialize the RunPod key without committing a secret.')

assert.match(
	toolbarSource,
	/onDenoiseImage\?: \(node: CanvasNode, canvas: Canvas\) => void/,
	'Canvas menu patch must accept an image denoise callback.',
)
assert.match(
	toolbarSource,
	/if \(isImageNode\) \{[\s\S]*createMenuButton\('bragi-denoise', 'bragi-denoise', 'Denoise'/,
	'Denoise button must be injected in the image-node toolbar branch.',
)
assert.match(
	toolbarSource,
	/createMenuButton\('bragi-denoise', 'bragi-denoise', 'Denoise', \(\) => \{\s*\n\s*onDenoiseImage\(selectedNode, canvas\)/,
	'Denoise button must call the denoise callback with the selected image node.',
)
assert.match(
	toolbarSource,
	/\.bragi-denoise/,
	'Denoise toolbar elements must be cleaned up by the toolbar cleanup paths.',
)

assert.doesNotMatch(
	mainSource,
	/DenoiseImageModal/,
	'Denoise should run directly from the toolbar instead of opening the old two-choice modal.',
)
assert.match(
	mainSource,
	/\(node, activeCanvas\) => this\.openDenoiseImage\(node, activeCanvas\)/,
	'Canvas menu denoise callback must enter the one-click denoise flow.',
)
assert.match(
	mainSource,
	/openDenoiseImage\(node: CanvasNode, canvas: Canvas\): void \{\s*\n\s*void this\.handleImageDenoise\(node, canvas\)/,
	'One-click denoise must call handleImageDenoise directly.',
)
assert.doesNotMatch(
	mainSource,
	/getProvider\('bfl'\)|this\.settings\.providers\.bfl/,
	'Denoise action must not hardcode BFL as the only provider.',
)
assert.match(
	mainSource,
	/getConnectedConfiguredProviderIds\(this\.settings, model\)[\s\S]*getActiveProvider\(model, this\.settings\.modelPrefs\[model\.id\]\?\.selectedProvider, connectedProviders\)/,
	'Denoise action must resolve the current FLUX.2 Klein provider from model preferences.',
)
assert.ok(
	mainSource.includes("createPlaceholderNode(canvas, 'Denoising image…'"),
	'Denoise action must create a normal generation placeholder.',
)
assert.match(
	mainSource,
	/const colorMatchReferencePath = getOrderedImages\(canvas, node\)\[0\] \|\| ''/,
	'Denoise action must use the first ordered upstream image as the optional color-match reference.',
)
assert.match(
	mainSource,
	/const colorMatchDataUri = colorMatchReferencePath[\s\S]*await this\.readImageDataUri\(colorMatchReferencePath\)[\s\S]*: null/,
	'Denoise action must load the upstream image separately from the selected denoise input.',
)
assert.match(
	mainSource,
	/modelId: resolveApiModelId\(this\.settings, activeProvider, model\)[\s\S]*refImages: \[dataUri\][\s\S]*targetLongEdge: 2048[\s\S]*enableColorMatch: Boolean\(colorMatchDataUri\)[\s\S]*colorMatchRefImage: colorMatchDataUri \|\| undefined/,
	'Denoise action must call the selected provider with the selected image as input and the upstream image as the optional color-match reference.',
)
assert.doesNotMatch(
	mainSource,
	/seed: 297123813229487|safetyTolerance: 2|outputFormat: 'png'/,
	'Denoise action must rely on provider-owned random seed, safety, and PNG defaults.',
)
assert.match(
	mainSource,
	/if \(activeProvider === 'runpod'\) denoiseParams\.steps = 12/,
	'RunPod denoise must send steps=12.',
)
assert.match(
	mainSource,
	/replacePlaceholderWithFile\(canvas, placeholder, genResult\.filePath, node\)/,
	'Denoise action must replace the placeholder with the generated image node.',
)
assert.match(
	mainSource,
	/markNodeFailed\(placeholder, err instanceof Error \? err\.message : 'Denoise failed'\)/,
	'Denoise action must preserve the existing failed-placeholder behavior.',
)

assert.match(
	providerSource,
	/const targetLongEdge = positiveIntParam\(params\?\.targetLongEdge, DEFAULT_TARGET_LONG_EDGE\)/,
	'BFL provider must read targetLongEdge from params.',
)
assert.match(
	providerSource,
	/export function positiveIntParam\(value: unknown, fallback: number\): number/,
	'Shared FLUX image helpers must expose integer parameter parsing for RunPod.',
)
assert.match(
	providerSource,
	/const DEFAULT_SAFETY_TOLERANCE = 5[\s\S]*const outputFormat = DEFAULT_OUTPUT_FORMAT[\s\S]*const seed = randomSeed\(\)[\s\S]*safety_tolerance: DEFAULT_SAFETY_TOLERANCE[\s\S]*output_format: outputFormat/,
	'BFL must use the least restrictive safety tolerance, PNG output, and a fresh seed internally.',
)
assert.match(
	providerSource,
	/export function randomSeed\(\): number \{[\s\S]*crypto\.getRandomValues\(values\)/,
	'FLUX providers must generate a fresh random seed for every output.',
)
assert.match(
	providerSource,
	/const scale = Math\.min\(1, targetLongEdge \/ Math\.max\(pixels\.width, pixels\.height\)\)/,
	'Reference images must be resized proportionally without upscaling.',
)
assert.match(
	providerSource,
	/payload\.input_image = prepared\.base64[\s\S]*payload\.width = prepared\.width[\s\S]*payload\.height = prepared\.height/,
	'BFL image-ref calls must submit base64 input_image plus computed width and height.',
)
assert.match(
	providerSource,
	/const colorMatchRefImage = stringParam\([\s\S]*params\?\.colorMatchRefImage[\s\S]*params\?\.colorMatchReferenceImage[\s\S]*params\?\.colorMatchReference[\s\S]*params\?\.colorMatchImage/,
	'BFL provider must accept an explicit color-match reference separate from input_image.',
)
assert.match(
	providerSource,
	/let inputReferenceForColorMatch: string \| null = null[\s\S]*inputReferenceForColorMatch = prepared\.dataUri/,
	'BFL provider must preserve the old input-image fallback for regular color-match generations.',
)
assert.match(
	providerSource,
	/const referenceForColorMatch = enableColorMatch && colorMatchRefImage[\s\S]*prepareReferenceImage\(colorMatchRefImage, targetLongEdge\)[\s\S]*: inputReferenceForColorMatch/,
	'BFL provider must prefer the explicit upstream color reference when supplied.',
)
assert.match(
	providerSource,
	/if \(enableColorMatch && referenceForColorMatch\) \{[\s\S]*colorMatchImage\(referenceForColorMatch, outputBytes, mimeForOutputFormat\(extension\)\)/,
	'Color matching must run only when the user selected it and a reference image exists.',
)
assert.match(
	providerSource,
	/const output = transferRgbCovariance\(reference\.data, target\.data\)/,
	'Color matching must use the conservative initial RGB covariance transfer.',
)
assert.doesNotMatch(
	providerSource,
	/matchRgbHistograms|buildHistogramLookup|quantileValue/,
	'Color matching must not use histogram matching, which can create bright color shifts.',
)
assert.match(
	providerSource,
	/function transferRgbCovariance\(referenceData: Uint8ClampedArray, targetData: Uint8ClampedArray\): Uint8ClampedArray[\s\S]*symmetricMatrixPower3\(referenceStats\.covariance, 0\.5\)[\s\S]*symmetricMatrixPower3\(targetStats\.covariance, -0\.5\)/,
	'BFL color match must perform RGB covariance transfer.',
)
assert.match(
	providerSource,
	/function jacobiEigenSymmetric3\(matrix: number\[\]\): \{ values: \[number, number, number\]; vectors: number\[\] \}/,
	'RGB covariance transfer must include a local symmetric 3x3 eigensolver.',
)

assert.match(
	runpodSource,
	/const RUNPOD_FLUX_KLEIN_BASE_URL = 'https:\/\/api\.runpod\.ai\/v2\/27z4r9lu1eoimt'/,
	'RunPod provider must target the configured FLUX.2 Klein endpoint.',
)
assert.match(
	runpodSource,
	/body: JSON\.stringify\(\{ input \}\)/,
	'RunPod provider must wrap requests in the RunPod queue input object.',
)
assert.match(
	runpodSource,
	/headers: \{[\s\S]*'authorization': `Bearer \$\{this\.apiKey\}`/,
	'RunPod provider must authenticate with a Bearer API key.',
)
assert.match(
	runpodSource,
	/const DEFAULT_STEPS = 12[\s\S]*const steps = positiveIntParam\(params\?\.steps \|\| params\?\.step, DEFAULT_STEPS\)[\s\S]*steps,/,
	'RunPod provider must send steps=12 by default while accepting a step alias.',
)
assert.match(
	runpodSource,
	/const outputFormat = DEFAULT_OUTPUT_FORMAT[\s\S]*const seed = randomSeed\(\)[\s\S]*output_format: outputFormat/,
	'RunPod must always request PNG and generate a fresh seed internally.',
)
assert.doesNotMatch(
	runpodSource,
	/safetyTolerance|safety_tolerance|normalizeOutputFormat/,
	'RunPod must not expose or send BFL safety and output-format controls.',
)
assert.match(
	runpodSource,
	/input\.images = \[prepared\.dataUri\][\s\S]*input\.width = prepared\.width[\s\S]*input\.height = prepared\.height/,
	'RunPod image-ref calls must submit images[] plus computed width and height.',
)
assert.match(
	runpodSource,
	/extractImageOutput\(result\.output\) \|\| extractImageOutput\(result\)/,
	'RunPod provider must extract image output from the RunPod output payload.',
)
assert.match(
	runpodSource,
	/if \(enableColorMatch && referenceForColorMatch\) \{[\s\S]*colorMatchImage\(referenceForColorMatch, outputBytes/,
	'RunPod provider must apply the same local color match step after generation.',
)

const skillModelsPath = '../skill/bragi-canvas/references/models.md'
if (existsSync(skillModelsPath)) {
	const skillModelsSource = readFileSync(skillModelsPath, 'utf8')
	assert.match(skillModelsSource, /`flux-2-klein-9b`/, 'Skill model docs must mention flux-2-klein-9b.')
	assert.match(skillModelsSource, /BFL key -> FLUX\.2 Klein 9B|BFL key → FLUX\.2 Klein 9B/, 'Skill docs must mention BFL provider availability.')
}

console.log('BFL denoise checks passed.')

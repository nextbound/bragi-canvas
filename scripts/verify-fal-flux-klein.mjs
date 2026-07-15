import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const modelSource = readFileSync('src/models/flux.ts', 'utf8')
const providerSource = readFileSync('src/providers/fal.ts', 'utf8')
const mainSource = readFileSync('src/main.ts', 'utf8')
const packageSource = readFileSync('package.json', 'utf8')

assert.match(
	modelSource,
	/fal: \{ apiModelId: 'fal-ai\/flux-2\/klein\/9b', refDelivery: \{ image: 'inline' \} \}/,
	'FLUX.2 Klein 9B must connect to the fal distilled model with inline image references.',
)

assert.match(
	providerSource,
	/const FAL_FLUX_KLEIN_9B = 'fal-ai\/flux-2\/klein\/9b'/,
	'fal FLUX Klein must use the 9B distilled text-to-image endpoint.',
)
assert.match(
	providerSource,
	/const FAL_FLUX_KLEIN_9B_EDIT = .*FAL_FLUX_KLEIN_9B.*\/edit/,
	'fal FLUX Klein must use the paired distilled edit endpoint for image inputs.',
)
assert.doesNotMatch(
	providerSource,
	/fal-ai\/flux-2\/klein\/9b\/base/,
	'fal FLUX Klein must not route this test integration to the base model.',
)
assert.match(
	providerSource,
	/const FAL_FLUX_KLEIN_STEPS = 4[\s\S]*input\.num_inference_steps = FAL_FLUX_KLEIN_STEPS/,
	'fal FLUX Klein distilled generation must use its native four inference steps.',
)
assert.match(
	providerSource,
	/if \(refImages\.length > 0\) \{[\s\S]*modelId = FAL_FLUX_KLEIN_9B_EDIT[\s\S]*input\.image_urls = await Promise\.all\(refImages\.slice\(0, 4\)\.map\(uploadFalImageRef\)\)/,
	'fal FLUX Klein must route up to four original upstream images to distilled edit.',
)
assert.match(
	providerSource,
	/modelId = FAL_FLUX_KLEIN_9B[\s\S]*input\.image_size = dimensionsFromParams\(params, targetLongEdge\)/,
	'fal FLUX Klein text-to-image must honor the configured long-edge size.',
)
assert.match(
	providerSource,
	/const preparedReference = await prepareReferenceImage\(refImages\[0\], targetLongEdge\)[\s\S]*input\.image_urls = await Promise\.all\(refImages\.slice\(0, 4\)\.map\(uploadFalImageRef\)\)[\s\S]*input\.image_size = \{ width: preparedReference\.width, height: preparedReference\.height \}/,
	'fal FLUX Klein edit must upload original references while explicitly requesting the configured output size.',
)
assert.match(
	providerSource,
	/input\.output_format = 'png'[\s\S]*input\.num_images = 1/,
	'fal FLUX Klein must keep PNG output and let Bragi own batching.',
)
assert.doesNotMatch(
	providerSource,
	/input\.seed\s*=/,
	'fal FLUX Klein must omit seed so fal generates a fresh random value per output.',
)
assert.match(
	providerSource,
	/if \(enableColorMatch\) \{[\s\S]*colorMatchImage\(reference, outputBytes, mimeForOutputFormat\(ext\)\)/,
	'fal denoise must preserve local upstream color matching.',
)
assert.match(
	mainSource,
	/Connect BFL, RunPod, or fal\.ai to FLUX\.2 Klein 9B/,
	'The denoise setup notice must include fal.ai.',
)
assert.match(
	packageSource,
	/"test:fal-flux-klein": "node scripts\/verify-fal-flux-klein\.mjs"/,
	'package scripts must expose the fal FLUX Klein verification.',
)

console.log('fal FLUX Klein checks passed.')

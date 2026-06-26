import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const source = readFileSync('src/providers/svnewapi.ts', 'utf8')

assert.match(
	source,
	/const refImages: string\[\] = Array\.isArray\(params\?\.refImages\)/,
	'SV NewAPI image generation must read params.refImages.',
)

assert.match(
	source,
	/const imageUrls = await Promise\.all\(refImages\.map\(ref => uploadRefMedia\('SV NewAPI image', ref\)\)\)/,
	'SV NewAPI image generation must prepare reference images once.',
)

assert.match(
	source,
	/body\.image = imageUrls/,
	'SV NewAPI image generation must send reference images as image for seeded BytePlus Seedream.',
)

assert.match(
	source,
	/body\.image_urls = imageUrls/,
	'SV NewAPI image generation must send reference images as image_urls for seeded APIMart.',
)

assert.match(
	source,
	/url: `\$\{this\.baseUrl\}\/v1\/images\/tasks`/,
	'SV NewAPI image generation must submit via the async image task endpoint.',
)

assert.match(
	source,
	/url: `\$\{this\.baseUrl\}\/v1\/images\/tasks\/\$\{encodeURIComponent\(taskId\)\}`/,
	'SV NewAPI image generation must poll async image tasks by task id.',
)

assert.match(
	source,
	/if \(shouldFallbackToSyncImage\(resp\)\) return this\.generateImageSync\(body\)/,
	'SV NewAPI image generation must fall back to the legacy sync endpoint when async tasks are unavailable.',
)

assert.match(
	source,
	/private async generateImageSync\(body: JsonRecord\): Promise<GenerateImageResult>[\s\S]*?\/v1\/images\/generations/,
	'SV NewAPI legacy sync image path must remain available as a fallback.',
)

// Banana Pro uses the APIMart image shape: aspect-ratio `size` plus the selected
// 1k/2k/4k resolution tier.
assert.match(
	source,
	/modelId === SV_IMAGE_BANANA_PRO\)\s*\{\s*\n\s*body\.size = stringParam\(params\?\.aspectRatio, '1:1'\)\s*\n\s*const tier = stringParam\(params\?\.imageSize \?\? params\?\.resolution, '1K'\)\.toLowerCase\(\)\s*\n\s*body\.resolution = tier === 'auto' \? '1k' : tier/,
	'SV NewAPI Banana Pro must forward aspectRatio as size and imageSize/resolution as body.resolution.',
)
const bananaBranch = source.match(/modelId === SV_IMAGE_BANANA_PRO\)\s*\{([\s\S]*?)\}\s*else if \(SV_IMAGE_GPT_RE\.test\(modelId\)\)/)
assert.ok(bananaBranch, 'SV NewAPI Banana Pro branch must be present.')
assert.match(
	bananaBranch[1],
	/body\.size =/,
	'SV NewAPI Banana Pro must forward aspect-ratio size.',
)

// Seedream's Ark upstream rejects the smaller generic OpenAI sizes ("image size must be at
// least 3686400 pixels"). The gateway path must route Seedream through the Seedream size map.
assert.match(
	source,
	/resolveSeedreamImageSize\(/,
	'SV NewAPI image generation must size Seedream models via resolveSeedreamImageSize, not the generic OpenAI table.',
)

// `quality` may be forwarded ONLY for sv-gpt-image-2-official (its upstream honors it).
// Plain sv-gpt-image-2's upstream rejects the model UI's OpenAI enum ("invalid quality:
// medium"), so quality must be gated behind the official check, never set unconditionally.
assert.match(
	source,
	/modelId === SV_IMAGE_GPT_OFFICIAL\)\s*\{\s*\n\s*const quality = optionalString\(params\?\.quality\)\s*\n\s*if \(quality\) body\.quality = quality/,
	'SV NewAPI must forward quality only inside the sv-gpt-image-2-official branch.',
)

// The gpt-image-2 family on APIMart (sv-gpt-image-2 and -official) is billed per quality ×
// resolution, so it must send an aspect-ratio `size` plus a 1k/2k/4k `resolution` tier — NOT a
// derived pixel size. Lock that shape, and that the regex covers both ids.
assert.match(
	source,
	/SV_IMAGE_GPT_RE = \/\^sv-gpt-image-2\(-official\)\?\$\//,
	'SV NewAPI must match both sv-gpt-image-2 and sv-gpt-image-2-official for the APIMart size shape.',
)
assert.match(
	source,
	/SV_IMAGE_GPT_RE\.test\(modelId\)\)\s*\{[\s\S]*?body\.size = stringParam\(params\?\.aspectRatio[\s\S]*?body\.resolution =/,
	'SV NewAPI image generation must send the gpt-image-2 family as aspect-ratio size + resolution tier.',
)

const seedreamSource = readFileSync('src/providers/seedream.ts', 'utf8')
const twoKLine = seedreamSource.match(/'2K':\s*\{([^}]*)\}/)
assert.ok(twoKLine, 'Seedream SIZE map must define a 2K tier.')
const sixteenNine = twoKLine[1].match(/'16:9':\s*'(\d+)x(\d+)'/)
assert.ok(sixteenNine, 'Seedream 2K tier must define a 16:9 size.')
const pixels = Number(sixteenNine[1]) * Number(sixteenNine[2])
assert.ok(
	pixels >= 3686400,
	`Seedream 2K 16:9 must be >= 3,686,400 px to satisfy the Ark upstream minimum (got ${pixels}).`,
)

console.log('SV NewAPI image reference checks passed.')

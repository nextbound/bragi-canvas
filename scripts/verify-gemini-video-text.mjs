import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const mainSource = readFileSync('src/main.ts', 'utf8')
const textGenSource = readFileSync('src/providers/text-gen.ts', 'utf8')

assert.match(
	mainSource,
	/provider\.generateText\(finalPrompt, \{ modelId: apiModelId, refImages, refVideos \}\)/,
	'text generation must pass collected upstream videos to text providers',
)

assert.match(
	mainSource,
	/Video references for text generation are currently supported only with Google Gemini\./,
	'text generation must fail clearly when upstream videos are used with unsupported providers',
)

assert.match(
	mainSource,
	/const videoUrl = await uploadRef\(undefined, binary, `ref\.\$\{ext\}`, videoMimeType\(videoPath\)\)/,
	'Gemini text video refs must use the same relay URL upload path as video generation',
)

assert.match(
	textGenSource,
	/const refVideos = Array\.isArray\(params\?\.refVideos\) \? params\.refVideos\.filter\(\(ref\): ref is string => typeof ref === 'string'\) : \[\]/,
	'Gemini text provider must read refVideos defensively',
)

assert.match(
	textGenSource,
	/fileData: \{ mimeType: videoMimeTypeFromRef\(ref\), fileUri: ref \}/,
	'Gemini text provider must send upstream video URLs as fileData parts',
)

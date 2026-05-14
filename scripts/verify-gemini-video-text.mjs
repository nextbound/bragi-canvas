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
	textGenSource,
	/const refVideos: string\[\] = Array\.isArray\(params\?\.refVideos\) \? params\.refVideos : \[\]/,
	'Gemini text provider must read refVideos defensively',
)

assert.match(
	textGenSource,
	/for \(const dataUri of refVideos\)[\s\S]*inlineData: \{ mimeType: match\[1\], data: match\[2\] \}/,
	'Gemini text provider must send upstream videos as inlineData parts',
)

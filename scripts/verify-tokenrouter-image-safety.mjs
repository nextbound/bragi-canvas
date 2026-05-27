import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../src/providers/tokenrouter-safety.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
	compilerOptions: {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES2022,
	},
}).outputText

const sandbox = {
	module: { exports: {} },
	exports: {},
}
sandbox.exports = sandbox.module.exports
vm.runInNewContext(compiled, sandbox)

const {
	buildImageEditModerationError,
	buildImageEditSafetyRetryPrompt,
	isTokenRouterModerationError,
	shouldUseImageEditSafetyRetry,
	TOKENROUTER_IMAGE_EDIT_MODERATION_FALLBACK_MODELS,
} = sandbox.module.exports

const doraError = 'TokenRouter image edit: moderation_blocked - Your request was rejected by the safety system. safety_violations [sexual].'
const doraPrompt = 'Generate fancy outfit for her, for a dinner plan, try switch to a different color jewelry as well'

assert.equal(isTokenRouterModerationError(doraError), true)
assert.equal(shouldUseImageEditSafetyRetry(doraPrompt), true)
assert.equal(shouldUseImageEditSafetyRetry('Generate a cinematic forest background'), false)

const safePrompt = buildImageEditSafetyRetryPrompt(doraPrompt)
assert.match(safePrompt, /adult character/)
assert.match(safePrompt, /opaque fabric/)
assert.match(safePrompt, /covered chest and shoulders/)
assert.equal(buildImageEditSafetyRetryPrompt(safePrompt), safePrompt)

const enhancedError = buildImageEditModerationError(doraError, ['TokenRouter image chat: fallback failed'])
assert.match(enhancedError, /neutral adult-character prompt/)
assert.match(enhancedError, /Fallback attempts also failed/)

assert.equal(JSON.stringify(TOKENROUTER_IMAGE_EDIT_MODERATION_FALLBACK_MODELS), JSON.stringify([
	'google/gemini-3-pro-image-preview',
	'google/gemini-3.1-flash-image-preview',
]))

console.log('tokenrouter image safety checks passed')

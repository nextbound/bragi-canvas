import assert from 'node:assert/strict'
import { testRuntime } from './test-runtime.mjs'

const runtime = await testRuntime('export { DashScopeAudioProvider } from "./src/providers/dashscope"')
const requests = []
globalThis.__request = async (request) => {
	requests.push(request)
	return { status: 200, json: { output: { voice: 'qwen-designed', voice_id: 'cosy-designed' } } }
}

try {
	const provider = new runtime.module.DashScopeAudioProvider('test-key', {}, 'assets', 'https://example.com/api/v1')
	async function design(modelId, previewText) {
		const options = { modelId, previewText, voicePrompt: 'A calm narrator.', promptHash: 'preview-test' }
		const before = { ...options }
		const result = await provider.designVoice(options)
		assert.deepEqual(options, before, 'Only the outgoing preview may change')
		const request = requests.at(-1)
		assert.equal(request.url, 'https://example.com/api/v1/services/audio/tts/customization')
		const body = JSON.parse(request.body)
		assert.equal(body.input.voice_prompt, options.voicePrompt)
		assert.equal(body.input.target_model, modelId)
		assert.deepEqual(body.parameters, { sample_rate: 24000, response_format: 'wav' })
		assert.equal(result.voiceId, modelId.startsWith('qwen') ? 'qwen-designed' : 'cosy-designed')
		return body
	}

	for (const [modelId, limit, enrollmentModel, action] of [
		['cosyvoice-v3.5-plus', 200, 'voice-enrollment', 'create_voice'],
		['cosyvoice-v3.5-flash', 200, 'voice-enrollment', 'create_voice'],
		['qwen3-tts-vd-realtime-2026-01-15', 1024, 'qwen-voice-design', 'create'],
	]) {
		const qwen = modelId.startsWith('qwen')
		const short = await design(modelId, '  Hello\n\tthere.  ')
		assert.equal(short.input.preview_text, 'Hello there.')
		assert.equal(short.model, enrollmentModel)
		assert.equal(short.input.action, action)
		assert.deepEqual(qwen ? short.input.language : short.input.language_hints, qwen ? 'en' : ['en'])
		assert.ok(!((qwen ? 'language_hints' : 'language') in short.input))
		for (const size of [limit - 1, limit, limit + 1, limit * 2]) {
			const body = await design(modelId, 'a'.repeat(size))
			assert.equal(body.input.preview_text, 'a'.repeat(Math.min(size, limit)))
		}
		const unicode = await design(modelId, 'a'.repeat(limit - 1) + '🎹tail')
		assert.equal(unicode.input.preview_text, 'a'.repeat(limit - 1) + '🎹', 'Do not split a surrogate pair')
		const trailingSpace = await design(modelId, 'a'.repeat(limit - 1) + ' more')
		assert.equal(trailingSpace.input.preview_text, 'a'.repeat(limit - 1))
		const hanSample = String.fromCodePoint(0x4e00).repeat(5)
		const han = await design(modelId, hanSample)
		assert.deepEqual(qwen ? han.input.language : han.input.language_hints, qwen ? 'zh' : ['zh'])
		const unknown = await design(modelId, '123 🎹 !')
		assert.ok(!('language' in unknown.input) && !('language_hints' in unknown.input))
	}

	globalThis.__request = async () => ({ status: 400, json: { message: 'Provider rejected the preview' } })
	await assert.rejects(provider.designVoice({ modelId: 'cosyvoice-v3.5-plus', previewText: 'Hello', voicePrompt: 'Calm', promptHash: 'test' }), /Provider rejected the preview/)
	console.log('DashScope voice-design request limits, Unicode, language hints and errors passed.')
} finally {
	delete globalThis.__request
	await runtime.cleanup()
}

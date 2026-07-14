import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const tempDir = await mkdtemp(join(tmpdir(), 'bragi-kling-omni-'))
const bundlePath = join(tempDir, 'payload.mjs')

try {
	await build({
		entryPoints: ['src/providers/kling-omni-payload.ts'],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile: bundlePath,
		logLevel: 'silent',
	})
	const { buildOfficialKlingOmniRequest, buildApimartKlingOmniRequest } = await import(`${pathToFileURL(bundlePath).href}?t=${Date.now()}`)

	const officialFrames = buildOfficialKlingOmniRequest('A slow camera push', {
		genMode: 'first-last-frame',
		refImages: ['https://refs/first.png', 'https://refs/last.png'],
		duration: 6,
		mode: 'pro',
		sound: 'on',
	})
	assert.equal(officialFrames.model_name, 'kling-v3-omni')
	assert.equal(officialFrames.duration, '6')
	assert.equal(officialFrames.aspect_ratio, undefined)
	assert.deepEqual(officialFrames.image_list, [
		{ image_url: 'https://refs/first.png', type: 'first_frame' },
		{ image_url: 'https://refs/last.png', type: 'end_frame' },
	])
	const officialFirstFrame = buildOfficialKlingOmniRequest('Begin from this frame', {
		genMode: 'first-frame',
		refImages: ['https://refs/first.png'],
	})
	assert.deepEqual(officialFirstFrame.image_list, [{ image_url: 'https://refs/first.png', type: 'first_frame' }])
	assert.equal(officialFirstFrame.aspect_ratio, undefined)

	const officialRefs = buildOfficialKlingOmniRequest('Let them meet', {
		genMode: 'image-ref',
		refImages: ['https://refs/1.png', 'https://refs/2.png', 'https://refs/3.png'],
		duration: 15,
		aspect_ratio: '9:16',
		mode: '4k',
		sound: 'on',
		multi_shot: true,
	})
	assert.match(officialRefs.prompt, /<<<image_1>>> <<<image_2>>> <<<image_3>>>/)
	assert.equal(officialRefs.mode, '4k')
	assert.equal(officialRefs.sound, 'on')
	assert.equal(officialRefs.multi_shot, true)
	assert.equal(officialRefs.shot_type, 'intelligence')

	const officialFeature = buildOfficialKlingOmniRequest('Continue the move', {
		genMode: 'video-ref',
		refImages: ['https://refs/look.png'],
		refVideos: ['https://refs/motion.mp4'],
		keep_original_sound: 'yes',
	})
	assert.match(officialFeature.prompt, /<<<image_1>>>/)
	assert.match(officialFeature.prompt, /<<<video_1>>>/)
	assert.equal(officialFeature.sound, 'off')
	assert.deepEqual(officialFeature.video_list, [{
		video_url: 'https://refs/motion.mp4',
		refer_type: 'feature',
		keep_original_sound: 'yes',
	}])

	const officialEdit = buildOfficialKlingOmniRequest('Replace the sky', {
		genMode: 'video-edit',
		refVideos: ['https://refs/base.mp4'],
		keep_original_sound: 'yes',
		duration: 12,
	})
	assert.equal(officialEdit.duration, undefined)
	assert.equal(officialEdit.aspect_ratio, undefined)
	assert.equal(officialEdit.sound, 'off')
	assert.equal(officialEdit.multi_shot, false)

	const apimartRefs = buildApimartKlingOmniRequest('Use both locations', {
		genMode: 'image-ref',
		refImages: ['https://refs/1.png', 'https://refs/2.png'],
		duration: 7,
		aspect_ratio: '1:1',
		mode: 'pro',
		sound: 'on',
		negative_prompt: 'blur',
	})
	assert.equal(apimartRefs.model, 'kling-v3-omni')
	assert.equal(apimartRefs.duration, 7)
	assert.equal(typeof apimartRefs.duration, 'number')
	assert.equal(apimartRefs.audio, true)
	assert.equal(apimartRefs.negative_prompt, 'blur')
	assert.deepEqual(apimartRefs.image_urls, ['https://refs/1.png', 'https://refs/2.png'])
	assert.match(apimartRefs.prompt, /<<<image_1>>> <<<image_2>>>/)

	const apimartFrames = buildApimartKlingOmniRequest('Move between frames', {
		genMode: 'first-last-frame',
		refImages: ['https://refs/first.png', 'https://refs/last.png'],
	})
	assert.deepEqual(apimartFrames.image_with_roles, [
		{ url: 'https://refs/first.png', role: 'first_frame' },
		{ url: 'https://refs/last.png', role: 'last_frame' },
	])
	assert.equal(apimartFrames.aspect_ratio, undefined)
	const apimartFirstFrame = buildApimartKlingOmniRequest('Begin from this frame', {
		genMode: 'first-frame',
		refImages: ['https://refs/first.png'],
	})
	assert.deepEqual(apimartFirstFrame.image_with_roles, [{ url: 'https://refs/first.png', role: 'first_frame' }])

	const apimartAdvanced = buildApimartKlingOmniRequest('Custom sequence', {
		genMode: 'text-to-video',
		duration: 6,
		multi_shot: true,
		shot_type: 'customize',
		multi_prompt: [
			{ index: 1, prompt: 'Wide shot', duration: 3 },
			{ index: 2, prompt: 'Close shot', duration: 3 },
		],
		element_list: [{ name: 'element_crane', description: 'paper crane', element_input_urls: ['https://refs/1.png', 'https://refs/2.png'] }],
	})
	assert.equal(apimartAdvanced.multi_shot, true)
	assert.equal(apimartAdvanced.shot_type, 'customize')
	assert.equal(apimartAdvanced.multi_prompt.length, 2)
	assert.equal(apimartAdvanced.element_list.length, 1)

	const apimartEdit = buildApimartKlingOmniRequest('Remove the sign', {
		genMode: 'video-edit',
		refVideos: ['https://refs/base.mp4'],
	})
	assert.equal(apimartEdit.duration, undefined)
	assert.equal(apimartEdit.audio, undefined)
	assert.deepEqual(apimartEdit.video_list, [{
		video_url: 'https://refs/base.mp4',
		refer_type: 'base',
		keep_original_sound: 'no',
	}])

	assert.throws(
		() => buildApimartKlingOmniRequest('Bad duration', { genMode: 'text-to-video', duration: 16 }),
		/duration must be a whole number from 3 to 15/,
	)
	assert.throws(
		() => buildOfficialKlingOmniRequest('Missing frame', { genMode: 'first-last-frame', refImages: ['https://refs/first.png'] }),
		/requires exactly two images/,
	)

	const [klingProvider, apimartProvider, modelCatalog, mainSource] = await Promise.all([
		readFile('src/providers/kling.ts', 'utf8'),
		readFile('src/providers/apimart.ts', 'utf8'),
		readFile('src/models/kling.ts', 'utf8'),
		readFile('src/main.ts', 'utf8'),
	])
	assert.match(klingProvider, /OMNI_BASE_URLS = \[BASE_URL, 'https:\/\/api-beijing\.klingai\.com'\]/)
	assert.match(klingProvider, /OMNI_BASE_URLS\.map\(baseUrl => `\$\{baseUrl\}\/v1\/videos\/omni-video\/\$\{taskId\}`\)/)
	assert.match(apimartProvider, /modelId === KLING_OMNI_MODEL_ID/)
	assert.match(modelCatalog, /id: 'kling-3\.0-omni'/)
	assert.match(modelCatalog, /kling: \{ apiModelId: 'kling-v3-omni' \}/)
	assert.match(modelCatalog, /apimart: \{ apiModelId: 'kling-v3-omni' \}/)
	assert.match(modelCatalog, /id: 'multi_shot'[\s\S]*?label: 'Shots'[\s\S]*?label: 'Multi shots', value: 'true'[\s\S]*?default: 'true'/)
	assert.match(modelCatalog, /label: 'Audio Off', value: 'off'/)
	assert.match(modelCatalog, /label: 'Audio On', value: 'on'/)
	assert.match(mainSource, /supportsKlingOmniVideoRef/)

	console.log('Kling 3.0 Omni payload and provider wiring checks passed.')
} finally {
	await rm(tempDir, { recursive: true, force: true })
}

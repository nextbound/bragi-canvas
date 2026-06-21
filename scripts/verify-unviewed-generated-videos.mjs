import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'

const tempDir = await mkdtemp(path.join(tmpdir(), 'bragi-unviewed-video-'))
const outfile = path.join(tempDir, 'unviewed-generated-videos.mjs')

try {
	await esbuild.build({
		entryPoints: ['src/unviewed-generated-videos.ts'],
		bundle: true,
		platform: 'node',
		format: 'esm',
		outfile,
		logLevel: 'silent',
	})

	const state = await import(pathToFileURL(outfile).href)
	const {
		MAX_UNVIEWED_GENERATED_VIDEOS,
		isVideoMediaPath,
		markGeneratedVideoUnviewed,
		markGeneratedVideoViewed,
		pruneUnviewedGeneratedVideos,
	} = state

	for (const filePath of ['clip.mp4', 'clip.MOV', 'folder/clip.webm', 'folder/clip.mkv', 'folder/clip.m4v']) {
		assert.equal(isVideoMediaPath(filePath), true, `${filePath} should be a video`)
	}
	for (const filePath of ['image.png', 'audio.mp3', 'clip.avi', 'clip.mp4.backup', '']) {
		assert.equal(isVideoMediaPath(filePath), false, `${filePath} should not be treated as a tracked video`)
	}

	const initial = ['old-a.mp4', 'old-b.mov']
	assert.deepEqual(markGeneratedVideoUnviewed(initial, 'new.webm'), ['new.webm', 'old-a.mp4', 'old-b.mov'])
	assert.deepEqual(markGeneratedVideoUnviewed(['old-a.mp4', 'old-b.mov'], 'old-b.mov'), ['old-b.mov', 'old-a.mp4'])

	const nonVideoInput = ['old-a.mp4']
	assert.equal(markGeneratedVideoUnviewed(nonVideoInput, 'image.png'), nonVideoInput)

	const cappedInput = Array.from({ length: MAX_UNVIEWED_GENERATED_VIDEOS + 5 }, (_, index) => `clip-${index}.mp4`)
	const cappedOutput = markGeneratedVideoUnviewed(cappedInput, 'newest.mp4')
	assert.equal(cappedOutput.length, MAX_UNVIEWED_GENERATED_VIDEOS)
	assert.equal(cappedOutput[0], 'newest.mp4')
	assert.equal(cappedOutput.includes('clip-1004.mp4'), false)

	assert.deepEqual(markGeneratedVideoViewed(['a.mp4', 'b.mp4', 'c.mp4'], 'b.mp4'), ['a.mp4', 'c.mp4'])
	assert.deepEqual(markGeneratedVideoViewed(['a.mp4', 'b.mp4'], 'missing.mp4'), ['a.mp4', 'b.mp4'])

	assert.deepEqual(
		pruneUnviewedGeneratedVideos(['a.mp4', 'b.mov', 'c.webm'], ['b.mov', 'unused.png']),
		['a.mp4', 'c.webm'],
	)

	console.log('unviewed generated video state ok')
} finally {
	await rm(tempDir, { recursive: true, force: true })
}

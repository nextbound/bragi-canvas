import type { Mode } from './models/types'

export function inferMode(modes: Mode[], imageCount: number, videoCount: number, audioCount = 0, audioOnlyVideoRef = false): Mode {
	// Audio refs are multimodal references, never first/last-frame controls.
	if (audioOnlyVideoRef && audioCount > 0 && imageCount === 0 && videoCount === 0 && modes.includes('video-ref')) return 'video-ref'
	if (audioCount > 0 && videoCount > 0 && modes.includes('video-ref')) return 'video-ref'
	if (audioCount > 0 && imageCount > 0 && modes.includes('image-ref')) return 'image-ref'

	// Image + video upstream → Kling Motion Control (character image + motion clip)
	if (imageCount > 0 && videoCount > 0 && modes.includes('motion-control')) return 'motion-control'

	// Video upstream → reference or extend
	if (videoCount > 0 && modes.includes('video-to-music')) return 'video-to-music'
	if (videoCount > 0 && modes.includes('video-ref')) return 'video-ref'
	if (videoCount > 0 && modes.includes('video-extend')) return 'video-extend'
	if (videoCount > 0 && modes.includes('video-edit')) return 'video-edit'

	// 3+ images cannot be a first/last-frame pair; prefer a reference mode.
	if (imageCount > 2) {
		if (modes.includes('multi-image-ref')) return 'multi-image-ref'
		if (modes.includes('image-ref')) return 'image-ref'
	}

	// 2 images → prefer first-last-frame, then multi-ref, then image-ref
	if (imageCount >= 2) {
		if (modes.includes('first-last-frame')) return 'first-last-frame'
		if (modes.includes('multi-image-ref')) return 'multi-image-ref'
		if (modes.includes('image-ref')) return 'image-ref'
		if (modes.includes('image-ref-to-image')) return 'image-ref-to-image'
	}

	// 1 image → prefer first-frame, then image-ref (video), then image-ref-to-image (image)
	if (imageCount === 1) {
		if (modes.includes('first-frame')) return 'first-frame'
		if (modes.includes('image-ref')) return 'image-ref'
		if (modes.includes('image-ref-to-image')) return 'image-ref-to-image'
	}

	// No special inputs → text-to-video/image/text
	if (modes.includes('text-to-video')) return 'text-to-video'
	if (modes.includes('text-to-image')) return 'text-to-image'
	if (modes.includes('text-to-text')) return 'text-to-text'

	return modes[0]
}

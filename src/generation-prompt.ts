import type { Mode } from './models/types'

/** Only image-led modes documented to work without instructions may omit the prompt. */
export function allowsEmptyPrompt(modelId: string | undefined, mode: Mode | null, imageCount: number, audioVideoCount: number, pdfCount: number): boolean {
	if (pdfCount) return false
	if (modelId === 'magi-2') {
		if (mode === 'reference-to-video') return imageCount + audioVideoCount > 0
		if (mode === 'first-last-frame') return imageCount === 2 && audioVideoCount === 0
	}
	return (modelId === 'vidu-q4-preview' || modelId === 'magi-2') && mode === 'first-frame' && imageCount === 1 && audioVideoCount === 0
}

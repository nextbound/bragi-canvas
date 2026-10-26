import type { Mode } from './models/types'

/** Only image-led modes documented to work without instructions may omit the prompt. */
export function allowsEmptyPrompt(modelId: string | undefined, mode: Mode | null, imageCount: number, otherMediaCount: number): boolean {
	return modelId === 'vidu-q4-preview' && mode === 'first-frame' && imageCount === 1 && otherMediaCount === 0
}

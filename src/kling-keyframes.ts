export interface KlingKeyframe {
	image: number
	role: 'first_frame' | 'keyframe' | 'last_frame'
	description: string
	line: number
}

/** Parse Bragi's frame notation before uploading or submitting any media. */
export function parseKlingKeyframes(prompt: string, imageCount: number): { frames: KlingKeyframe[]; prompt: string } {
	const lines = prompt.split(/\r?\n/)
	const opens = lines.flatMap((line, i) => line.trim().toLowerCase() === '[keyframes]' ? [i] : [])
	const closes = lines.flatMap((line, i) => line.trim().toLowerCase() === '[/keyframes]' ? [i] : [])
	if (opens.length !== 1 || closes.length !== 1 || closes[0] <= opens[0]) {
		throw new Error('Keyframes requires exactly one [Keyframes] ... [/Keyframes] block.')
	}
	const frames: KlingKeyframe[] = []
	for (let i = opens[0] + 1; i < closes[0]; i++) {
		const line = lines[i].trim()
		if (!line) continue
		const match = line.match(/^(\[)?@Image([1-9]\d*)(\])?\s*[:：]\s*(.*)$/i)
		if (!match || Boolean(match[1]) !== Boolean(match[3])) throw new Error(`Keyframes line ${i + 1}: use @Image1: description, or [@Image1]: description for the last frame.`)
		if (frames.some(frame => frame.role === 'last_frame')) throw new Error(`Keyframes line ${i + 1}: only one last frame is allowed, and it must be the final entry.`)
		const image = Number(match[2])
		if (image > imageCount) throw new Error(`Keyframes line ${i + 1}: @Image${image} is not connected; there are ${imageCount} images.`)
		if (frames.length === 0 && match[1]) throw new Error(`Keyframes line ${i + 1}: the first entry must be an unbracketed first frame.`)
		frames.push({ image, role: match[1] ? 'last_frame' : frames.length === 0 ? 'first_frame' : 'keyframe', description: match[4], line: i + 1 })
	}
	if (!frames.length) throw new Error('Keyframes requires a first-frame entry.')
	if (frames.length > 10 || frames.filter(frame => frame.role === 'keyframe').length > 8) throw new Error('Keyframes supports up to eight intermediate frames and ten frame entries in total.')
	const positions = new Map<number, number>()
	frames.forEach((frame, i) => { if (!positions.has(frame.image)) positions.set(frame.image, i + 1) })
	const remap = (text: string) => text.replace(/@Image([1-9]\d*)\b/gi, (_token, number: string) => {
		const position = positions.get(Number(number))
		if (!position) throw new Error(`@Image${number} is mentioned in the prompt but is not listed in [Keyframes].`)
		return `@Image${position}`
	})
	const descriptions = frames.flatMap((frame, i) => frame.description.trim() ? [`@Image${i + 1}: ${remap(frame.description.trim())}`] : [])
	const remainder = remap([...lines.slice(0, opens[0]), ...lines.slice(closes[0] + 1)].join('\n').trim())
	return { frames, prompt: [...descriptions, remainder].filter(Boolean).join('\n') }
}

export function keyframeTemplate(imageCount: number): string {
	return ['[Keyframes]', ...Array.from({ length: Math.min(Math.max(imageCount, 1), 10) }, (_, i) => imageCount >= 10 && i === 9 ? `[@Image${i + 1}]:` : `@Image${i + 1}:`), '[/Keyframes]'].join('\n')
}

/** A changed thumbnail order must never silently change an existing frame reference. */
export function assertKeyframeBindings(prompt: string, images: string[], saved: unknown): void {
	const { frames } = parseKlingKeyframes(prompt, images.length)
	if (!Array.isArray(saved)) return
	for (const { image } of frames) {
		if (saved[image - 1] !== images[image - 1]) throw new Error(`@Image${image} has changed. Review the thumbnails and use "Bind image numbers" before generating.`)
	}
}

export function kling4PromptOptional(modelId: string, mode: string | null | undefined): boolean {
	return modelId === 'kling-4.0' && (mode === 'first-frame' || mode === 'first-last-frame' || mode === 'keyframes')
}

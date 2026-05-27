const MODERATION_ERROR_TERMS = [
	'moderation_blocked',
	'safety_violations',
	'content_policy',
	'policy violation',
	'rejected by the safety system',
]

const WARDROBE_PROMPT_TERMS = [
	'clothing',
	'clothes',
	'costume',
	'dress',
	'gown',
	'jewelry',
	'outfit',
	'robe',
	'wardrobe',
	'wear',
	'wearing',
	'服装',
	'衣服',
	'换装',
	'礼服',
	'裙',
	'珠宝',
	'首饰',
	'造型',
]

const SAFETY_RETRY_MARKER = '[Safety boundary for image edit]'

export const TOKENROUTER_IMAGE_EDIT_MODERATION_FALLBACK_MODELS = [
	'google/gemini-3-pro-image-preview',
	'google/gemini-3.1-flash-image-preview',
]

export function isTokenRouterModerationError(message: string): boolean {
	const normalized = message.toLowerCase()
	return MODERATION_ERROR_TERMS.some(term => normalized.includes(term))
}

export function shouldUseImageEditSafetyRetry(prompt: string): boolean {
	const normalized = prompt.toLowerCase()
	return WARDROBE_PROMPT_TERMS.some(term => normalized.includes(term))
}

export function buildImageEditSafetyRetryPrompt(prompt: string): string {
	if (prompt.includes(SAFETY_RETRY_MARKER)) return prompt
	return `${prompt.trim()}

${SAFETY_RETRY_MARKER}
Treat the person in the reference image as an adult character. Keep the edit non-erotic, formal, and modest.
For wardrobe changes, prefer a high or square neckline, covered chest and shoulders, opaque fabric, and an elegant full-length silhouette.
Do not reduce clothing coverage, do not use transparent fabric, and do not emphasize bust, exposed skin, or lingerie-like styling.
Preserve the same identity, hairstyle, makeup, pose, and clean fashion reference layout.`
}

export function buildImageEditModerationError(primaryError: string, fallbackErrors: string[] = []): string {
	const fallbackDetail = fallbackErrors.length > 0
		? ` Fallback attempts also failed: ${fallbackErrors.join(' | ')}`
		: ''
	return `${primaryError}${fallbackDetail}

For wardrobe image edits, use a neutral adult-character prompt with explicit modest coverage, opaque fabric, and formal styling. Avoid ambiguous family words like "daughter" or "girl" in the prompt.`
}

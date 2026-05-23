import { getModelById } from './index'

export type TextInputKind = 'image' | 'pdf' | 'video' | 'audio'

export interface TextInputCapability {
	kinds: TextInputKind[]
	maxImages?: number
	maxPdfs?: number
	maxVideos?: number
	maxAudios?: number
	maxPdfBytes?: number
}

export interface TextInputCounts {
	images: number
	pdfs: number
	videos: number
	audios: number
}

const IMAGE_PDF: TextInputKind[] = ['image', 'pdf']
const FULL_MULTIMODAL: TextInputKind[] = ['image', 'pdf', 'video', 'audio']
const IMAGE_ONLY: TextInputKind[] = ['image']

const PROVIDER_DEFAULTS: Record<string, TextInputCapability> = {
	openai: { kinds: IMAGE_PDF, maxPdfBytes: 50 * 1024 * 1024 },
	anthropic: { kinds: IMAGE_PDF, maxPdfs: 5, maxPdfBytes: 32 * 1024 * 1024 },
	bedrock: { kinds: IMAGE_PDF, maxPdfs: 5, maxPdfBytes: 32 * 1024 * 1024 },
	gemini: { kinds: FULL_MULTIMODAL, maxVideos: 1, maxAudios: 1, maxImages: 10 },
	xai: { kinds: IMAGE_PDF, maxPdfBytes: 48 * 1024 * 1024 },
	apimart: { kinds: IMAGE_PDF, maxPdfBytes: 50 * 1024 * 1024 },
	dashscope: { kinds: ['image', 'pdf', 'video', 'audio'], maxVideos: 64 },
}

function tokenRouterCapability(apiModelId: string): TextInputCapability {
	const slug = apiModelId.toLowerCase()
	if (slug.startsWith('google/') || slug.includes('gemini')) {
		return { kinds: FULL_MULTIMODAL, maxVideos: 1, maxAudios: 1, maxImages: 10 }
	}
	if (slug.startsWith('qwen/') || slug.includes('qwen3')) {
		return { kinds: ['image', 'pdf', 'video', 'audio'], maxVideos: 64 }
	}
	if (slug.startsWith('anthropic/') || slug.startsWith('openai/') || slug.startsWith('x-ai/') || slug.startsWith('xai/')) {
		return { kinds: IMAGE_PDF, maxPdfBytes: 50 * 1024 * 1024 }
	}
	return { kinds: FULL_MULTIMODAL }
}

export function getTextInputCapability(
	modelId: string,
	providerId: string,
	apiModelId?: string,
): TextInputCapability {
	if (providerId === 'tokenrouter') {
		const model = getModelById(modelId)
		const slug = apiModelId || model?.supportedProviders.tokenrouter?.apiModelId || ''
		return tokenRouterCapability(slug)
	}

	const base = PROVIDER_DEFAULTS[providerId]
	if (!base) return { kinds: IMAGE_ONLY }

	if (providerId === 'gemini' || providerId === 'dashscope') {
		return base
	}

	return base
}

export function textInputKindSupported(
	capability: TextInputCapability,
	kind: TextInputKind,
): boolean {
	return capability.kinds.includes(kind)
}

export function listSupportedInputLabels(capability: TextInputCapability): string[] {
	const labels = ['text']
	if (capability.kinds.includes('image')) labels.push('image')
	if (capability.kinds.includes('pdf')) labels.push('pdf')
	if (capability.kinds.includes('video')) labels.push('video')
	if (capability.kinds.includes('audio')) labels.push('audio')
	return labels
}

export function listUnsupportedInputLabels(capability: TextInputCapability): string[] {
	const all = ['image', 'pdf', 'video', 'audio'] as const
	return all.filter(kind => !capability.kinds.includes(kind))
}

function kindLabel(kind: TextInputKind): string {
	if (kind === 'pdf') return 'PDF'
	if (kind === 'audio') return 'audio'
	if (kind === 'video') return 'video'
	return 'image'
}

function providerLabel(providerId: string): string {
	const labels: Record<string, string> = {
		openai: 'OpenAI',
		anthropic: 'Anthropic',
		bedrock: 'AWS Bedrock',
		gemini: 'Google Gemini',
		xai: 'xAI',
		apimart: 'APIMart',
		tokenrouter: 'TokenRouter',
		dashscope: 'DashScope',
	}
	return labels[providerId] || providerId
}

export function validateTextInputs(
	modelId: string,
	providerId: string,
	counts: TextInputCounts,
	apiModelId?: string,
): void {
	const capability = getTextInputCapability(modelId, providerId, apiModelId)
	const model = getModelById(modelId)
	const modelName = model?.name || modelId

	const checks: Array<{ kind: TextInputKind; count: number; max?: number }> = [
		{ kind: 'image', count: counts.images, max: capability.maxImages },
		{ kind: 'pdf', count: counts.pdfs, max: capability.maxPdfs },
		{ kind: 'video', count: counts.videos, max: capability.maxVideos },
		{ kind: 'audio', count: counts.audios, max: capability.maxAudios },
	]

	for (const { kind, count, max } of checks) {
		if (count <= 0) continue
		if (!textInputKindSupported(capability, kind)) {
			throw new Error(
				`${modelName} via ${providerLabel(providerId)} does not support upstream ${kindLabel(kind)} for text generation.`,
			)
		}
		if (max !== undefined && count > max) {
			throw new Error(
				`${modelName} via ${providerLabel(providerId)} supports up to ${max} upstream ${kindLabel(kind)} file${max === 1 ? '' : 's'}.`,
			)
		}
	}
}

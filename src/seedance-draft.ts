/** Providers that implement the Seedance 2.5 draft -> final flow. A draft is only valid on the provider that created it. */
export const SEEDANCE_DRAFT_PROVIDERS = ['byteplus', 'svnewapi'] as const
export type SeedanceDraftProviderId = typeof SEEDANCE_DRAFT_PROVIDERS[number]

export function isSeedanceDraftProvider(value: unknown): value is SeedanceDraftProviderId {
	return (SEEDANCE_DRAFT_PROVIDERS as readonly unknown[]).includes(value)
}

/** Stored with the accepted task, then copied to its completed video node. */
export interface SeedanceDraftMetadata {
	providerId: SeedanceDraftProviderId
	modelId: 'seedance-2.5'
	taskId: string
	apiModelId: string
	createdAt: number
	outputFormat: 'mp4' | 'mov'
}

export function decodeSeedanceDraft(value: unknown): SeedanceDraftMetadata | null {
	if (!value || typeof value !== 'object') return null
	const data = value as Record<string, unknown>
	if (!isSeedanceDraftProvider(data.providerId) || data.modelId !== 'seedance-2.5'
		|| typeof data.taskId !== 'string' || !data.taskId.trim()
		|| typeof data.apiModelId !== 'string' || !data.apiModelId.trim()
		|| typeof data.createdAt !== 'number' || !Number.isFinite(data.createdAt) || data.createdAt < 0
		|| (data.outputFormat !== 'mp4' && data.outputFormat !== 'mov')) return null
	return {
		providerId: data.providerId, modelId: data.modelId, taskId: data.taskId,
		apiModelId: data.apiModelId, createdAt: data.createdAt, outputFormat: data.outputFormat,
	}
}

export function getSeedanceDraft(nodeData: unknown): SeedanceDraftMetadata | null {
	if (!nodeData || typeof nodeData !== 'object') return null
	const data = nodeData as Record<string, unknown>
	if (data.type !== 'file' || typeof data.file !== 'string' || !/\.(mp4|mov|webm)$/i.test(data.file)) return null
	return decodeSeedanceDraft(data.bragiSeedanceDraft)
}

export function canFinalizeSeedanceDraft(nodeData: unknown, activeProvider: string | null): boolean {
	const draft = getSeedanceDraft(nodeData)
	return draft !== null && draft.providerId === activeProvider
}

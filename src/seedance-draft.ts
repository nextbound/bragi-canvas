/** Stored with the accepted task, then copied to its completed video node. */
export interface SeedanceDraftMetadata {
	providerId: 'byteplus'
	modelId: 'seedance-2.5'
	taskId: string
	apiModelId: string
	createdAt: number
	outputFormat: 'mp4' | 'mov'
}

export function decodeSeedanceDraft(value: unknown): SeedanceDraftMetadata | null {
	if (!value || typeof value !== 'object') return null
	const data = value as Record<string, unknown>
	if (data.providerId !== 'byteplus' || data.modelId !== 'seedance-2.5'
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
	return activeProvider === 'byteplus' && getSeedanceDraft(nodeData) !== null
}

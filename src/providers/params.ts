export function stringParam(value: unknown, fallback: string): string {
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	return fallback
}

export function optionalStringParam(value: unknown): string | undefined {
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean') return String(value)
	return undefined
}

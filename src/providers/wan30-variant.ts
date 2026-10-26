export const WAN30_STANDARD = 'wan3.0-video'
export const WAN30_PRIME = 'wan3.0-video-prime'

export function resolveWan30ApiModelId(variant: unknown = 'standard'): string {
	if (variant === 'standard') return WAN30_STANDARD
	if (variant === 'prime') return WAN30_PRIME
	throw new Error('Wan 3.0 variant must be standard or prime.')
}

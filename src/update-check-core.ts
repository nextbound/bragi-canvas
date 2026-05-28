import type { UpdatePromptState } from './settings'

export const UPDATE_CHECK_TTL_MS = 3 * 60 * 60 * 1000
export const UPDATE_PROMPT_SUPPRESSION_MS = 3 * 60 * 60 * 1000

export interface LatestReleaseInfo {
	version: string
	releaseUrl: string
	releaseName?: string
}

export interface AvailablePluginUpdate {
	currentVersion: string
	latestVersion: string
	releaseUrl: string
	releaseName?: string
}

interface ParsedVersion {
	major: number
	minor: number
	patch: number
}

export function normalizeVersion(version: string): string | null {
	const match = version.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i)
	if (!match) return null
	return `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`
}

function parseVersion(version: string): ParsedVersion | null {
	const normalized = normalizeVersion(version)
	if (!normalized) return null
	const [major, minor, patch] = normalized.split('.').map(part => Number(part))
	return { major, minor, patch }
}

export function compareVersions(a: string, b: string): number {
	const av = parseVersion(a)
	const bv = parseVersion(b)
	if (!av || !bv) return 0
	for (const key of ['major', 'minor', 'patch'] as const) {
		if (av[key] > bv[key]) return 1
		if (av[key] < bv[key]) return -1
	}
	return 0
}

export function isNewerVersion(candidate: string, current: string): boolean {
	return compareVersions(candidate, current) > 0
}

export function shouldUseCachedRelease(state: UpdatePromptState, now = Date.now()): boolean {
	return typeof state.lastCheckedAt === 'number'
		&& now - state.lastCheckedAt < UPDATE_CHECK_TTL_MS
		&& typeof state.latestVersion === 'string'
		&& typeof state.latestReleaseUrl === 'string'
}

export function getCachedRelease(state: UpdatePromptState): LatestReleaseInfo | null {
	if (typeof state.latestVersion !== 'string' || typeof state.latestReleaseUrl !== 'string') return null
	return {
		version: state.latestVersion,
		releaseUrl: state.latestReleaseUrl,
		releaseName: state.latestReleaseName,
	}
}

export function updateFromRelease(currentVersion: string, release: LatestReleaseInfo): AvailablePluginUpdate | null {
	if (!isNewerVersion(release.version, currentVersion)) return null
	return {
		currentVersion: normalizeVersion(currentVersion) || currentVersion,
		latestVersion: release.version,
		releaseUrl: release.releaseUrl,
		releaseName: release.releaseName,
	}
}

export function shouldShowAutomaticUpdatePrompt(state: UpdatePromptState, latestVersion: string, now = Date.now()): boolean {
	return !(state.lastPromptedVersion === latestVersion
		&& typeof state.lastPromptedAt === 'number'
		&& now - state.lastPromptedAt < UPDATE_PROMPT_SUPPRESSION_MS)
}

export function markUpdatePrompted(state: UpdatePromptState, latestVersion: string, now = Date.now()): void {
	state.lastPromptedVersion = latestVersion
	state.lastPromptedAt = now
}

export function cacheLatestRelease(state: UpdatePromptState, release: LatestReleaseInfo, now = Date.now()): void {
	state.lastCheckedAt = now
	state.latestVersion = release.version
	state.latestReleaseUrl = release.releaseUrl
	state.latestReleaseName = release.releaseName
}

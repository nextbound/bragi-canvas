import { requestUrl } from 'obsidian'
import type { UpdatePromptState } from './settings'
import {
	cacheLatestRelease,
	getCachedRelease,
	normalizeVersion,
	shouldUseCachedRelease,
	updateFromRelease,
	type AvailablePluginUpdate,
	type LatestReleaseInfo,
} from './update-check-core'

export type { AvailablePluginUpdate }
export { markUpdatePrompted, shouldShowAutomaticUpdatePrompt } from './update-check-core'

const LATEST_RELEASE_API = 'https://api.github.com/repos/nextbound/bragi-canvas/releases/latest'
const FALLBACK_RELEASE_URL = 'https://github.com/nextbound/bragi-canvas/releases/latest'

interface GithubReleaseResponse {
	tag_name?: unknown
	html_url?: unknown
	name?: unknown
}

export interface PluginUpdateCheckResult {
	update: AvailablePluginUpdate | null
	fetched: boolean
}

function releaseFromResponse(body: GithubReleaseResponse): LatestReleaseInfo {
	if (typeof body.tag_name !== 'string') throw new Error('GitHub release response did not include tag_name')
	const version = normalizeVersion(body.tag_name)
	if (!version) throw new Error(`GitHub release tag is not a semantic version: ${body.tag_name}`)
	return {
		version,
		releaseUrl: typeof body.html_url === 'string' ? body.html_url : FALLBACK_RELEASE_URL,
		releaseName: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined,
	}
}

async function fetchLatestRelease(): Promise<LatestReleaseInfo> {
	const response = await requestUrl({
		url: LATEST_RELEASE_API,
		method: 'GET',
		headers: {
			Accept: 'application/vnd.github+json',
		},
		throw: false,
	})
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`GitHub release check failed (${response.status})`)
	}
	return releaseFromResponse(response.json as GithubReleaseResponse)
}

export async function checkForPluginUpdate(
	currentVersion: string,
	state: UpdatePromptState,
	opts: { forceFetch?: boolean; now?: number } = {},
): Promise<PluginUpdateCheckResult> {
	const now = opts.now ?? Date.now()
	if (!opts.forceFetch && shouldUseCachedRelease(state, now)) {
		const cached = getCachedRelease(state)
		return {
			update: cached ? updateFromRelease(currentVersion, cached) : null,
			fetched: false,
		}
	}

	const latest = await fetchLatestRelease()
	cacheLatestRelease(state, latest, now)
	return {
		update: updateFromRelease(currentVersion, latest),
		fetched: true,
	}
}

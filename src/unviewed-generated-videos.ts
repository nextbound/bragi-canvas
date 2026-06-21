export const MAX_UNVIEWED_GENERATED_VIDEOS = 1000

const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i

export function isVideoMediaPath(filePath: string): boolean {
	return VIDEO_EXT.test(filePath)
}

export function markGeneratedVideoUnviewed(paths: string[], path: string): string[] {
	if (!isVideoMediaPath(path)) return paths
	return [
		path,
		...paths.filter(existing => existing !== path),
	].slice(0, MAX_UNVIEWED_GENERATED_VIDEOS)
}

export function markGeneratedVideoViewed(paths: string[], path: string): string[] {
	return paths.filter(existing => existing !== path)
}

export function pruneUnviewedGeneratedVideos(paths: string[], deletedPaths: string[]): string[] {
	const deleted = new Set(deletedPaths)
	return paths.filter(path => !deleted.has(path))
}

export function shouldMarkGeneratedVideoViewedFromFileOpen(
	filePath: string | undefined,
	activeLeafFilePath: string | undefined,
): boolean {
	return !!filePath && filePath === activeLeafFilePath && isVideoMediaPath(filePath)
}

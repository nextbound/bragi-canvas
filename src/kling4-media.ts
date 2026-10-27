import type { App } from 'obsidian'

export function validateKling4Durations(mode: string | null, videos: number[], audios: number[]): void {
	if ([...videos, ...audios].some(value => !Number.isFinite(value) || value <= 0)) throw new Error('Could not read reference media duration. Video generation has not started.')
	if (mode === 'video-ref' && videos.reduce((sum, value) => sum + value, 0) > 30.001) throw new Error('Kling 4.0 reference videos must total at most 30 seconds.')
	if (mode === 'video-edit' && videos.some(value => value < 3)) throw new Error('Kling 4.0 editing requires a source video of at least 3 seconds.')
	if (audios.some(value => value < 5 || value > 30.001)) throw new Error('Kling 4.0 reference audio must be between 5 and 30 seconds per clip.')
}

export async function readKling4MediaDuration(app: App, path: string, kind: 'video' | 'audio'): Promise<number> {
	const media = createEl(kind)
	media.preload = 'metadata'
	return new Promise((resolve, reject) => {
		const finish = (error?: Error) => {
			const duration = media.duration
			window.clearTimeout(timer)
			media.onloadedmetadata = null
			media.onerror = null
			media.removeAttribute('src')
			media.load()
			if (error) reject(error)
			else resolve(duration)
		}
		const timer = window.setTimeout(() => finish(new Error('Could not read reference duration within 15 seconds. Video generation has not started.')), 15000)
		media.onloadedmetadata = () => finish()
		media.onerror = () => finish(new Error('Could not read reference duration. Video generation has not started.'))
		media.src = app.vault.adapter.getResourcePath(path)
	})
}

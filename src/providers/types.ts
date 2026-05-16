export interface GenerateImageResult {
	filePath: string
}

export interface GenerateVideoResult {
	done: boolean
	taskId?: string
	filePath?: string
}

export interface ImageProvider {
	name: string
	generateImage(prompt: string, options?: Record<string, unknown>): Promise<GenerateImageResult>
}

export interface VideoProvider {
	name: string
	generateVideo(prompt: string, options?: Record<string, unknown>): Promise<GenerateVideoResult>
	checkStatus?(taskId: string): Promise<GenerateVideoResult>
}

export interface GenerateAudioResult {
	filePath: string
}

export interface VoiceOption {
	id: string
	name: string
	description?: string
	gender?: string
	age?: string
	language?: string | string[]
	category?: string
	tags?: string[]
	previewUrl?: string
	source?: 'builtin' | 'custom' | 'provider'
}

export interface ListVoicesOptions {
	modelId?: string
	bragiModelId?: string
	query?: string
	source?: 'builtin' | 'custom' | 'all'
}

export interface VoiceCloneOptions {
	modelId: string
	audioUrl: string
	sourceHash: string
	sourcePath: string
	voiceNamePrefix?: string
}

export interface VoiceCloneResult {
	voiceId: string
	name?: string
	previewUrl?: string
}

export interface AudioProvider {
	name: string
	generateAudio(prompt: string, options: { mode: 'tts' | 'music' | 'sound-effect', modelId?: string, [k: string]: unknown }): Promise<GenerateAudioResult>
	listVoices?(options?: ListVoicesOptions): Promise<VoiceOption[]>
	cloneVoice?(options: VoiceCloneOptions): Promise<VoiceCloneResult>
}

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
	generateImage(prompt: string, options?: Record<string, any>): Promise<GenerateImageResult>
}

export interface VideoProvider {
	name: string
	generateVideo(prompt: string, options?: Record<string, any>): Promise<GenerateVideoResult>
	checkStatus?(taskId: string): Promise<GenerateVideoResult>
}

export interface GenerateAudioResult {
	filePath: string
}

export interface AudioProvider {
	name: string
	generateAudio(prompt: string, options: { mode: 'tts' | 'music' | 'sound-effect', modelId?: string, [k: string]: any }): Promise<GenerateAudioResult>
}

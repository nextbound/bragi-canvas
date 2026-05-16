export type GenerationType = 'image' | 'video' | 'text' | 'audio'

export type ImageMode = 'text-to-image' | 'image-ref-to-image'
export type VideoMode = 'text-to-video' | 'first-frame' | 'image-ref' | 'first-last-frame' | 'multi-image-ref' | 'video-ref' | 'video-extend' | 'video-edit'
export type TextMode = 'text-to-text'
export type AudioMode = 'tts' | 'music' | 'sound-effect'

export type Mode = ImageMode | VideoMode | TextMode | AudioMode

export interface ParamOption {
	label: string
	value: string
}

export interface ModelParam {
	id: string
	label: string
	type: 'select' | 'number' | 'range'
	options?: ParamOption[]
	/**
	 * Mode-specific option overrides. When the user picks one of these modes, the
	 * param's dropdown is rebuilt from `optionsByMode[mode]` instead of `options`.
	 * If the currently-selected value isn't in the new list, it snaps back to `default`.
	 * Used e.g. for xAI video where image-ref caps duration at 10s while others go to 15s.
	 */
	optionsByMode?: Record<string, ParamOption[]>
	default: string | number
	min?: number
	max?: number
	step?: number
	unit?: string   // e.g. 's' for seconds
}

/**
 * Provider-specific config for a model.
 * Different providers may use different API model IDs for the same model.
 */
export interface ProviderConfig {
	apiModelId: string
}

export interface ModelConfig {
	id: string
	name: string
	type: GenerationType
	supportedProviders: Record<string, ProviderConfig>  // provider name → config
	modes: Mode[]
	params: ModelParam[]
	voiceConfig?: {
		builtin: boolean
		clone: boolean
	}
}

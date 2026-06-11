export type GenerationType = 'image' | 'video' | 'text' | 'audio'

export type ImageMode = 'text-to-image' | 'image-ref-to-image'
export type VideoMode = 'text-to-video' | 'first-frame' | 'image-ref' | 'first-last-frame' | 'multi-image-ref' | 'video-ref' | 'video-extend' | 'video-edit' | 'motion-control'
export type TextMode = 'text-to-text'
export type AudioMode = 'tts' | 'music' | 'sound-effect'

export type Mode = ImageMode | VideoMode | TextMode | AudioMode
export type VoiceSourceMode = 'builtin' | 'reference' | 'design'

/**
 * How a provider expects reference media (upstream images/videos/audio/PDFs) delivered:
 * - `relay`: uploaded to the built-in Bragi relay; the provider receives an https URL.
 * - `inline`: the provider encodes raw bytes itself (base64 / data-URI / multipart).
 * - `native_asset`: uploaded to a provider-native asset library; provider gets an `asset://` id.
 * - `passthrough`: the provider accepts a data-URI / URL string as-is, no upload step.
 */
export type RefDelivery = 'relay' | 'inline' | 'native_asset' | 'passthrough'
export type RefModality = 'image' | 'video' | 'audio' | 'pdf'

export interface RefDeliverySpec {
	image?: RefDelivery
	video?: RefDelivery
	audio?: RefDelivery
	pdf?: RefDelivery
	/** Conditional relay: keep inline below this size, upload to relay above it (used by text models). */
	relayIfLargerThanBytes?: number
	/** Which native asset library `native_asset` deliveries route through. */
	nativeAssetProvider?: 'byteplus' | 'token360' | 'tokenrouter'
}

export interface ParamOption {
	label: string
	value: string
}

export interface ModelParamProviderOverride {
	options?: ParamOption[]
	default?: string | number
	min?: number
	max?: number
	step?: number
	unit?: string
	/** Hide this param entirely for the provider (e.g. a wrapper that omits it). */
	hidden?: boolean
}

export interface ModelParam {
	id: string
	label: string
	type: 'select' | 'number' | 'range'
	/**
	 * Restrict this parameter to specific generation modes. Omit for parameters
	 * that apply to every mode on the model.
	 */
	modes?: Mode[]
	options?: ParamOption[]
	/**
	 * Mode-specific option overrides. When the user picks one of these modes, the
	 * param's dropdown is rebuilt from `optionsByMode[mode]` instead of `options`.
	 * If the currently-selected value isn't in the new list, it snaps back to `default`.
	 * Used e.g. for xAI video where image-ref caps duration at 10s while others go to 15s.
	 */
	optionsByMode?: Record<string, ParamOption[]>
	/**
	 * Provider-specific parameter overrides for cases where wrappers expose a
	 * narrower schema than the native upstream model.
	 */
	providerOverrides?: Record<string, ModelParamProviderOverride>
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
	/**
	 * This provider routes the model's modes to multiple upstream model IDs
	 * internally (e.g. DashScope Wan 2.7, DashScope voice). The catalog
	 * `apiModelId` is a display-only umbrella; routing lives in the provider.
	 * Marking aggregated locks the API-model-id editor (a single editable id
	 * would be meaningless / could corrupt routing).
	 */
	aggregated?: boolean
	/**
	 * Opt-in: expose the API-model-id pencil editor for this provider×model.
	 * Defaults to false — most models show a static, non-editable id. Use for
	 * providers that accept arbitrary upstream model ids (e.g. BytePlus C-Dance).
	 * Ignored when `aggregated` is true.
	 */
	editableApiModelId?: boolean
	/**
	 * Restrict this provider to a subset of the model's `modes`. Omit to inherit
	 * all of the model's modes. Used when a provider exposes only part of an
	 * aggregated model (e.g. MuleRouter only offers Wan 2.7 first-frame i2v).
	 */
	modes?: Mode[]
	/**
	 * Per-model override of how this provider receives reference media. Omit to
	 * inherit the provider's `defaultRefDelivery`. Used when one model on a
	 * provider differs (e.g. Seedance uses `native_asset` on BytePlus while
	 * Seedream on the same provider is `passthrough`).
	 */
	refDelivery?: RefDeliverySpec
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
		design?: boolean
		modelIds?: Partial<Record<VoiceSourceMode, string>>
		sampleModelId?: string
	}
}

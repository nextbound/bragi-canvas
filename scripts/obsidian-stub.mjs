// Minimal stand-in for the `obsidian` module so the catalog check can bundle
// the provider registry (which transitively imports obsidian) under Node.
// Only static catalog data is read; no runtime API is ever invoked.
export const requestUrl = () => {
	throw new Error('obsidian stub: requestUrl is not available during the catalog check')
}
export const normalizePath = (p) => p
export const setIcon = () => {}
export const setTooltip = () => {}
export class Notice {}
export class Modal {}
export class Plugin {}
export class PluginSettingTab {}
export class ItemView {}
export class Setting {}
export class TFile {}
export class MarkdownView {}
export const Platform = {}
export default {}

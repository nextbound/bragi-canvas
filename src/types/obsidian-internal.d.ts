import 'obsidian'
declare module 'obsidian' {
	interface App {
		viewRegistry?: { getTypeByExtension?(extension: string): string }
		commands: { executeCommandById(id: string): boolean }
		setting: { open(): void; openTabById(id: string): void }
	}
	interface WorkspaceLeaf { app: App }
	interface Vault {
		getConfig?(key: 'attachmentFolderPath'): string
		setConfig?(key: 'attachmentFolderPath', value: string): void
	}
}

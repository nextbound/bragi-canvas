declare module 'electron' {
	export const remote: {
		dialog: {
			showOpenDialog(options: {
				title?: string
				filters?: Array<{ name: string; extensions: string[] }>
				properties?: string[]
			}): Promise<{ canceled: boolean; filePaths: string[] }>
			showSaveDialog(options: {
				title?: string
				defaultPath?: string
				filters?: Array<{ name: string; extensions: string[] }>
			}): Promise<{ canceled: boolean; filePath?: string }>
		}
	}
}

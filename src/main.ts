import { Plugin, Notice, requestUrl, Menu, Modal, Setting } from 'obsidian'
import { BragiSettings, DEFAULT_SETTINGS, BragiSettingTab } from './settings'
import { uploadRef } from './providers/upload'
import { getProvider } from './providers/registry'
import { TaskQueue, type TaskSnapshot } from './task-queue'
import { getCanvasFromNode, createPlaceholderNode, replacePlaceholderWithFile, markNodeFailed, resetPlacement, duplicateWithConnections, computeOutputSize, readAspectRatio, sweepInterruptedPlaceholders, stopGeneratingTicker } from './canvas-ops'
import { patchCanvasMenu, unpatchCanvasMenu, removeToolbarButtons, replaceCanvasControlIcons, replaceCanvasCardMenuIcons } from './toolbar'
import { openPanoramaViewer } from './panorama'
import { registerBragiIcons } from './icons'
import { showGenerateBar, showBatchGenerateBar, hideGenerateBar } from './panel'
import { getUpstreamInputs, resolvePrompts } from './edge-parser'
import { refreshAllThumbnails, removeAllThumbnails, getOrderedImages, getAssetIds } from './ref-thumbnails'
import { refreshAllTextRefs, removeAllTextRefs, getOrderedPrompts } from './text-refs'
import { refreshAllAudioRefs, removeAllAudioRefs } from './audio-refs'
import { startEdgeHighlight, stopEdgeHighlight } from './edge-highlight'
import { exportCanvas, importCanvas } from './import-export'
import type { PanelResult } from './panel'
import type { VideoProvider } from './providers/types'
import { BragiMcpServer } from './mcp-server'
import { checkMigration } from './migrate-assets'
import { migrateProviderPrefs } from './migrate-providers'
import { startAttachmentRedirect } from './attachment-redirect'
import { ensureBytePlusAsset, getBytePlusAssetCreds } from './byteplus-asset-flow'
import { splitImageNodeIntoTiles } from './grid-split-flow'
import { isSupportedLanguage, LanguageGateModal } from './ui/language-gate'
import { installAlwaysNewTab } from './always-new-tab'
import type { Canvas, CanvasNode } from './types/canvas-internal'

export default class BragiCanvas extends Plugin {
	settings: BragiSettings = DEFAULT_SETTINGS
	private thumbInterval: ReturnType<typeof setInterval> | null = null
	private attachmentRedirectStop: (() => void) | null = null
	taskQueue = new TaskQueue()
	private mcpServer: BragiMcpServer | null = null
	private pendingTaskSnapshots: TaskSnapshot[] = []
	private resumedCanvasPaths = new Set<string>()
	// Placeholder IDs for sync (image/text/audio) generations currently running in
	// this session. Ghost sweeper consults this alongside TaskQueue to avoid
	// flagging an in-flight placeholder as interrupted.
	private syncGenerating = new Set<string>()
	// Canvases we've already swept this session — avoid repeat sweeps on every
	// layout-change event.
	private sweptCanvasPaths = new Set<string>()

	async onload() {
		// Bragi relies on Obsidian running in English (our UI hooks match the
		// default aria-labels). If the user is on a different locale, refuse to
		// set anything up and show a prompt.
		if (!isSupportedLanguage()) {
			this.app.workspace.onLayoutReady(() => {
				new LanguageGateModal(this.app, this.manifest.id).open()
			})
			return
		}

		registerBragiIcons()
		await this.loadSettings()
		this.taskQueue.onChange = () => { this.persistPendingTasks() }
		this.addSettingTab(new BragiSettingTab(this.app, this))

		// Force all file-opens into new tabs — protects in-flight generation placeholders
		// from getting swapped out when the user clicks another file.
		this.register(installAlwaysNewTab())

		// Right-click menu: Set Asset ID on image nodes
		this.registerEvent(
			// @ts-ignore — internal API
			this.app.workspace.on('canvas:node-menu', (menu: Menu, node: CanvasNode) => {
				const nodeData = node.getData()
				if (nodeData.type !== 'file') return
				const filePath = (nodeData as any).file || ''
				if (!/\.(png|jpg|jpeg|webp|gif)$/i.test(filePath)) return

				const currentId = (nodeData as any).bragiAssetId || ''
				menu.addItem((item) => {
					item.setTitle(currentId ? `Asset ID: ${currentId}` : 'Set Asset ID')
						.setIcon('link')
						.onClick(() => this.showAssetIdModal(node))
				})
			})
		)

		// Patch canvas menu when a canvas view opens
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.tryPatchCanvas()
			})
		)

		this.app.workspace.onLayoutReady(() => {
			this.tryPatchCanvas()
			migrateProviderPrefs(this).catch(err => console.error('Bragi: provider-prefs migration failed', err))
			checkMigration(this).catch(err => console.error('Bragi: migration check failed', err))
			this.attachmentRedirectStop = startAttachmentRedirect(this.app)
		})

		// Import/export commands
		this.addCommand({
			id: 'bragi-export-canvas',
			name: 'Export canvas as .bragi package',
			checkCallback: (checking: boolean) => {
				const canvas = this.getActiveCanvas()
				if (!canvas) return false
				if (!checking) exportCanvas(this.app, this.settings, canvas)
				return true
			},
		})

		this.addCommand({
			id: 'bragi-import-merge',
			name: 'Import .bragi package (merge into current canvas)',
			checkCallback: (checking: boolean) => {
				const canvas = this.getActiveCanvas()
				if (!canvas) return false
				if (!checking) importCanvas(this.app, this.settings, canvas, 'merge')
				return true
			},
		})

		this.addCommand({
			id: 'bragi-import-new',
			name: 'Import .bragi package (as new canvas)',
			callback: () => {
				importCanvas(this.app, this.settings, null, 'new')
			},
		})

		if (this.settings.mcpEnabled) this.startMcpServer()
	}

	onunload() {
		this.stopMcpServer()
		unpatchCanvasMenu()
		removeToolbarButtons()
		hideGenerateBar()
		removeAllThumbnails()
		removeAllTextRefs()
		removeAllAudioRefs()
		stopEdgeHighlight()
		this.taskQueue.stop()
		stopGeneratingTicker()
		if (this.thumbInterval) clearInterval(this.thumbInterval)
		this.attachmentRedirectStop?.()
		this.attachmentRedirectStop = null
	}

	// ── Canvas menu patching ────────────────────────────────────

	startMcpServer() {
		if (this.mcpServer) return
		this.mcpServer = new BragiMcpServer(
			() => this.getActiveCanvas(),
			this.app,
			(node, result) => this.executeGeneration(node, result),
			() => this.settings,
			this.taskQueue,
			() => this.getOutputDir(),
		)
		this.mcpServer.start(this.settings.mcpPort || 17775).catch(err => {
			console.error('Bragi MCP server start failed:', err)
			this.mcpServer = null
		})
	}

	stopMcpServer() {
		if (!this.mcpServer) return
		this.mcpServer.stop()
		this.mcpServer = null
	}

	getActiveCanvas(): Canvas | null {
		const leaf = this.app.workspace.activeLeaf
		const view = leaf?.view as any
		if (view?.getViewType?.() !== 'canvas' || !view.canvas) return null
		return view.canvas as Canvas
	}

	tryPatchCanvas() {
		const leaf = this.app.workspace.activeLeaf
		if (!leaf) return
		const view = leaf.view as any
		if (view?.getViewType?.() !== 'canvas' || !view.canvas) return

		const canvas = view.canvas as Canvas
		const canvasPath = (view as any)?.file?.path as string | undefined
		if (canvasPath) this.resumePendingTasksForCanvas(canvas, canvasPath)

		// Sweep runs every canvas activation:
		//  - tracked placeholders get their overlay+shimmer re-attached (DOM is
		//    recreated each time the canvas view mounts)
		//  - untracked `bragiGenerating` nodes are ghosts → marked red
		// The Notice only shows on the first sweep of each canvas path per session.
		if (canvasPath) {
			const isFirstSweep = !this.sweptCanvasPaths.has(canvasPath)
			this.sweptCanvasPaths.add(canvasPath)
			const ghostCount = sweepInterruptedPlaceholders(canvas, (id) =>
				this.syncGenerating.has(id) ||
				this.taskQueue.getSnapshots().some(s => s.placeholderNodeId === id)
			)
			if (ghostCount > 0 && isFirstSweep) {
				new Notice(`Bragi: marked ${ghostCount} interrupted placeholder${ghostCount > 1 ? 's' : ''} red. Delete them when you're done reviewing.`)
				canvas.requestSave()
			} else if (ghostCount > 0) {
				canvas.requestSave()
			}
		}

		patchCanvasMenu(
			canvas,
			(node) => this.openPanel('image', node),
			(node) => this.openPanel('video', node),
			(node) => this.openPanel('text', node),
			(node) => this.openPanel('audio', node),
			(node) => this.handleSTT(node),
			(node) => this.handleAudioIsolation(node),
			(node) => duplicateWithConnections(canvas, node),
			(type, nodes) => this.openBatchPanel(type, nodes),
			(node) => openPanoramaViewer(this.app, canvas, node, this.getOutputDir()),
			(node) => splitImageNodeIntoTiles(this, canvas, node).catch(err => {
				console.error('Bragi split grid error:', err)
				new Notice(`Split failed: ${err.message || err}`)
			}),
		)

		// Refresh thumbnails periodically to catch edge changes
		if (this.thumbInterval) clearInterval(this.thumbInterval)
		refreshAllThumbnails(canvas, this.app)
		refreshAllTextRefs(canvas, this.app)
		refreshAllAudioRefs(canvas, this.app)
		this.thumbInterval = setInterval(() => {
			refreshAllThumbnails(canvas, this.app)
			refreshAllTextRefs(canvas, this.app)
			refreshAllAudioRefs(canvas, this.app)
		}, 1000)

		// Highlight connected edges on node selection
		startEdgeHighlight(canvas)

		// Replace right-side canvas control icons + bottom card menu icons
		const containerEl = (view as any).containerEl as HTMLElement
		if (containerEl) {
			replaceCanvasControlIcons(containerEl)
			replaceCanvasCardMenuIcons(containerEl, this.app, this.manifest.id)
		}

	}

	// ── Generate Bar ────────────────────────────────────────────

	openPanel(type: 'image' | 'video' | 'text' | 'audio', node: CanvasNode) {
		showGenerateBar(
			node,
			type,
			this.settings,
			this.app,
			(result) => this.executeGeneration(node, result),
			() => this.saveSettings()
		)
	}

	openBatchPanel(type: 'image' | 'video' | 'text' | 'audio', nodes: CanvasNode[]) {
		showBatchGenerateBar(
			nodes,
			type,
			this.settings,
			this.app,
			(nodes, result) => this.executeBatchGeneration(nodes, result),
			() => this.saveSettings()
		)
	}

	async executeBatchGeneration(nodes: CanvasNode[], result: PanelResult) {
		const promises = nodes.map(async (node) => {
			const nodeData = node.getData() as any
			let prompt = ''
			if (nodeData.type === 'text') {
				prompt = (node as any).text?.trim() || nodeData.text?.trim() || ''
			} else if (nodeData.type === 'file' && /\.md$/i.test(nodeData.file || '')) {
				const file = this.app.vault.getAbstractFileByPath(nodeData.file)
				if (file) prompt = (await this.app.vault.read(file as any)).trim()
			}
			if (!prompt) return
			await this.executeGeneration(node, { ...result, prompt })
		})
		await Promise.allSettled(promises)
	}

	// ── Generation logic ────────────────────────────────────────

	getOutputDir(): string {
		return '_bragi/assets'
	}

	async executeGeneration(node: CanvasNode, result: PanelResult): Promise<{ placeholderIds: string[]; expectedOutputType: 'image' | 'video' | 'text' | 'audio' }> {
		const batchCount = Math.max(1, result.batchCount || 1)

		// Reset placement offset for this source node
		resetPlacement(node.id)

		const placeholderIds: string[] = []
		for (let i = 0; i < batchCount; i++) {
			const id = await this.startSingleGeneration(node, result)
			if (id) placeholderIds.push(id)
		}

		return { placeholderIds, expectedOutputType: result.model.type }
	}

	/**
	 * Build prompts, create the placeholder node synchronously, then fire the provider
	 * work in the background. Returns the placeholder id so callers (MCP generate tool)
	 * can track the task without waiting for the actual generation to finish.
	 */
	async startSingleGeneration(node: CanvasNode, result: PanelResult): Promise<string | null> {
		const { prompt, model } = result

		const canvas = getCanvasFromNode(node)

		// Read upstream inputs (reference images, additional prompts)
		const upstream = getUpstreamInputs(canvas, node)
		// Use ordered prompts (respects user's drag-reorder on the text ref strip)
		const upstreamPrompts = await getOrderedPrompts(canvas, node, this.app)

		// Merge prompts: upstream prompts + panel prompt
		const allPrompts = [...upstreamPrompts, prompt].filter(Boolean)
		const finalPrompt = allPrompts.join('\n')

		if (!finalPrompt) {
			new Notice('No prompt to generate from')
			return null
		}

		const targetSize = computeOutputSize(model.type, readAspectRatio(result.params))
		const placeholder = createPlaceholderNode(canvas, model.name, node, targetSize)
		// Register as in-flight so the ghost sweeper doesn't flag it on reloads.
		this.syncGenerating.add(placeholder.id)
		const inputInfo = upstream.images.length > 0
			? ` with ${upstream.images.length} reference${upstream.images.length > 1 ? 's' : ''}`
			: ''
		new Notice(`Generating ${model.name}${inputInfo}…`)

		// Fire the provider call in the background — placeholder id is returned immediately.
		this.runSingleGeneration(node, result, canvas, placeholder, finalPrompt, upstream, upstreamPrompts)
			.catch((err: any) => {
				console.error('Bragi Canvas generation error:', err)
				markNodeFailed(placeholder, err?.message || 'Unknown error')
				new Notice(`Generation failed: ${err?.message || 'Unknown error'}`)
			})
			.finally(() => {
				// Video placeholders are tracked by TaskQueue, not syncGenerating, so
				// deleting here is safe either way.
				this.syncGenerating.delete(placeholder.id)
			})

		return placeholder.id
	}

	private async runSingleGeneration(
		node: CanvasNode,
		result: PanelResult,
		canvas: Canvas,
		placeholder: CanvasNode,
		finalPrompt: string,
		upstream: ReturnType<typeof getUpstreamInputs>,
		upstreamPrompts: string[],
	): Promise<void> {
		const { model, activeProvider, apiModelId, mode, params } = result
		try {
			const outputDir = this.getOutputDir()

			// Read reference images in user-defined order (from thumbnail drag)
			const uniqueImages = getOrderedImages(canvas, node)
			// Only use asset IDs for Seedance (bytedance/byteplus provider)
			const isSeedance = (activeProvider === 'bytedance' || activeProvider === 'byteplus') && model.id.startsWith('seedance')
			const assetIdMap = isSeedance ? getAssetIds(canvas, node) : {}
			// BytePlus asset library: only run when ref images exist AND AK/SK configured
			const bytePlusCreds = (activeProvider === 'byteplus' && isSeedance && (uniqueImages.length > 0 || upstream.audios.length > 0))
				? getBytePlusAssetCreds(this)
				: null
			const refImages: string[] = []
			for (const imgPath of uniqueImages) {
				if (assetIdMap[imgPath]) {
					refImages.push(`asset://${assetIdMap[imgPath]}`)
				} else if (bytePlusCreds) {
					// Run through BytePlus asset library so faces can be reviewed+approved
					refImages.push(await ensureBytePlusAsset(this, canvas, imgPath, bytePlusCreds))
				} else {
					const binary = await this.app.vault.adapter.readBinary(imgPath)
					const base64 = arrayBufferToBase64(binary)
					const ext = imgPath.split('.').pop()?.toLowerCase() || 'png'
					const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
					refImages.push(`data:${mime};base64,${base64}`)
				}
			}

			// Upload reference audios for Seedance
			const refAudios: string[] = []
			if (isSeedance && upstream.audios.length > 0) {
				for (const audioPath of upstream.audios) {
					if (bytePlusCreds) {
						// Route audio through asset library for content review
						refAudios.push(await ensureBytePlusAsset(this, canvas, audioPath, bytePlusCreds))
					} else {
						const binary = await this.app.vault.adapter.readBinary(audioPath)
						const ext = audioPath.split('.').pop()?.toLowerCase() || 'mp3'
						const mime = ext === 'wav' ? 'audio/wav' : 'audio/mpeg'
						const audioUrl = await uploadRef(undefined, binary, `ref.${ext}`, mime)
						refAudios.push(audioUrl)
					}
				}
			}

			if (model.type === 'image') {
				const spec = getProvider(activeProvider)
				const provider = spec?.makeImage?.({ settings: this.settings, app: this.app, outputDir })
				if (!provider) {
					markNodeFailed(placeholder, `${activeProvider} doesn't support image generation`)
					return
				}
				// Legnext historically got `modelId: model.id` instead of apiModelId — preserve
				const imgParams = activeProvider === 'legnext'
					? { ...params, modelId: model.id }
					: { ...params, modelId: apiModelId, refImages }
				const genResult = await provider.generateImage(finalPrompt, imgParams)

				replacePlaceholderWithFile(canvas, placeholder, genResult.filePath, node)
				new Notice('Image ready')

			} else if (model.type === 'video') {
				const spec = getProvider(activeProvider)
				const provider = spec?.makeVideo?.({ settings: this.settings, app: this.app, outputDir })
				if (!provider) {
					markNodeFailed(placeholder, `${activeProvider} doesn't support video generation`)
					return
				}
				const videoResult = await provider.generateVideo(finalPrompt, { ...params, modelId: apiModelId, genMode: mode, refImages, refAudios })

				if (videoResult.done && videoResult.filePath) {
					// Rare: synchronous completion
					replacePlaceholderWithFile(canvas, placeholder, videoResult.filePath, node)
					new Notice('Video ready')
				} else if (videoResult.taskId) {
					// Queue for async polling
					const canvasPath = (this.app.workspace.activeLeaf?.view as any)?.file?.path as string | undefined
					this.taskQueue.addTask({
						snapshot: {
							taskId: videoResult.taskId,
							providerName: activeProvider,
							apiModelId,
							modelName: model.name,
							canvasPath: canvasPath || '',
							sourceNodeId: node.id,
							placeholderNodeId: placeholder.id,
							outputDir,
							startedAt: Date.now(),
						},
						provider,
						canvas,
						placeholder,
						sourceNode: node,
					})
					new Notice(`Video queued — you'll get a notice when it's ready`)
				}

			} else if (model.type === 'text') {
				const spec = getProvider(activeProvider)
				const provider = spec?.makeText?.({ settings: this.settings, app: this.app, outputDir })
				if (!provider) {
					markNodeFailed(placeholder, `${activeProvider} doesn't support text generation`)
					return
				}
				const { text: textResult } = await provider.generateText(finalPrompt, { modelId: apiModelId, refImages })

				// Split result into multiple nodes if ---SPLIT--- is present
				canvas.removeNode(placeholder)
				const segments = textResult.split(/\n?---SPLIT---\n?/).map((s: string) => s.trim()).filter(Boolean)
				const currentData = canvas.getData()
				const sourceData = node.getData()
				const nodeWidth = Math.max(300, sourceData.width)
				const newNodes: any[] = []
				const newEdges: any[] = []

				for (let i = 0; i < segments.length; i++) {
					const nodeId = Math.random().toString(36).substring(2, 18)
					const edgeId = Math.random().toString(36).substring(2, 18)
					newNodes.push({
						id: nodeId,
						type: 'text',
						text: segments[i],
						x: sourceData.x + sourceData.width + 50,
						y: sourceData.y + i * 220,
						width: nodeWidth,
						height: 200,
					})
					newEdges.push({
						id: edgeId,
						fromNode: node.id,
						fromSide: 'right',
						toNode: nodeId,
						toSide: 'left',
						toEnd: 'none',
					})
				}

				canvas.importData({
					nodes: [...currentData.nodes, ...newNodes],
					edges: [...currentData.edges, ...newEdges],
				})

				const countMsg = segments.length > 1 ? ` (${segments.length} nodes)` : ''
				new Notice(`Text ready${countMsg}`)

			} else if (model.type === 'audio') {
				const spec = getProvider(activeProvider)
				const provider = spec?.makeAudio?.({ settings: this.settings, app: this.app, outputDir })
				if (!provider) {
					markNodeFailed(placeholder, `${activeProvider} doesn't support audio generation`)
					return
				}
				const audioResult = await provider.generateAudio(finalPrompt, {
					mode: mode as 'tts' | 'music' | 'sound-effect',
					modelId: apiModelId,
					upstreamPrompts,
					...params,
				})
				replacePlaceholderWithFile(canvas, placeholder, audioResult.filePath, node)
				new Notice('Audio ready')
			}
		} catch (err: any) {
			console.error('Bragi Canvas generation error:', err)
			markNodeFailed(placeholder, err.message || 'Unknown error')
			new Notice(`Generation failed: ${err.message}`)
		}
	}

	/**
	 * Speech to Text: audio file node → text node
	 */
	async handleSTT(node: CanvasNode) {
		const falKey = this.settings.providers.fal
		if (!falKey) {
			new Notice('Add your fal.ai key in Settings → Bragi Canvas to use this')
			return
		}

		const nodeData = node.getData() as any
		const filePath = nodeData.file
		if (!filePath) return

		const canvas = getCanvasFromNode(node)
		const placeholder = createPlaceholderNode(canvas, 'Transcribing…', node, computeOutputSize('text'))
		new Notice('Transcribing audio…')

		try {
			// Read and upload audio file
			const binary = await this.app.vault.adapter.readBinary(filePath)
			const ext = filePath.split('.').pop()?.toLowerCase() || 'mp3'
			const mime = ext === 'wav' ? 'audio/wav' : ext === 'flac' ? 'audio/flac' : 'audio/mpeg'
			const audioUrl = await uploadRef(undefined, binary, `audio.${ext}`, mime)

			// Call STT
			const response = await requestUrl({
				url: 'https://fal.run/fal-ai/elevenlabs/speech-to-text/scribe-v2',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Key ${falKey}`,
				},
				body: JSON.stringify({ audio_url: audioUrl }),
			})

			const text = response.json.text?.trim()
			if (!text) throw new Error('No text in STT response')

			// Replace placeholder with text node
			canvas.removeNode(placeholder)
			const currentData = canvas.getData()
			const nodeId = Math.random().toString(36).substring(2, 18)
			const edgeId = Math.random().toString(36).substring(2, 18)

			canvas.importData({
				nodes: [...currentData.nodes, {
					id: nodeId,
					type: 'text',
					text,
					x: nodeData.x + nodeData.width + 50,
					y: nodeData.y,
					width: Math.max(300, nodeData.width),
					height: 200,
				}],
				edges: [...currentData.edges, {
					id: edgeId,
					fromNode: node.id,
					fromSide: 'right',
					toNode: nodeId,
					toSide: 'left',
					toEnd: 'none',
				}],
			})

			new Notice('Transcription ready')
		} catch (err: any) {
			console.error('Bragi Canvas STT error:', err)
			markNodeFailed(placeholder, err.message || 'Transcription failed')
			new Notice(`Transcription failed: ${err.message}`)
		}
	}

	/**
	 * Audio Isolation: audio file node → cleaned audio file node
	 */
	async handleAudioIsolation(node: CanvasNode) {
		const falKey = this.settings.providers.fal
		if (!falKey) {
			new Notice('Add your fal.ai key in Settings → Bragi Canvas to use this')
			return
		}

		const nodeData = node.getData() as any
		const filePath = nodeData.file
		if (!filePath) return

		const canvas = getCanvasFromNode(node)
		const placeholder = createPlaceholderNode(canvas, 'Removing background…', node, computeOutputSize('audio'))
		new Notice('Removing background noise…')

		try {
			// Read and upload audio file
			const binary = await this.app.vault.adapter.readBinary(filePath)
			const ext = filePath.split('.').pop()?.toLowerCase() || 'mp3'
			const mime = ext === 'wav' ? 'audio/wav' : ext === 'flac' ? 'audio/flac' : 'audio/mpeg'
			const audioUrl = await uploadRef(undefined, binary, `audio.${ext}`, mime)

			// Call audio isolation
			const response = await requestUrl({
				url: 'https://fal.run/fal-ai/elevenlabs/audio-isolation',
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Key ${falKey}`,
				},
				body: JSON.stringify({ audio_url: audioUrl }),
			})

			const resultUrl = response.json.audio?.url
			if (!resultUrl) throw new Error('No audio in isolation response')

			// Download result
			const outputDir = this.getOutputDir()
			const audioResponse = await requestUrl({ url: resultUrl })
			const timestamp = Date.now()
			const fileName = `isolated_${timestamp}.mp3`
			const outPath = `${outputDir}/${fileName}`
			const adapter = this.app.vault.adapter
			if (!await adapter.exists(outputDir)) await adapter.mkdir(outputDir)
			await adapter.writeBinary(outPath, audioResponse.arrayBuffer)

			replacePlaceholderWithFile(canvas, placeholder, outPath, node)
			new Notice('Voice isolated')
		} catch (err: any) {
			console.error('Bragi Canvas isolation error:', err)
			markNodeFailed(placeholder, err.message || 'Voice isolation failed')
			new Notice(`Voice isolation failed: ${err.message}`)
		}
	}

	showAssetIdModal(node: CanvasNode): void {
		const data = node.getData() as any
		const currentId = data.bragiAssetId || ''

		const modal = new Modal(this.app)
		modal.modalEl.classList.add('bragi-modal')
		modal.titleEl.setText('Set asset ID')
		modal.contentEl.createEl('p', {
			text: 'Paste a Volcengine asset ID to use this image as a Seedance face reference.',
			cls: 'setting-item-description',
		})

		let inputValue = currentId

		new Setting(modal.contentEl)
			.setName('Asset ID')
			.addText(text => {
				text.setPlaceholder('asset-20260401123823-6d4x2')
					.setValue(currentId)
					.onChange(v => { inputValue = v })
				text.inputEl.style.width = '100%'
			})

		const btnContainer = modal.contentEl.createDiv({ cls: 'modal-button-container' })

		if (currentId) {
			const clearBtn = btnContainer.createEl('button', { text: 'Clear' })
			clearBtn.addEventListener('click', () => {
				node.setData({ ...node.getData(), bragiAssetId: undefined })
				new Notice('Asset ID cleared')
				modal.close()
			})
		}

		const cancelBtn = btnContainer.createEl('button', { text: 'Cancel' })
		cancelBtn.addEventListener('click', () => modal.close())

		const saveBtn = btnContainer.createEl('button', { text: 'Save', cls: 'mod-cta' })
		saveBtn.addEventListener('click', () => {
			const val = inputValue.trim()
			if (val) {
				node.setData({ ...node.getData(), bragiAssetId: val })
				new Notice(`Asset ID saved`)
			} else {
				node.setData({ ...node.getData(), bragiAssetId: undefined })
			}
			modal.close()
		})

		modal.open()
	}

	async loadSettings() {
		const raw = (await this.loadData()) || {}
		const { _pendingTasks, ...settingsData } = raw
		this.settings = Object.assign({}, DEFAULT_SETTINGS, settingsData)
		this.pendingTaskSnapshots = Array.isArray(_pendingTasks) ? _pendingTasks : []
	}

	async saveSettings() {
		await this.saveData({ ...this.settings, _pendingTasks: this.taskQueue.getSnapshots() })
	}

	private persistPendingTasks() {
		// Fire-and-forget; keep _pendingTasks in sync with the queue.
		this.saveData({ ...this.settings, _pendingTasks: this.taskQueue.getSnapshots() }).catch(err => {
			console.error('Bragi Canvas: failed to persist pending tasks', err)
		})
	}

	// Rebuild a VideoProvider from a snapshot (provider name + settings)
	private buildVideoProvider(providerName: string, outputDir: string): VideoProvider | null {
		const spec = getProvider(providerName)
		return spec?.makeVideo?.({ settings: this.settings, app: this.app, outputDir }) ?? null
	}

	// Try to resume pending tasks whose canvas is now open.
	// Called from tryPatchCanvas() — idempotent per canvas path.
	private resumePendingTasksForCanvas(canvas: Canvas, canvasPath: string) {
		if (this.resumedCanvasPaths.has(canvasPath)) return

		const mine = this.pendingTaskSnapshots.filter(s => s.canvasPath === canvasPath)
		if (mine.length === 0) {
			this.resumedCanvasPaths.add(canvasPath)
			return
		}

		// Wait until the canvas has actually loaded nodes — otherwise we'd drop every snapshot as an orphan.
		if (canvas.nodes.size === 0) return
		this.resumedCanvasPaths.add(canvasPath)

		let resumed = 0
		let dropped = 0
		for (const snap of mine) {
			if (this.taskQueue.hasTask(snap.taskId)) continue

			const placeholder = canvas.nodes.get(snap.placeholderNodeId)
			const sourceNode = canvas.nodes.get(snap.sourceNodeId)
			if (!placeholder || !sourceNode) {
				dropped++
				continue
			}

			const provider = this.buildVideoProvider(snap.providerName, snap.outputDir)
			if (!provider || !provider.checkStatus) {
				dropped++
				continue
			}

			// Re-mark placeholder as generating (shimmer class is DOM-only, lost on reload)
			const nodeEl = (placeholder as any).nodeEl || (placeholder as any).containerEl
			nodeEl?.classList.add('bragi-generating')

			this.taskQueue.addTask({
				snapshot: snap,
				provider,
				canvas,
				placeholder,
				sourceNode,
			})
			resumed++
		}

		// Drop orphans from snapshot list (queue now owns the live ones)
		this.pendingTaskSnapshots = this.pendingTaskSnapshots.filter(s => s.canvasPath !== canvasPath)
		this.persistPendingTasks()

		if (resumed > 0) new Notice(`Resumed ${resumed} video generation${resumed > 1 ? 's' : ''}`)
		if (dropped > 0) console.warn(`Bragi Canvas: Dropped ${dropped} pending task(s) — nodes or provider no longer available`)
	}
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer)
	let binary = ''
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i])
	}
	return btoa(binary)
}

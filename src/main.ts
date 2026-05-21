/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Obsidian Canvas internals and provider payloads are runtime-shaped data that this plugin narrows at use sites. */
import { Plugin, Notice, requestUrl, Menu, Modal, Setting } from 'obsidian'
import { BragiSettings, DEFAULT_SETTINGS, BragiSettingTab, migrateDashScopeSettings } from './settings'
import { uploadRef } from './providers/upload'
import { getProvider } from './providers/registry'
import { TaskQueue, type TaskSnapshot } from './task-queue'
import { getCanvasFromNode, createPlaceholderNode, replacePlaceholderWithFile, markNodeFailed, duplicateWithConnections, computeOutputSize, readAspectRatio, sweepInterruptedPlaceholders, stopGeneratingTicker } from './canvas-ops'
import { patchCanvasMenu, unpatchCanvasMenu, removeToolbarButtons, replaceCanvasControlIcons, replaceCanvasCardMenuIcons } from './toolbar'
import { openPanoramaViewer } from './panorama'
import { registerBragiIcons } from './icons'
import { showGenerateBar, showBatchGenerateBar, hideGenerateBar } from './panel'
import { getUpstreamInputs } from './edge-parser'
import { refreshAllThumbnails, removeAllThumbnails, getOrderedImages, getAssetIds } from './ref-thumbnails'
import { refreshAllTextRefs, removeAllTextRefs, getOrderedPrompts } from './text-refs'
import { getOrderedAudios, refreshAllAudioRefs, removeAllAudioRefs } from './audio-refs'
import { startEdgeHighlight, stopEdgeHighlight } from './edge-highlight'
import { exportCanvas, importCanvas } from './import-export'
import type { PanelResult } from './panel'
import type { AudioProvider, VideoProvider } from './providers/types'
import { BragiMcpServer } from './mcp-server'
import { checkMigration } from './migrate-assets'
import { migrateProviderPrefs } from './migrate-providers'
import { startAttachmentRedirect } from './attachment-redirect'
import { ensureBytePlusAsset, getBytePlusAssetCreds } from './byteplus-asset-flow'
import { splitImageNodeIntoTiles } from './grid-split-flow'
import { isSupportedLanguage, LanguageGateModal } from './ui/language-gate'
import { installAlwaysNewTab } from './always-new-tab'
import type { Canvas, CanvasNode } from './types/canvas-internal'
import type { VoiceSourceMode } from './models/types'

export default class BragiCanvas extends Plugin {
	settings: BragiSettings = DEFAULT_SETTINGS
	private thumbInterval: ReturnType<typeof window.setInterval> | null = null
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
		this.register(installAlwaysNewTab(this.app))

		// Right-click menu: Set Asset ID on image nodes
		this.registerEvent(
			// @ts-ignore — internal API
			this.app.workspace.on('canvas:node-menu', (menu: Menu, node: CanvasNode) => {
				const nodeData = node.getData()
				if (nodeData.type !== 'file') return
				const filePath = (nodeData as unknown).file || ''
				if (!/\.(png|jpg|jpeg|webp|gif)$/i.test(filePath)) return

				const currentId = (nodeData as unknown).bragiAssetId || ''
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
			void migrateProviderPrefs(this).catch(err => console.error('Bragi: provider-prefs migration failed', err))
			void checkMigration(this).catch(err => console.error('Bragi: migration check failed', err))
			this.attachmentRedirectStop = startAttachmentRedirect(this.app)
		})

		// Import/export commands
		this.addCommand({
			id: 'bragi-export-canvas',
			name: 'Export canvas as .bragi package',
			checkCallback: (checking: boolean) => {
				const canvas = this.getActiveCanvas()
				if (!canvas) return false
				if (!checking) void exportCanvas(this.app, this.settings, canvas)
				return true
			},
		})

		this.addCommand({
			id: 'bragi-import-merge',
			name: 'Import .bragi package (merge into current canvas)',
			checkCallback: (checking: boolean) => {
				const canvas = this.getActiveCanvas()
				if (!canvas) return false
				if (!checking) void importCanvas(this.app, this.settings, canvas, 'merge')
				return true
			},
		})

		this.addCommand({
			id: 'bragi-import-new',
			name: 'Import .bragi package (as new canvas)',
			callback: () => {
				void importCanvas(this.app, this.settings, null, 'new')
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
		if (this.thumbInterval) window.clearInterval(this.thumbInterval)
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
		void this.mcpServer.start(this.settings.mcpPort || 17775).catch(err => {
			console.error('Bragi MCP server start failed:', err)
			this.mcpServer = null
		})
	}

	stopMcpServer() {
		if (!this.mcpServer) return
		void this.mcpServer.stop().catch(err => console.error('Bragi MCP server stop failed:', err))
		this.mcpServer = null
	}

	getActiveCanvas(): Canvas | null {
		const leaf = this.app.workspace.getLeaf(false)
		const view = leaf?.view as unknown
		if (view?.getViewType?.() !== 'canvas' || !view.canvas) return null
		return view.canvas as Canvas
	}

	tryPatchCanvas() {
		const leaf = this.app.workspace.getLeaf(false)
		if (!leaf) return
		const view = leaf.view as unknown
		if (view?.getViewType?.() !== 'canvas' || !view.canvas) return

		const canvas = view.canvas as Canvas
		const canvasPath = (view)?.file?.path as string | undefined
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
				void canvas.requestSave()
			} else if (ghostCount > 0) {
				void canvas.requestSave()
			}
		}

		patchCanvasMenu(
			canvas,
			(node) => this.openPanel('image', node),
				(node) => this.openPanel('video', node),
				(node) => this.openPanel('text', node),
				(node) => this.openPanel('audio', node),
				(node) => { void this.handleSTT(node) },
				(node) => { void this.handleAudioIsolation(node) },
			(node) => duplicateWithConnections(canvas, node),
			(type, nodes) => this.openBatchPanel(type, nodes),
			(node) => openPanoramaViewer(this.app, canvas, node, this.getOutputDir()),
			(node) => void splitImageNodeIntoTiles(this, canvas, node).catch(err => {
				console.error('Bragi split grid error:', err)
				new Notice(`Split failed: ${err.message || err}`)
			}),
		)

		// Refresh thumbnails periodically to catch edge changes
		if (this.thumbInterval) window.clearInterval(this.thumbInterval)
		refreshAllThumbnails(canvas, this.app)
		refreshAllTextRefs(canvas, this.app)
		refreshAllAudioRefs(canvas, this.app)
		this.thumbInterval = window.setInterval(() => {
			refreshAllThumbnails(canvas, this.app)
			refreshAllTextRefs(canvas, this.app)
			refreshAllAudioRefs(canvas, this.app)
		}, 1000)

		// Highlight connected edges on node selection
		startEdgeHighlight(canvas)

		// Replace right-side canvas control icons + bottom card menu icons
		const containerEl = (view).containerEl as HTMLElement
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
			(result) => { void this.executeGeneration(node, result) },
			() => { void this.saveSettings() }
		)
	}

	openBatchPanel(type: 'image' | 'video' | 'text' | 'audio', nodes: CanvasNode[]) {
		showBatchGenerateBar(
			nodes,
			type,
			this.settings,
			this.app,
			(nodes, result) => { void this.executeBatchGeneration(nodes, result) },
			() => { void this.saveSettings() }
		)
	}

	async executeBatchGeneration(nodes: CanvasNode[], result: PanelResult) {
		const promises = nodes.map(async (node) => {
			const nodeData = node.getData() as unknown
			let prompt = ''
			if (nodeData.type === 'text') {
				prompt = (node as unknown).text?.trim() || nodeData.text?.trim() || ''
			} else if (nodeData.type === 'file' && /\.md$/i.test(nodeData.file || '')) {
				const file = this.app.vault.getAbstractFileByPath(nodeData.file)
				if (file) prompt = (await this.app.vault.read(file as unknown)).trim()
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
		const voiceMode = selectedVoiceMode(result.params)
		const allPrompts = model.type === 'audio' && voiceMode === 'design'
			? [prompt].filter(Boolean)
			: [...upstreamPrompts, prompt].filter(Boolean)
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
		void this.runSingleGeneration(node, result, canvas, placeholder, finalPrompt, upstream, upstreamPrompts)
			.catch((err: unknown) => {
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
			const uniqueVideos = [...new Set(upstream.videos)]
			// Only native Volcengine / BytePlus Seedance can consume asset:// IDs.
			const isSeedanceModel = model.id.startsWith('seedance')
			const isNativeSeedance = (activeProvider === 'bytedance' || activeProvider === 'byteplus') && isSeedanceModel
			const supportsSeedanceRefs = isNativeSeedance || (activeProvider === 'tokenrouter' && isSeedanceModel)
			const assetIdMap = isNativeSeedance ? getAssetIds(canvas, node) : {}
			// BytePlus asset library: run when Seedance has reference media and AK/SK configured.
			const bytePlusCreds = (activeProvider === 'byteplus' && isNativeSeedance && (uniqueImages.length > 0 || upstream.audios.length > 0 || uniqueVideos.length > 0))
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
			if (supportsSeedanceRefs && upstream.audios.length > 0) {
				if (upstream.audios.length > 3) {
					throw new Error('Seedance supports up to 3 reference audio files.')
				}
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

			// Prepare reference videos for models/providers that can consume upstream video inputs.
			// BytePlus Seedance videos must go through asset:// so face-containing clips are reviewed first.
			const refVideos: string[] = []
			if (model.type === 'text' && uniqueVideos.length > 0) {
				if (!textProviderSupportsVideoRefs(activeProvider)) {
					throw new Error('Video references for text generation are currently supported only with Google Gemini.')
				}
				for (const videoPath of uniqueVideos) {
					const binary = await this.app.vault.adapter.readBinary(videoPath)
					const ext = getFileExtension(videoPath, 'mp4')
					const videoUrl = await uploadRef(undefined, binary, `ref.${ext}`, videoMimeType(videoPath))
					refVideos.push(videoUrl)
				}
			} else if (model.type === 'video' && uniqueVideos.length > 0) {
				if (mode === 'video-ref' && !supportsSeedanceRefs) {
					throw new Error('Reference video is only available with Volcengine, BytePlus, or TokenRouter Seedance.')
				}
				if (supportsSeedanceRefs && uniqueVideos.length > 3) {
					throw new Error('Seedance supports up to 3 reference videos.')
				}
				if (isNativeSeedance && activeProvider === 'byteplus' && !bytePlusCreds) {
					throw new Error('Add BytePlus access key and secret key in settings to use reference videos.')
				}
				const shouldUseVideos = supportsSeedanceRefs || mode === 'video-extend' || mode === 'video-edit' || mode === 'video-ref'
				if (shouldUseVideos) {
					for (const videoPath of uniqueVideos) {
						if (isNativeSeedance && bytePlusCreds) {
							refVideos.push(await ensureBytePlusAsset(this, canvas, videoPath, bytePlusCreds))
						} else {
							const binary = await this.app.vault.adapter.readBinary(videoPath)
							const ext = getFileExtension(videoPath, 'mp4')
							const videoUrl = await uploadRef(undefined, binary, `ref.${ext}`, videoMimeType(videoPath))
							refVideos.push(videoUrl)
						}
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
				const videoResult = await provider.generateVideo(finalPrompt, { ...params, modelId: apiModelId, genMode: mode, refImages, refAudios, refVideos })

				if (videoResult.done && videoResult.filePath) {
					// Rare: synchronous completion
					replacePlaceholderWithFile(canvas, placeholder, videoResult.filePath, node)
					new Notice('Video ready')
				} else if (videoResult.taskId) {
					// Queue for async polling
					const canvasPath = (this.app.workspace.getLeaf(false)?.view as unknown)?.file?.path as string | undefined
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
				const { text: textResult } = await provider.generateText(finalPrompt, { modelId: apiModelId, refImages, refVideos })

				// Split result into multiple nodes if ---SPLIT--- is present
				canvas.removeNode(placeholder)
				const segments = textResult.split(/\n?---SPLIT---\n?/).map((s: string) => s.trim()).filter(Boolean)
				const currentData = canvas.getData()
				const sourceData = node.getData()
				const nodeWidth = Math.max(300, sourceData.width)
				const newNodes: unknown[] = []
				const newEdges: unknown[] = []

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
				const audioParams: Record<string, unknown> = { ...params }
				const voiceMode = selectedVoiceMode(audioParams)
				const audioModelId = modelIdForVoiceMode(model, apiModelId, voiceMode)
				let customVoiceRecord: CustomVoiceRecord | null = null
				if (mode === 'tts' && voiceMode === 'reference') {
					const refIndex = readVoiceRefAudioIndex(audioParams.voiceRefAudioIndex)
					customVoiceRecord = await applyUpstreamVoiceReference(this.app, canvas, provider, activeProvider, audioModelId, getOrderedAudios(canvas, node), refIndex, audioParams)
				} else if (mode === 'tts' && voiceMode === 'design') {
					const promptIndex = readVoiceDesignTextIndex(audioParams.voiceDesignTextIndex)
					customVoiceRecord = await applyVoiceDesign(provider, activeProvider, audioModelId, upstreamPrompts, promptIndex, finalPrompt, audioParams)
				}
				delete audioParams.voiceMode
				delete audioParams.voiceRefAudioIndex
				delete audioParams.voiceDesignTextIndex
				delete audioParams.voiceLabel
				const audioResult = await provider.generateAudio(finalPrompt, {
					mode: mode as 'tts' | 'music' | 'sound-effect',
					modelId: audioModelId,
					upstreamPrompts,
					...audioParams,
				})
				replacePlaceholderWithFile(canvas, placeholder, audioResult.filePath, node)
				if (customVoiceRecord) {
					const outputNode = findFileNodeByPath(canvas, audioResult.filePath)
					if (outputNode) {
						upsertCustomVoiceRecord(outputNode, await customVoiceRecordForOutput(this.app, audioResult.filePath, customVoiceRecord))
						await canvas.requestSave?.()
					}
				}
				new Notice('Audio ready')
			}
		} catch (err: unknown) {
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
			new Notice('Add your fal.ai key in settings to use this')
			return
		}

		const nodeData = node.getData() as unknown
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
		} catch (err: unknown) {
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
			new Notice('Add your fal.ai key in settings to use this')
			return
		}

		const nodeData = node.getData() as unknown
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
		} catch (err: unknown) {
			console.error('Bragi Canvas isolation error:', err)
			markNodeFailed(placeholder, err.message || 'Voice isolation failed')
			new Notice(`Voice isolation failed: ${err.message}`)
		}
	}

	showAssetIdModal(node: CanvasNode): void {
		const data = node.getData() as unknown
		const currentId = data.bragiAssetId || ''

		const modal = new Modal(this.app)
		modal.modalEl.classList.add('bragi-modal')
		modal.titleEl.setText('Set asset ID')
		modal.contentEl.createEl('p', {
			text: 'Paste a volcengine asset ID to use this image as a seedance face reference.',
			cls: 'setting-item-description',
		})

		let inputValue = currentId

		new Setting(modal.contentEl)
			.setName('Asset ID')
			.addText(text => {
				text.setPlaceholder('Asset-20260401123823-6d4x2')
					.setValue(currentId)
					.onChange(v => { inputValue = v })
			text.inputEl.classList.add('bragi-full-width')
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
		this.settings = migrateDashScopeSettings({
			...DEFAULT_SETTINGS,
			...settingsData,
			providers: {
				...DEFAULT_SETTINGS.providers,
				...(settingsData.providers || {}),
			},
			modelOrder: {
				...DEFAULT_SETTINGS.modelOrder,
				...(settingsData.modelOrder || {}),
			},
		}, raw)
		this.pendingTaskSnapshots = Array.isArray(_pendingTasks) ? _pendingTasks : []
	}

	async saveSettings() {
		await this.saveData({ ...this.settings, _pendingTasks: this.taskQueue.getSnapshots() })
	}

	private persistPendingTasks() {
		// Fire-and-forget; keep _pendingTasks in sync with the queue.
		void this.saveData({ ...this.settings, _pendingTasks: this.taskQueue.getSnapshots() }).catch(err => {
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
			const nodeEl = (placeholder as unknown).nodeEl || (placeholder as unknown).containerEl
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

interface CustomVoiceRecord {
	kind: 'clone' | 'design'
	provider: string
	region: string
	modelId: string
	voiceId: string
	name?: string
	previewUrl?: string
	sourceHash?: string
	sourcePath?: string
	promptHash?: string
	voicePrompt?: string
	createdAt: number
}

function isCustomVoiceRecord(value: unknown): value is CustomVoiceRecord {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	if (record.kind !== 'clone' && record.kind !== 'design') return false
	const baseValid = typeof record.provider === 'string'
		&& typeof record.region === 'string'
		&& typeof record.modelId === 'string'
		&& typeof record.voiceId === 'string'
		&& typeof record.createdAt === 'number'
	if (!baseValid) return false
	if (record.kind === 'clone') {
		return typeof record.sourceHash === 'string' && typeof record.sourcePath === 'string'
	}
	if (record.kind === 'design') {
		return typeof record.promptHash === 'string' && typeof record.voicePrompt === 'string'
	}
	return false
}

function providerSupportsVoiceClone(provider: AudioProvider): provider is AudioProvider & { cloneVoice: NonNullable<AudioProvider['cloneVoice']> } {
	return typeof provider.cloneVoice === 'function'
}

function providerSupportsVoiceDesign(provider: AudioProvider): provider is AudioProvider & { designVoice: NonNullable<AudioProvider['designVoice']> } {
	return typeof provider.designVoice === 'function'
}

function findFileNodeByPath(canvas: Canvas, filePath: string): CanvasNode | null {
	for (const node of canvas.nodes.values()) {
		const data = node.getData() as Record<string, unknown>
		if (data.type === 'file' && data.file === filePath) return node
	}
	return null
}

function getCustomVoiceRecords(node: CanvasNode): CustomVoiceRecord[] {
	const data = node.getData() as Record<string, unknown>
	const raw = Array.isArray(data.bragiCustomVoices) ? data.bragiCustomVoices : []
	return raw.filter(isCustomVoiceRecord)
}

function upsertCustomVoiceRecord(node: CanvasNode, record: CustomVoiceRecord): void {
	const data = node.getData() as Record<string, unknown>
	const records = getCustomVoiceRecords(node)
	const next = [
		record,
		...records.filter(item =>
			item.provider !== record.provider
			|| item.region !== record.region
			|| item.modelId !== record.modelId
			|| item.kind !== record.kind
			|| item.sourceHash !== record.sourceHash
			|| item.promptHash !== record.promptHash
		),
	]
	node.setData({ ...data, bragiCustomVoices: next })
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', buffer)
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256Text(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
	return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function selectedVoiceMode(params: Record<string, unknown>): VoiceSourceMode {
	if (params.voiceMode === 'reference') return 'reference'
	if (params.voiceMode === 'design') return 'design'
	return 'builtin'
}

function modelIdForVoiceMode(model: PanelResult['model'], defaultModelId: string, voiceMode: VoiceSourceMode): string {
	return model.voiceConfig?.modelIds?.[voiceMode] || defaultModelId
}

function reusableVoiceRecord(
	node: CanvasNode,
	activeProvider: string,
	region: string,
	modelId: string,
	sourceHash: string,
): CustomVoiceRecord | null {
	return getCustomVoiceRecords(node).find(record =>
		record.provider === activeProvider
		&& record.region === region
		&& record.modelId === modelId
		&& (record.kind === 'design' || record.sourceHash === sourceHash)
	) || null
}

async function customVoiceRecordForOutput(
	app: BragiCanvas['app'],
	filePath: string,
	record: CustomVoiceRecord,
): Promise<CustomVoiceRecord> {
	if (record.kind !== 'clone') return record
	const binary = await app.vault.adapter.readBinary(filePath)
	return {
		...record,
		sourcePath: filePath,
		sourceHash: await sha256Hex(binary),
		createdAt: Date.now(),
	}
}

async function applyUpstreamVoiceReference(
	app: BragiCanvas['app'],
	canvas: Canvas,
	provider: AudioProvider,
	activeProvider: string,
	modelId: string,
	upstreamAudios: string[],
	voiceRefAudioIndex: number,
	audioParams: Record<string, unknown>,
): Promise<CustomVoiceRecord> {
	const audioPaths = [...new Set(upstreamAudios)]
	if (audioPaths.length === 0) {
		throw new Error('Voice reference needs an upstream audio file.')
	}
	if (activeProvider !== 'dashscope' || !providerSupportsVoiceClone(provider)) {
		throw new Error('Voice reference is currently available with DashScope TTS models.')
	}

	if (voiceRefAudioIndex < 0 || voiceRefAudioIndex >= audioPaths.length) {
		throw new Error('Selected voice reference audio is no longer connected.')
	}

	const sourcePath = audioPaths[voiceRefAudioIndex]
	const audioNode = findFileNodeByPath(canvas, sourcePath)
	if (!audioNode) throw new Error('Voice cloning could not find the upstream audio node.')

	const binary = await app.vault.adapter.readBinary(sourcePath)
	const sourceHash = await sha256Hex(binary)
	const region = 'cn-beijing'
	const existing = reusableVoiceRecord(audioNode, activeProvider, region, modelId, sourceHash)

	if (existing) {
		audioParams.voice = existing.voiceId
		audioParams.voiceLabel = existing.name || existing.voiceId
		return existing
	}

	new Notice('Creating voice reference...')
	const ext = getFileExtension(sourcePath, 'mp3')
	const audioUrl = await uploadRef(undefined, binary, `voice.${ext}`, audioMimeType(sourcePath))
	const clone = await provider.cloneVoice({
		modelId,
		audioUrl,
		sourceHash,
		sourcePath,
	})

	const record: CustomVoiceRecord = {
		kind: 'clone',
		provider: activeProvider,
		region,
		modelId,
		sourceHash,
		sourcePath,
		voiceId: clone.voiceId,
		name: clone.name,
		previewUrl: clone.previewUrl,
		createdAt: Date.now(),
	}
	upsertCustomVoiceRecord(audioNode, record)
	await canvas.requestSave?.()
	audioParams.voice = clone.voiceId
	audioParams.voiceLabel = clone.name || clone.voiceId
	return record
}

async function applyVoiceDesign(
	provider: AudioProvider,
	activeProvider: string,
	modelId: string,
	upstreamPrompts: string[],
	voiceDesignTextIndex: number,
	previewText: string,
	audioParams: Record<string, unknown>,
): Promise<CustomVoiceRecord> {
	if (activeProvider !== 'dashscope' || !providerSupportsVoiceDesign(provider)) {
		throw new Error('Voice design is currently available with DashScope TTS models.')
	}
	if (!previewText.trim()) {
		throw new Error('Voice design needs text to read from the current node.')
	}
	if (voiceDesignTextIndex < 0 || voiceDesignTextIndex >= upstreamPrompts.length) {
		throw new Error('Selected voice design prompt is no longer connected.')
	}
	const voicePrompt = upstreamPrompts[voiceDesignTextIndex]?.trim()
	if (!voicePrompt) throw new Error('Voice design prompt is empty.')

	new Notice('Designing voice...')
	const promptHash = await sha256Text(voicePrompt)
	const design = await provider.designVoice({
		modelId,
		voicePrompt,
		previewText,
		promptHash,
	})
	const record: CustomVoiceRecord = {
		kind: 'design',
		provider: activeProvider,
		region: 'cn-beijing',
		modelId,
		promptHash,
		voicePrompt,
		voiceId: design.voiceId,
		name: design.name,
		previewUrl: design.previewUrl,
		createdAt: Date.now(),
	}
	audioParams.voice = design.voiceId
	audioParams.voiceLabel = design.name || design.voiceId
	return record
}

function readVoiceRefAudioIndex(value: unknown): number {
	const parsed = typeof value === 'number'
		? value
		: typeof value === 'string'
			? parseInt(value, 10)
			: 0
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
}

function readVoiceDesignTextIndex(value: unknown): number {
	const parsed = typeof value === 'number'
		? value
		: typeof value === 'string'
			? parseInt(value, 10)
			: 0
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0
}

function getFileExtension(filePath: string, fallback: string): string {
	return filePath.split('.').pop()?.toLowerCase() || fallback
}

function audioMimeType(filePath: string): string {
	const ext = getFileExtension(filePath, 'mp3')
	if (ext === 'wav') return 'audio/wav'
	if (ext === 'm4a' || ext === 'mp4') return 'audio/mp4'
	if (ext === 'aac') return 'audio/aac'
	if (ext === 'flac') return 'audio/flac'
	if (ext === 'ogg') return 'audio/ogg'
	if (ext === 'opus') return 'audio/opus'
	return 'audio/mpeg'
}

function videoMimeType(filePath: string): string {
	const ext = getFileExtension(filePath, 'mp4')
	if (ext === 'mov') return 'video/quicktime'
	if (ext === 'webm') return 'video/webm'
	return 'video/mp4'
}

function textProviderSupportsVideoRefs(activeProvider: string): boolean {
	return activeProvider === 'gemini'
}

/* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- Resume strict linting after the runtime-shaped data boundary. */

/**
 * Grid detection + tile extraction for collage-style images.
 * Ported from gridshots (https://github.com/simon/gridshots) — vanilla Canvas 2D
 * instead of opencv.js. All thresholds preserved exactly.
 */

const MIN_CELL_PIXELS = 100
const MAX_ANALYSIS_SIZE = 1600
const MIN_GRID = 1
const MAX_GRID = 5
const TOP_K_PERIODS = 3
const MIN_PEAK_OVER_MEAN = 4
const MIN_PEAK_OF_MAX = 0.55

const DARK_THRESHOLD = 35
const MAX_TRIM_RATIO = 0.15

export interface GridDetectionResult {
	rows: number
	cols: number
	rowCuts: number[]
	colCuts: number[]
	safeMargin: number
	method: 'lines' | 'comb'
	targetTileWidth: number
	targetTileHeight: number
}

export interface TileResult {
	row: number
	col: number
	blob: Blob
	width: number
	height: number
}

// ── Image → HTMLImageElement ─────────────────────────────────────────

export async function loadImageFromBinary(binary: ArrayBuffer, mime: string): Promise<HTMLImageElement> {
	const blob = new Blob([binary], { type: mime })
	const url = URL.createObjectURL(blob)
	try {
		return await new Promise<HTMLImageElement>((resolve, reject) => {
			const img = new Image()
			img.onload = () => resolve(img)
			img.onerror = () => reject(new Error('image load failed'))
			img.src = url
		})
	} finally {
		// Don't revoke until caller is done; we'll revoke after use
		// (we rely on browser GC — practically fine)
	}
}

// ── Detection ─────────────────────────────────────────────────────────

export async function detectGrid(img: HTMLImageElement): Promise<GridDetectionResult> {
	const { width, height } = img

	const minAnalysisSize = MIN_CELL_PIXELS * MAX_GRID
	const baseSize = Math.max(minAnalysisSize, Math.min(MAX_ANALYSIS_SIZE, Math.max(width, height)))
	const scale = Math.min(1, baseSize / Math.max(width, height))
	const analysisW = Math.round(width * scale)
	const analysisH = Math.round(height * scale)

	const grayData = rasterizeToGray(img, analysisW, analysisH, true)
	const { rowDiff, colDiff } = computeDiffProjections(grayData, analysisW, analysisH)
	const { rowIntensity, colIntensity } = computeIntensityProjections(grayData, analysisW, analysisH)

	// Half-resolution multi-scale
	const halfW = Math.round(analysisW / 2)
	const halfH = Math.round(analysisH / 2)
	const halfGrayData = rasterizeToGray(img, halfW, halfH, true)
	const { rowDiff: rowDiffHalf, colDiff: colDiffHalf } = computeDiffProjections(halfGrayData, halfW, halfH)

	// Strategy 1: line detection
	const lineResult = detectByLines(rowIntensity, colIntensity, analysisW, analysisH)

	if (lineResult) {
		const rowAxisReal = axisScore(rowDiff, lineResult.rows, analysisH) > 0
		const colAxisReal = axisScore(colDiff, lineResult.cols, analysisW) > 0

		if (rowAxisReal && colAxisReal) {
			const safeMargin = Math.max(2, Math.round(lineResult.lineWidth / scale / 2) + 1)
			return {
				rows: lineResult.rows,
				cols: lineResult.cols,
				rowCuts: lineResult.rowCuts.map(y => Math.round(y / scale)),
				colCuts: lineResult.colCuts.map(x => Math.round(x / scale)),
				safeMargin,
				method: 'lines',
				...computeTargetTileSize(width, height, lineResult.rows, lineResult.cols, safeMargin),
			}
		}
	}

	// Strategy 2: comb scoring
	const combResult = detectByCombScoring(rowDiff, colDiff, rowDiffHalf, colDiffHalf, analysisW, analysisH, halfW, halfH)
	const safeMargin = Math.max(2, Math.round(3 / scale))
	return {
		rows: combResult.rows,
		cols: combResult.cols,
		rowCuts: combResult.rowCuts.map(y => Math.round(y / scale)),
		colCuts: combResult.colCuts.map(x => Math.round(x / scale)),
		safeMargin,
		method: 'comb',
		...computeTargetTileSize(width, height, combResult.rows, combResult.cols, safeMargin),
	}
}

// ── Split ─────────────────────────────────────────────────────────────

export async function splitGrid(img: HTMLImageElement, detection: GridDetectionResult): Promise<TileResult[]> {
	const { width, height } = img
	const { rows, cols, rowCuts, colCuts, safeMargin, targetTileWidth, targetTileHeight } = detection

	const tiles: TileResult[] = []
	const yBounds = [0, ...rowCuts, height]
	const xBounds = [0, ...colCuts, width]

	for (let row = 0; row < rows; row++) {
		for (let col = 0; col < cols; col++) {
			let x0 = xBounds[col]
			let x1 = xBounds[col + 1]
			let y0 = yBounds[row]
			let y1 = yBounds[row + 1]

			const minMargin = Math.max(1, Math.floor(safeMargin / 2))
			if (col > 0) x0 += minMargin
			if (col < cols - 1) x1 -= minMargin
			if (row > 0) y0 += minMargin
			if (row < rows - 1) y1 -= minMargin

			const rawWidth = Math.max(1, x1 - x0)
			const rawHeight = Math.max(1, y1 - y0)

			const tile = await extractAndTrimTile(
				img,
				x0, y0, rawWidth, rawHeight,
				targetTileWidth, targetTileHeight,
				{ top: row > 0, bottom: row < rows - 1, left: col > 0, right: col < cols - 1 },
			)

			tiles.push({
				row,
				col,
				blob: tile.blob,
				width: targetTileWidth,
				height: targetTileHeight,
			})
		}
	}

	return tiles
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Draw image to a canvas at the given size, optionally apply a 3x3 Gaussian blur, return grayscale Uint8Array. */
function rasterizeToGray(img: HTMLImageElement, w: number, h: number, blur: boolean): Uint8Array {
	const canvas = document.createElement('canvas')
	canvas.width = w
	canvas.height = h
	const ctx = canvas.getContext('2d', { willReadFrequently: true })!
	ctx.drawImage(img, 0, 0, w, h)
	const imageData = ctx.getImageData(0, 0, w, h)
	const rgba = imageData.data

	// RGBA → grayscale (ITU-R 601)
	const gray = new Uint8Array(w * h)
	for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
		gray[j] = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000 | 0
	}

	if (!blur) return gray
	return gaussianBlur3x3(gray, w, h)
}

/** Approximate 3x3 Gaussian blur (kernel [1,2,1;2,4,2;1,2,1] / 16). */
function gaussianBlur3x3(src: Uint8Array, w: number, h: number): Uint8Array {
	const out = new Uint8Array(w * h)
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const ym1 = Math.max(0, y - 1), yp1 = Math.min(h - 1, y + 1)
			const xm1 = Math.max(0, x - 1), xp1 = Math.min(w - 1, x + 1)
			const s =
				src[ym1 * w + xm1] * 1 + src[ym1 * w + x] * 2 + src[ym1 * w + xp1] * 1 +
				src[y * w + xm1] * 2 + src[y * w + x] * 4 + src[y * w + xp1] * 2 +
				src[yp1 * w + xm1] * 1 + src[yp1 * w + x] * 2 + src[yp1 * w + xp1] * 1
			out[y * w + x] = (s + 8) >> 4
		}
	}
	return out
}

function computeDiffProjections(grayData: Uint8Array, width: number, height: number) {
	const rowDiff: number[] = [0]
	for (let y = 1; y < height; y++) {
		let sum = 0
		for (let x = 0; x < width; x++) {
			sum += Math.abs(grayData[y * width + x] - grayData[(y - 1) * width + x])
		}
		rowDiff.push(sum / width)
	}
	const colDiff: number[] = [0]
	for (let x = 1; x < width; x++) {
		let sum = 0
		for (let y = 0; y < height; y++) {
			sum += Math.abs(grayData[y * width + x] - grayData[y * width + (x - 1)])
		}
		colDiff.push(sum / height)
	}
	return { rowDiff, colDiff }
}

function computeIntensityProjections(grayData: Uint8Array, width: number, height: number) {
	const rowIntensity: number[] = []
	for (let y = 0; y < height; y++) {
		let sum = 0
		for (let x = 0; x < width; x++) sum += grayData[y * width + x]
		rowIntensity.push(sum / width)
	}
	const colIntensity: number[] = []
	for (let x = 0; x < width; x++) {
		let sum = 0
		for (let y = 0; y < height; y++) sum += grayData[y * width + x]
		colIntensity.push(sum / height)
	}
	return { rowIntensity, colIntensity }
}

function computeTargetTileSize(imgWidth: number, imgHeight: number, rows: number, cols: number, safeMargin: number) {
	const totalMarginX = safeMargin * 2 * (cols - 1)
	const totalMarginY = safeMargin * 2 * (rows - 1)
	const targetTileWidth = Math.floor((imgWidth - totalMarginX) / cols)
	const targetTileHeight = Math.floor((imgHeight - totalMarginY) / rows)
	return { targetTileWidth, targetTileHeight }
}

function axisScore(diff: number[], numCells: number, size: number): number {
	if (numCells <= 1) return 0
	const cell = size / numCells
	const radius = Math.max(3, Math.round(cell * 0.15))
	const projMax = Math.max(...diff)
	const projMean = mean(diff)
	const peaks: number[] = []
	for (let i = 1; i < numCells; i++) {
		const pos = Math.round(cell * i)
		peaks.push(getLocalPeak(diff, pos, radius))
	}
	const minPeak = Math.min(...peaks)
	if (minPeak < projMean * MIN_PEAK_OVER_MEAN) return 0
	if (minPeak < projMax * MIN_PEAK_OF_MAX) return 0
	return peaks.reduce((a, b) => a + b, 0)
}

function combScore(rowDiff: number[], colDiff: number[], rows: number, cols: number, width: number, height: number): number {
	return axisScore(rowDiff, rows, height) + axisScore(colDiff, cols, width)
}

function getLocalPeak(projection: number[], pos: number, radius: number): number {
	let maxVal = 0
	for (let i = pos - radius; i <= pos + radius; i++) {
		if (i >= 0 && i < projection.length) maxVal = Math.max(maxVal, projection[i])
	}
	return maxVal
}

function detectByCombScoring(
	rowDiff: number[], colDiff: number[],
	rowDiffHalf: number[], colDiffHalf: number[],
	width: number, height: number,
	halfW: number, halfH: number,
): { rows: number; cols: number; rowCuts: number[]; colCuts: number[]; score: number } {
	const rowPeriodCandidates = getTopKPeriods(rowDiff, height, TOP_K_PERIODS)
	const colPeriodCandidates = getTopKPeriods(colDiff, width, TOP_K_PERIODS)

	const rowCandidatesSet = new Set<number>()
	const colCandidatesSet = new Set<number>()
	for (const period of rowPeriodCandidates) {
		const count = Math.round(height / period)
		if (count >= MIN_GRID && count <= MAX_GRID) rowCandidatesSet.add(count)
	}
	for (const period of colPeriodCandidates) {
		const count = Math.round(width / period)
		if (count >= MIN_GRID && count <= MAX_GRID) colCandidatesSet.add(count)
	}
	for (let i = MIN_GRID; i <= MAX_GRID; i++) {
		rowCandidatesSet.add(i)
		colCandidatesSet.add(i)
	}

	const rowCandidates = Array.from(rowCandidatesSet)
	const colCandidates = Array.from(colCandidatesSet)

	let bestScore = -Infinity
	let bestResult = { rows: 1, cols: 1, rowCuts: [] as number[], colCuts: [] as number[], score: 0 }

	for (const rows of rowCandidates) {
		for (const cols of colCandidates) {
			const score1 = combScore(rowDiff, colDiff, rows, cols, width, height)
			const score2 = combScore(rowDiffHalf, colDiffHalf, rows, cols, halfW, halfH)
			const totalScore = (score1 + score2) / 2

			const cellsNow = rows * cols
			const cellsBest = bestResult.rows * bestResult.cols
			const isBetter = totalScore > bestScore + 1e-6
				|| (Math.abs(totalScore - bestScore) < 1e-6 && cellsNow < cellsBest)

			if (isBetter) {
				bestScore = totalScore
				const rowCuts = generateCuts(rowDiff, height, rows)
				const colCuts = generateCuts(colDiff, width, cols)
				bestResult = { rows, cols, rowCuts, colCuts, score: totalScore }
			}
		}
	}

	return bestResult
}

function getTopKPeriods(projection: number[], size: number, k: number): number[] {
	const minPeriod = Math.floor(size / MAX_GRID)
	const maxPeriod = Math.floor(size / MIN_GRID)
	const m = mean(projection)
	const normalized = projection.map(v => v - m)
	const correlations: { period: number; corr: number }[] = []

	for (let period = minPeriod; period <= maxPeriod; period++) {
		let corr = 0
		let count = 0
		for (let i = 0; i < projection.length - period; i++) {
			corr += normalized[i] * normalized[i + period]
			count++
		}
		if (count > 0) correlations.push({ period, corr: corr / count })
	}

	correlations.sort((a, b) => b.corr - a.corr)

	const result: number[] = []
	for (const { period } of correlations) {
		if (result.length >= k) break
		let isHarmonic = false
		for (const existing of result) {
			const ratio = period / existing
			if (Math.abs(ratio - Math.round(ratio)) < 0.15) { isHarmonic = true; break }
		}
		if (!isHarmonic) result.push(period)
	}
	return result
}

function generateCuts(diff: number[], size: number, numCells: number): number[] {
	const cuts: number[] = []
	const cellSize = size / numCells
	const searchRange = Math.round(cellSize * 0.15)
	for (let i = 1; i < numCells; i++) {
		const idealPos = Math.round(cellSize * i)
		let bestPos = idealPos
		let bestVal = -Infinity
		for (let offset = -searchRange; offset <= searchRange; offset++) {
			const pos = idealPos + offset
			if (pos > 0 && pos < size - 1) {
				const val = getLocalPeak(diff, pos, 2)
				if (val > bestVal) { bestVal = val; bestPos = pos }
			}
		}
		cuts.push(bestPos)
	}
	return cuts
}

function detectByLines(rowProj: number[], colProj: number[], width: number, height: number): { rows: number; cols: number; rowCuts: number[]; colCuts: number[]; lineWidth: number } | null {
	const rowPeaks = findDarkPeaks(rowProj, height)
	const colPeaks = findDarkPeaks(colProj, width)

	if (rowPeaks.peaks.length < 1 || colPeaks.peaks.length < 1) return null

	const rowCells = rowPeaks.peaks.length + 1
	const colCells = colPeaks.peaks.length + 1

	if (rowCells < MIN_GRID || rowCells > MAX_GRID || colCells < MIN_GRID || colCells > MAX_GRID) return null
	if (!isUniformSpacing(rowPeaks.peaks, height) || !isUniformSpacing(colPeaks.peaks, width)) return null

	return {
		rows: rowCells,
		cols: colCells,
		rowCuts: rowPeaks.peaks,
		colCuts: colPeaks.peaks,
		lineWidth: Math.max(rowPeaks.lineWidth, colPeaks.lineWidth),
	}
}

function findDarkPeaks(projection: number[], size: number): { peaks: number[]; lineWidth: number } {
	const minVal = Math.min(...projection)
	const maxVal = Math.max(...projection)
	const range = maxVal - minVal
	if (range < 15) return { peaks: [], lineWidth: 0 }

	const sorted = [...projection].sort((a, b) => a - b)
	const p10 = sorted[Math.floor(sorted.length * 0.1)]
	const darkThreshold = p10 + range * 0.15
	const minDist = Math.floor(size * 0.04)

	const darkRegions: { start: number; end: number; minIdx: number }[] = []
	let inDark = false
	let start = 0
	let minIdx = 0
	let minInRegion = 255

	for (let i = 0; i < projection.length; i++) {
		const val = projection[i]
		if (val < darkThreshold) {
			if (!inDark) { inDark = true; start = i; minInRegion = val; minIdx = i }
			else if (val < minInRegion) { minInRegion = val; minIdx = i }
		} else {
			if (inDark) { darkRegions.push({ start, end: i - 1, minIdx }); inDark = false }
		}
	}

	const edgeMargin = size * 0.04
	const filtered = darkRegions.filter(r => {
		const center = (r.start + r.end) / 2
		return center > edgeMargin && center < size - edgeMargin
	})

	const merged: { start: number; end: number; minIdx: number }[] = []
	for (const r of filtered) {
		if (merged.length === 0) merged.push(r)
		else {
			const last = merged[merged.length - 1]
			if (r.start - last.end < minDist) {
				last.end = r.end
				if (projection[r.minIdx] < projection[last.minIdx]) last.minIdx = r.minIdx
			} else merged.push(r)
		}
	}

	const peaks = merged.map(r => Math.round((r.start + r.end) / 2))
	const lineWidth = merged.length > 0
		? Math.round(merged.reduce((sum, r) => sum + (r.end - r.start + 1), 0) / merged.length)
		: 0

	return { peaks, lineWidth }
}

function isUniformSpacing(peaks: number[], size: number): boolean {
	if (peaks.length === 0 || peaks.length === 1) return true
	const points = [0, ...peaks, size]
	const gaps: number[] = []
	for (let i = 1; i < points.length; i++) gaps.push(points[i] - points[i - 1])
	const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length
	const maxDeviation = avgGap * 0.35
	return gaps.every(g => Math.abs(g - avgGap) < maxDeviation)
}

function mean(arr: number[]): number {
	if (arr.length === 0) return 0
	return arr.reduce((a, b) => a + b, 0) / arr.length
}

// ── Tile extract + trim + normalize ───────────────────────────────────

interface TrimEdges { top: boolean; bottom: boolean; left: boolean; right: boolean }

async function extractAndTrimTile(
	img: HTMLImageElement,
	srcX: number, srcY: number, srcWidth: number, srcHeight: number,
	targetWidth: number, targetHeight: number,
	trimEdges: TrimEdges,
): Promise<{ blob: Blob }> {
	const tempCanvas = document.createElement('canvas')
	tempCanvas.width = srcWidth
	tempCanvas.height = srcHeight
	const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true })!
	tempCtx.drawImage(img, srcX, srcY, srcWidth, srcHeight, 0, 0, srcWidth, srcHeight)

	const imageData = tempCtx.getImageData(0, 0, srcWidth, srcHeight)
	const { data } = imageData

	const maxTrimX = Math.floor(srcWidth * MAX_TRIM_RATIO)
	const maxTrimY = Math.floor(srcHeight * MAX_TRIM_RATIO)

	let trimTop = 0, trimBottom = 0, trimLeft = 0, trimRight = 0
	if (trimEdges.top) trimTop = detectDarkEdge(data, srcWidth, srcHeight, 'top', maxTrimY)
	if (trimEdges.bottom) trimBottom = detectDarkEdge(data, srcWidth, srcHeight, 'bottom', maxTrimY)
	if (trimEdges.left) trimLeft = detectDarkEdge(data, srcWidth, srcHeight, 'left', maxTrimX)
	if (trimEdges.right) trimRight = detectDarkEdge(data, srcWidth, srcHeight, 'right', maxTrimX)

	const trimmedX = trimLeft
	const trimmedY = trimTop
	const trimmedW = srcWidth - trimLeft - trimRight
	const trimmedH = srcHeight - trimTop - trimBottom

	if (trimmedW < 1 || trimmedH < 1) {
		return extractNormalizedTile(tempCanvas, 0, 0, srcWidth, srcHeight, targetWidth, targetHeight)
	}
	return extractNormalizedTile(tempCanvas, trimmedX, trimmedY, trimmedW, trimmedH, targetWidth, targetHeight)
}

function detectDarkEdge(data: Uint8ClampedArray, width: number, height: number, edge: 'top' | 'bottom' | 'left' | 'right', maxTrim: number): number {
	let trimAmount = 0
	if (edge === 'top') {
		for (let y = 0; y < maxTrim; y++) {
			if (isRowDark(data, width, y)) trimAmount = y + 1
			else break
		}
	} else if (edge === 'bottom') {
		for (let y = height - 1; y >= height - maxTrim; y--) {
			if (isRowDark(data, width, y)) trimAmount = height - y
			else break
		}
	} else if (edge === 'left') {
		for (let x = 0; x < maxTrim; x++) {
			if (isColDark(data, width, height, x)) trimAmount = x + 1
			else break
		}
	} else if (edge === 'right') {
		for (let x = width - 1; x >= width - maxTrim; x--) {
			if (isColDark(data, width, height, x)) trimAmount = width - x
			else break
		}
	}
	return trimAmount
}

function isRowDark(data: Uint8ClampedArray, width: number, y: number): boolean {
	let total = 0
	for (let x = 0; x < width; x++) {
		const idx = (y * width + x) * 4
		total += (data[idx] + data[idx + 1] + data[idx + 2]) / 3
	}
	return (total / width) < DARK_THRESHOLD
}

function isColDark(data: Uint8ClampedArray, width: number, height: number, x: number): boolean {
	let total = 0
	for (let y = 0; y < height; y++) {
		const idx = (y * width + x) * 4
		total += (data[idx] + data[idx + 1] + data[idx + 2]) / 3
	}
	return (total / height) < DARK_THRESHOLD
}

async function extractNormalizedTile(
	source: HTMLCanvasElement,
	srcX: number, srcY: number, srcWidth: number, srcHeight: number,
	targetWidth: number, targetHeight: number,
): Promise<{ blob: Blob }> {
	const canvas = document.createElement('canvas')
	canvas.width = targetWidth
	canvas.height = targetHeight
	const ctx = canvas.getContext('2d')!

	const srcAspect = srcWidth / srcHeight
	const targetAspect = targetWidth / targetHeight

	let cropX = srcX, cropY = srcY, cropW = srcWidth, cropH = srcHeight

	if (srcAspect > targetAspect) {
		const newWidth = srcHeight * targetAspect
		const xOffset = (srcWidth - newWidth) / 2
		cropX = srcX + xOffset
		cropW = newWidth
	} else if (srcAspect < targetAspect) {
		const newHeight = srcWidth / targetAspect
		const yOffset = (srcHeight - newHeight) / 2
		cropY = srcY + yOffset
		cropH = newHeight
	}

	ctx.drawImage(source, cropX, cropY, cropW, cropH, 0, 0, targetWidth, targetHeight)

	const blob = await new Promise<Blob>((resolve, reject) => {
		canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png')
	})
	return { blob }
}

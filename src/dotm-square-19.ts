/** DotmSquare19 loader math (MIT-inspired, see dotmatrix loaders/dotm-square-19). */

const DOTM_SIZE = 5
const STEP_COUNT = 48
const CYCLE_MS = 1700
const BASE_OPACITY = 0
const SECONDARY_TRAIL_OPACITY = 0.32
const PRIMARY_TRAIL_OPACITY = 0.62
const PEAK_OPACITY = 1
const CURVE_OPACITY = 0.2

interface Point {
	x: number
	y: number
}

type LoaderWithStop = HTMLElement & { _bragiSquare19Stop?: () => void }

const CURVE_SAMPLES: readonly Point[] = Array.from({ length: 96 }, (_, index) => {
	const t = (index / 96) * Math.PI * 2
	return { x: Math.sin(t), y: 0.58 * Math.sin(2 * t) }
})

function gridPoint(row: number, col: number): Point {
	return { x: (col - 2) / 2, y: (2 - row) / 2 }
}

function loopPoint(step: number): Point {
	const t = ((step % STEP_COUNT) / STEP_COUNT) * Math.PI * 2
	return { x: Math.sin(t), y: 0.58 * Math.sin(2 * t) }
}

function squaredDistance(a: Point, b: Point): number {
	const dx = a.x - b.x
	const dy = a.y - b.y
	return dx * dx + dy * dy
}

function minCurveDistanceSq(point: Point): number {
	let min = Number.POSITIVE_INFINITY
	for (const sample of CURVE_SAMPLES) {
		min = Math.min(min, squaredDistance(point, sample))
	}
	return min
}

function headInfluence(dot: Point, head: Point): number {
	return Math.exp(-squaredDistance(dot, head) / 0.19)
}

export function square19Opacity(row: number, col: number, step: number, reducedMotion: boolean): number {
	const dot = gridPoint(row, col)

	if (reducedMotion) {
		const curveGlow = Math.exp(-minCurveDistanceSq(dot) / 0.2)
		const centerBoost = Math.exp(-(dot.x * dot.x + dot.y * dot.y) / 0.06)
		return Math.min(PEAK_OPACITY, BASE_OPACITY + curveGlow * CURVE_OPACITY + centerBoost * 0.18)
	}

	const headA = loopPoint(step)
	const headB = loopPoint(step + STEP_COUNT / 2)
	const trailA = loopPoint(step - 4)
	const trailB = loopPoint(step + STEP_COUNT / 2 - 4)

	const lead = Math.max(headInfluence(dot, headA), headInfluence(dot, headB))
	const trail = Math.max(headInfluence(dot, trailA), headInfluence(dot, trailB))
	const centerPulse = Math.exp(-(dot.x * dot.x + dot.y * dot.y) / 0.05) * (0.45 + 0.55 * lead)

	const opacity =
		BASE_OPACITY +
		SECONDARY_TRAIL_OPACITY * trail +
		PRIMARY_TRAIL_OPACITY * lead +
		0.16 * centerPulse

	return Math.min(PEAK_OPACITY, opacity)
}

function stepAt(now: number, start: number): number {
	const stepMs = CYCLE_MS / STEP_COUNT
	const elapsed = Math.max(0, now - start)
	return Math.floor((elapsed % CYCLE_MS) / stepMs) % STEP_COUNT
}

export function buildSquare19Grid(loader: HTMLElement): void {
	const grid = loader.createDiv({ cls: 'bragi-dmx-grid' })
	for (let row = 0; row < DOTM_SIZE; row++) {
		for (let col = 0; col < DOTM_SIZE; col++) {
			const dot = grid.createSpan({ cls: 'bragi-dmx-dot' })
			dot.dataset.bragiRow = String(row)
			dot.dataset.bragiCol = String(col)
		}
	}
}

export function mountSquare19Loader(loader: HTMLElement): void {
	stopSquare19Loader(loader)
	const grid = loader.querySelector<HTMLElement>('.bragi-dmx-grid')
	if (!grid) return

	const dots = Array.from(grid.querySelectorAll<HTMLElement>('.bragi-dmx-dot'))
	const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
	const start = performance.now()
	let rafId = 0

	const tick = (now: number) => {
		const step = stepAt(now, start)
		for (const dot of dots) {
			const row = Number(dot.dataset.bragiRow)
			const col = Number(dot.dataset.bragiCol)
			dot.style.opacity = String(square19Opacity(row, col, step, reducedMotion))
		}
		rafId = window.requestAnimationFrame(tick)
	}

	rafId = window.requestAnimationFrame(tick)
	const el = loader as LoaderWithStop
	el._bragiSquare19Stop = () => {
		window.cancelAnimationFrame(rafId)
		delete el._bragiSquare19Stop
	}
}

export function stopSquare19Loader(loader: LoaderWithStop | null | undefined): void {
	loader?._bragiSquare19Stop?.()
}

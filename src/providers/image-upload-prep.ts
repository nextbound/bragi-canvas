export interface PreparedUpload {
	bytes: ArrayBuffer
	fileName: string
	contentType: string
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
	avif: 'image/avif',
	bmp: 'image/bmp',
	gif: 'image/gif',
	heic: 'image/heic',
	heif: 'image/heif',
	jpeg: 'image/jpeg',
	jpg: 'image/jpeg',
	png: 'image/png',
	svg: 'image/svg+xml',
	tif: 'image/tiff',
	tiff: 'image/tiff',
	webp: 'image/webp',
}

function normalizeContentType(contentType: string): string {
	return contentType.split(';')[0]?.trim().toLowerCase() || ''
}

function getFileExtension(fileName: string): string {
	return fileName.split(/[?#]/)[0]?.split('.').pop()?.toLowerCase() || ''
}

function basenameWithoutExt(fileName: string): string {
	const clean = fileName.split(/[?#]/)[0] || fileName
	const slash = clean.lastIndexOf('/')
	const leaf = slash >= 0 ? clean.slice(slash + 1) : clean
	const dot = leaf.lastIndexOf('.')
	return dot > 0 ? leaf.slice(0, dot) : (leaf || 'ref')
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
	let result = ''
	for (let i = start; i < start + length && i < bytes.length; i++) {
		result += String.fromCharCode(bytes[i])
	}
	return result
}

function sniffImageMime(bytes: ArrayBuffer): string | null {
	const b = new Uint8Array(bytes)
	if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
	if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp'
	if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return 'image/gif'
	if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
	if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))) return 'image/tiff'
	if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') {
		const brand = ascii(b, 8, 4).toLowerCase()
		if (brand === 'avif' || brand === 'avis') return 'image/avif'
		if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx' || brand === 'mif1' || brand === 'msf1') return 'image/heic'
	}
	return null
}

function inferImageMime(fileName: string, contentType: string, bytes: ArrayBuffer): string {
	const sniffed = sniffImageMime(bytes)
	if (sniffed) return sniffed
	const normalized = normalizeContentType(contentType)
	if (normalized.startsWith('image/')) return normalized === 'image/jpg' ? 'image/jpeg' : normalized
	if (normalized && normalized !== 'application/octet-stream') return normalized
	const fromExt = IMAGE_MIME_BY_EXT[getFileExtension(fileName)]
	return fromExt || normalized
}

function isPngOrJpeg(mimeType: string): boolean {
	return mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/jpg'
}

function normalizePassthroughFileName(fileName: string, mimeType: string): string {
	const ext = getFileExtension(fileName)
	if (mimeType === 'image/png' && ext === 'png') return fileName
	if ((mimeType === 'image/jpeg' || mimeType === 'image/jpg') && (ext === 'jpg' || ext === 'jpeg')) return fileName
	return `${basenameWithoutExt(fileName)}.${mimeType === 'image/png' ? 'png' : 'jpg'}`
}

function convertImageToPng(bytes: ArrayBuffer, mimeType: string, context: string): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(new Blob([bytes], { type: mimeType || 'application/octet-stream' }))
		const image = new Image()
		let settled = false
		let timeout: number
		const finish = (fn: () => void) => {
			if (settled) return
			settled = true
			window.clearTimeout(timeout)
			URL.revokeObjectURL(url)
			fn()
		}
		timeout = window.setTimeout(() => {
			finish(() => reject(new Error(`${context}: image decode timed out`)))
		}, 15000)
		image.onload = () => {
			finish(() => {
				const width = image.naturalWidth || image.width
				const height = image.naturalHeight || image.height
				if (!width || !height) {
					reject(new Error(`${context}: image has no dimensions`))
					return
				}

				const canvas = createEl('canvas')
				canvas.width = width
				canvas.height = height
				const ctx = canvas.getContext('2d')
				if (!ctx) {
					reject(new Error(`${context}: could not create image canvas`))
					return
				}
				ctx.drawImage(image, 0, 0)
				canvas.toBlob(blob => {
					if (!blob) {
						reject(new Error(`${context}: could not convert image to PNG`))
						return
					}
					blob.arrayBuffer().then(resolve, reject)
				}, 'image/png')
			})
		}
		image.onerror = () => {
			finish(() => reject(new Error(`${context}: could not decode image for PNG upload`)))
		}
		image.src = url
	})
}

export function imageMimeTypeFromFileName(fileName: string): string {
	return IMAGE_MIME_BY_EXT[getFileExtension(fileName)] || ''
}

/**
 * Prepare a reference upload. Image uploads preserve PNG/JPEG and convert any
 * other image format to PNG so providers see a conservative input format.
 */
export async function prepareReferenceUpload(
	bytes: ArrayBuffer,
	fileName: string,
	contentType: string,
	context = 'Reference image upload',
): Promise<PreparedUpload> {
	const sourceMime = inferImageMime(fileName, contentType, bytes)
	if (!sourceMime.startsWith('image/')) {
		return { bytes, fileName, contentType }
	}

	if (isPngOrJpeg(sourceMime)) {
		const normalizedMime = sourceMime === 'image/png' ? 'image/png' : 'image/jpeg'
		return {
			bytes,
			fileName: normalizePassthroughFileName(fileName, normalizedMime),
			contentType: normalizedMime,
		}
	}

	return {
		bytes: await convertImageToPng(bytes, sourceMime, context),
		fileName: `${basenameWithoutExt(fileName)}.png`,
		contentType: 'image/png',
	}
}

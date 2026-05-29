import { uploadToBragiRelay, BUILTIN_BRAGI_RELAY } from './bragi-relay'
import { prepareReferenceUpload } from './image-upload-prep'

/**
 * Upload a reference asset via the built-in Bragi temporary storage worker and return its public URL.
 * Used by Seedance / fal / STT / audio-isolation flows that need a public URL for refs.
 *
 * The first arg is kept loose for back-compat with old call sites that passed R2Config
 * or BragiSettings; it's now ignored — everything goes through the built-in relay.
 */
export async function uploadRef(
	_unused: unknown,
	fileData: ArrayBuffer,
	fileName: string,
	contentType: string,
): Promise<string> {
	const prepared = await prepareReferenceUpload(fileData, fileName, contentType, 'Bragi temporary storage upload')
	return uploadToBragiRelay(BUILTIN_BRAGI_RELAY, prepared.bytes, prepared.fileName, prepared.contentType)
}

import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const source = readFileSync('src/providers/svnewapi.ts', 'utf8')
const directSeedanceSource = readFileSync('src/providers/seedance.ts', 'utf8')

assert.match(
	source,
	/const duration = optionalString\(params\.duration \|\| params\.durationSeconds\)/,
	'SV NewAPI video generation must read duration and durationSeconds.',
)

assert.match(
	source,
	/if \(modelId === SV_VIDEO_SEEDANCE\) \{[\s\S]*?if \(duration\) metadata\.duration = duration === '-1' \? -1 : parseInt\(duration, 10\)/,
	'SV NewAPI Seedance must forward Auto duration as metadata.duration = -1 to match direct Ark Seedance.',
)

assert.match(
	source,
	/\} else \{[\s\S]*?if \(duration && duration !== '-1'\) body\.duration = duration/,
	'SV NewAPI non-Seedance video models should continue omitting duration = -1.',
)

assert.match(
	directSeedanceSource,
	/const duration = parseInt\(params\?\.duration \|\| '5'\)[\s\S]*?duration,/,
	'Direct BytePlus/Volcengine Seedance must continue forwarding Auto duration as numeric -1.',
)

console.log('SV NewAPI video parameter checks passed.')

import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const scripts=JSON.parse(readFileSync('package.json','utf8')).scripts
const logs=mkdtempSync(join(tmpdir(),'bragi-tests-'))
let failures=0
for(const [name,command] of Object.entries(scripts).filter(([name])=>name.startsWith('test:'))){
 const args=command.split(' ')
 const result=spawnSync(args[0],args.slice(1),{encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024})
 writeFileSync(join(logs,`${name.replace(':','-')}.log`),(result.stdout||'')+(result.stderr||'')+(result.error?.message||''))
 if(result.status!==0){failures++;console.error(`FAIL ${name} (${join(logs,`${name.replace(':','-')}.log`)})`)}else console.log(`PASS ${name}`)
}
console.log(`${failures} failed. Logs: ${logs}`);if(failures)process.exitCode=1

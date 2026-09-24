import {readFile,copyFile,stat} from 'node:fs/promises'
import {resolve,join} from 'node:path'
const argument=process.argv[2]
const directory=resolve(argument||(await readFile('.dev-vault-plugin','utf8')).trim())
if(!(await stat(directory)).isDirectory())throw new Error('Expected an existing vault plugin directory.')
for(const file of ['main.js','styles.css','manifest.json'])await copyFile(resolve(file),join(directory,file))
console.log(`Synced build to ${directory}`)

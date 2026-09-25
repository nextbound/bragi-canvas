import { build } from 'esbuild'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function testRuntime(exports) {
	const dir = await mkdtemp(join(tmpdir(), 'bragi-behavior-'))
	const stub = join(dir, 'obsidian.mjs')
	await writeFile(stub, `
export class Modal {}; export class Plugin {}; export class PluginSettingTab {}; export class Setting {};
export class Notice { constructor(message) { globalThis.__notices?.push(message) } setMessage() {} hide() {} };
export class TFile { constructor(path) { this.path=path } }; export class TFolder {};
export class WorkspaceLeaf {}; export function addIcon() {}; export function getLanguage(){ return 'en' };
export function normalizePath(path){return path}; export function setIcon() {}; export function setTooltip() {};
export async function requestUrl(options){return globalThis.__request(options)};
`)
	const outfile = join(dir, 'test.mjs')
	await build({stdin:{contents:exports,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',outfile,logLevel:'silent',plugins:[{
		name:'test-boundaries',setup(api){
			api.onResolve({filter:/^obsidian$/},()=>({path:stub,external:true}))
			api.onResolve({filter:/^\.\/canvas-ops$/},args=>args.importer.endsWith('task-queue.ts')?{path:'canvas-failure',namespace:'test'}:undefined)
			api.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export function markNodeFailed(node,message){node.failure=message};export function detachGeneratingOverlay(){}; export function setGeneratingStatus(node,status){node.presentation=status}',loader:'js'}))
		}
	}]})
	return { module:await import(pathToFileURL(outfile).href), cleanup:()=>rm(dir,{recursive:true,force:true}) }
}

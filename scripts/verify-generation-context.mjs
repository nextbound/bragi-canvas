import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
// Execute production methods with a minimal workspace instead of starting Obsidian.
const source=await readFile('src/main.ts','utf8')
const ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true)
const cls=ast.statements.find(n=>ts.isClassDeclaration(n)&&n.name?.text==='BragiCanvas')
const names=new Set(['saveSettings','startSingleGeneration','getCanvasPath'])
const methods=cls.members.filter(m=>m.name&&names.has(m.name.getText(ast))).map(m=>m.getText(ast)).join('\n')
const code=ts.transpileModule(`class Subject { settingsWrite=Promise.resolve(); syncGenerating=new Set(); ${methods} }`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
let resolveUpstream
const deferred=new Promise(r=>{resolveUpstream=r})
const deps={selectedVoiceMode:()=>'builtin',getCanvasFromNode:n=>n.canvas,getUpstreamInputs:()=>({prompts:[],images:[],videos:[],audios:[],pdfs:[]}),getOrderedPrompts:()=>deferred,computeOutputSize:()=>({w:100,h:100}),readAspectRatio:()=>undefined,createPlaceholderNode:()=>({id:'result'}),Notice:class{},markNodeFailed:()=>{},errorMessage:String}
const Subject=new Function(...Object.keys(deps),code+';return Subject')(...Object.values(deps))
const subject=new Subject(),a={},b={}
subject.app={workspace:{getLeavesOfType:()=>[{view:{canvas:a,file:{path:'A.canvas'}}},{view:{canvas:b,file:{path:'B.canvas'}}}]}}
let dir='assets-A';subject.getOutputDir=()=>dir
let origin;subject.runSingleGeneration=async(...args)=>{origin=args}
const submitting=subject.startSingleGeneration({id:'source',canvas:a},{prompt:'prompt',model:{name:'Test',type:'video'},params:{}})
dir='assets-B';resolveUpstream([]);assert.equal(await submitting,'result');assert.equal(origin[2],a);assert.equal(origin[7],'A.canvas');assert.equal(origin[8],'assets-A')
let inFlight=0,maxInFlight=0,releaseFirst
subject.settings={theme:'one'};subject.taskQueue={getSnapshots:()=>[{canvasPath:'A.canvas'},{canvasPath:'B.canvas'}]}
const persisted=[]
subject.saveData=async data=>{inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);if(persisted.length===0)await new Promise(r=>{releaseFirst=r});persisted.push(data);inFlight--}
const first=subject.saveSettings();await Promise.resolve();await Promise.resolve();subject.settings.theme='two';const second=subject.saveSettings();releaseFirst();await Promise.all([first,second]);assert.equal(maxInFlight,1);assert.equal(persisted[0].theme,'one');assert.equal(persisted[1].theme,'two');assert.equal(persisted[1]._pendingTasks.length,2)
console.log('Generation context and settings: source canvas/output captured before awaits; immutable snapshots and serialized saves passed.')

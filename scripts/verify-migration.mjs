import assert from 'node:assert/strict'
import {testRuntime} from './test-runtime.mjs'
const {module:{performMigration,TFile},cleanup}=await testRuntime("export {performMigration} from './src/migrate-assets'; export {TFile} from 'obsidian';")
try{
 for(const fail of [false,true]){
 const old=JSON.stringify({nodes:[{id:'image',type:'file',file:'assets/shared.png'},{id:'second',type:'file',file:'assets/second.png'}]})
 const files=new Map([['A.canvas',old],['B.canvas',old],['Note.md','![[assets/shared.png]]'],['assets/shared.png','image'],['assets/second.png','second'],['_bragi/assets/shared.png','existing']])
 const app={vault:{getAbstractFileByPath:path=>new TFile(path),read:async f=>files.get(f.path),modify:async(f,data)=>files.set(f.path,data),adapter:{exists:async path=>files.has(path),mkdir:async()=>{},list:async()=>({files:['_bragi/assets/shared.png']}),write:async(p,data)=>files.set(p,data),readBinary:async path=>{if(fail&&path.endsWith('second.png'))throw new Error('Read failed');return files.get(path)},writeBinary:async(p,data)=>files.set(p,data)}}}
 const plugin={app,rememberGeneratedAsset:()=>{}}
 if(fail)await assert.rejects(()=>performMigration(plugin,[],'A.canvas',['assets/shared.png','assets/second.png']),/Copied 1 files; 1 could not be copied/)
 else await performMigration(plugin,[],'A.canvas',['assets/shared.png','assets/second.png'])
 assert.equal(files.get('B.canvas'),old);assert.equal(files.get('Note.md'),'![[assets/shared.png]]');assert.equal(files.get('assets/shared.png'),'image');assert.equal(files.get('_bragi/assets/shared.png'),'existing');assert.equal(files.get('_bragi/assets/shared_2.png'),'image')
 assert.equal(JSON.parse(files.get('A.canvas')).nodes[0].file,'_bragi/assets/shared_2.png');assert.ok([...files.keys()].some(p=>p.startsWith('_bragi/backup/')&&files.get(p)===old))
 }
 console.log('Migration: shared originals, collision handling, backups and partial completion passed.')
}finally{await cleanup()}

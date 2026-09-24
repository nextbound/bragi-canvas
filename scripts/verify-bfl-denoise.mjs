import assert from 'node:assert/strict'
import {testRuntime} from './test-runtime.mjs'
const {module:{BflImageProvider,dimensionsFromParams,flux2Klein9b,inferMode},cleanup}=await testRuntime(`export * from './src/providers/bfl'; export {flux2Klein9b} from './src/models/flux'; export {inferMode} from './src/generation-mode';`)
try{
 assert.equal(inferMode(flux2Klein9b.modes,0,0), 'text-to-image')
 assert.equal(inferMode(flux2Klein9b.modes,1,0), 'image-ref-to-image')
 assert.equal(flux2Klein9b.inferModeFromInputs,true)
 assert.deepEqual(flux2Klein9b.supportedProviders.bfl.refDelivery,{image:'inline'})
 assert.deepEqual(flux2Klein9b.params.map(p=>p.id),['aspectRatio','targetLongEdge'])
 assert.deepEqual(flux2Klein9b.params[1].providerOverrides.runpod.options.map(o=>o.value),['1024','2048'])
 const dims=dimensionsFromParams({aspectRatio:'16:9'},2048);assert.equal(dims.width,2048);assert.equal(dims.height%16,0)
 const requests=[],writes=[]
 globalThis.window={setTimeout:(fn)=>setTimeout(fn,0)}
 globalThis.__request=async options=>{requests.push(options);if(options.method==='POST')return {status:200,json:{id:'test',polling_url:'https://test.local/poll'}};if(options.url.endsWith('/poll'))return {status:200,json:{status:'Ready',result:{sample:'https://test.local/image'}}};return {status:200,arrayBuffer:new Uint8Array([1,2,3]).buffer}}
 const provider=new BflImageProvider('test-key',{vault:{adapter:{exists:async()=>true,writeBinary:async(...args)=>writes.push(args)}}},'assets')
 const result=await provider.generateImage('A quiet sea',{aspectRatio:'16:9',targetLongEdge:2048})
 assert.equal(requests.filter(r=>r.method==='POST').length,1);assert.equal(writes.length,1)
 assert.ok(result.filePath.startsWith('assets/bfl_flux2_klein9b_'))
 assert.deepEqual([...new Uint8Array(writes[0][1])],[1,2,3])
 const sent=JSON.parse(requests[0].body);assert.equal(sent.width,dims.width);assert.equal(sent.prompt,'A quiet sea');assert.equal(sent.input_image,undefined)
 console.log('BFL mode inference, catalog controls, output dimensions and provider download passed.')
}finally{await cleanup()}

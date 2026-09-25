import assert from 'node:assert/strict'
import { testRuntime } from './test-runtime.mjs'
const { module: {TaskQueue, TaskPollingError, pollRequest, retryAfterMs}, cleanup } = await testRuntime(`
export {TaskQueue} from './src/task-queue'; export * from './src/task-errors';
`)
globalThis.window = {setInterval:()=>1,clearInterval:()=>{}}
globalThis.__notices=[]
const snapshot = (canvasPath='A.canvas',providerName='test') => ({taskId:'same-id',providerName,apiModelId:'test',modelName:'Test',canvasPath,sourceNodeId:'source',placeholderNodeId:'result',outputDir:'assets',startedAt:Date.now()})
const makeCanvas = () => {
	let data={nodes:[{id:'source',type:'text',text:'prompt',x:0,y:0,width:100,height:100},{id:'result',type:'text',text:'Working',x:150,y:0,width:100,height:100}],edges:[]}
	return {nodes:new Map([['result',{id:'result'}]]),removeNode(node){ this.nodes.delete(node.id) },getData:()=>structuredClone(data),importData(d){ assert.ok(!this.nodes.has('result') || data.nodes.find(n=>n.id==='result').type === 'file', 'Text runtime must be removed before importing a file with the same ID'); data=d },requestSave:async()=>{}}
}
try {
	// A settings save/restart must retain dormant B and IDs shared by different providers.
	let disk=[]
	let q=new TaskQueue();q.restore([snapshot(),snapshot('B.canvas','other')]);q.onChange=()=>{disk=q.getSnapshots()}
	let checks=0
	const pending={checkStatus:async()=>{checks++;return {done:false}}}
	q.bindCanvas(makeCanvas(),'A.canvas',()=>pending);await q.pollAll();await q.onChange()
	for(let i=0;i<3;i++){q.stop();q=new TaskQueue();q.restore(disk);q.onChange=()=>{disk=q.getSnapshots()};q.bindCanvas(makeCanvas(),'A.canvas',()=>pending);await q.pollAll();await q.onChange();assert.equal(disk.length,2)}
	assert.equal(checks,4);assert.equal(disk[1].canvasPath,'B.canvas');assert.equal(disk[1].outputType,'video');q.stop()

	// All attempts query the same accepted task; backoff is persisted and capped.
	q=new TaskQueue();q.restore([snapshot()]);const c=makeCanvas();const ids=[]
	q.bindCanvas(c,'A.canvas',()=>({checkStatus:async id=>{ids.push(id);throw new TaskPollingError('HTTP 503','retryable')}}))
	const now=Date.now;let clock=100000;Date.now=()=>clock
	try {for(const delay of [5000,10000,20000,40000,60000]){await q.pollAll();const task=q.getSnapshots()[0];assert.equal(task.nextRetryAt,clock+delay);await q.pollAll();clock+=delay}await q.pollAll();assert.equal(q.getSnapshots()[0].state,'needs-attention');assert.equal(c.nodes.get('result').presentation.paused,true);assert.deepEqual(ids,Array(6).fill('same-id'))}finally{Date.now=now;q.stop()}

	// A downloaded file is persisted before application and reused after a save failure.
	q=new TaskQueue();q.restore([snapshot()]);let downloads=0,saveFails=true,persisted=false
	q.onChange=()=>{if(q.getSnapshots()[0]?.filePath)persisted=true}
	c.requestSave=async()=>{assert.ok(persisted);if(saveFails)throw new Error('Network disk unavailable')}
	q.bindCanvas(c,'A.canvas',()=>({checkStatus:async()=>{downloads++;return {done:true,filePath:'assets/result.mp4'}}}))
	await q.pollAll();assert.equal(q.getSnapshots()[0].state,'needs-attention');assert.equal(downloads,1)
	saveFails=false;q.resume();await q.pollAll();assert.equal(q.activeCount,0);assert.equal(downloads,1);assert.equal(c.getData().nodes.find(n=>n.id==='result').file,'assets/result.mp4');q.stop()

	// Closing/rebinding a canvas during polling cannot write the old view.
	q=new TaskQueue();q.restore([snapshot()]);let finish;const old=makeCanvas(),fresh=makeCanvas();let oldWrites=0
	old.importData=()=>{oldWrites++}
	q.bindCanvas(old,'A.canvas',()=>({checkStatus:()=>new Promise(r=>{finish=r})}))
	const poll=q.pollAll();q.bindCanvas(fresh,'A.canvas',()=>pending);finish({done:true,filePath:'assets/result.mp4'});await poll;assert.equal(oldWrites,0);await q.pollAll();assert.equal(q.activeCount,0);q.stop()

	// A terminal response from an old binding must not mark its stale node.
	q=new TaskQueue();q.restore([snapshot()]);let rejectOld;const stale=makeCanvas();const staleNode=stale.nodes.get('result')
	q.bindCanvas(stale,'A.canvas',()=>({checkStatus:()=>new Promise((_,reject)=>{rejectOld=reject})}))
	const stalePoll=q.pollAll();q.bindCanvas(makeCanvas(),'A.canvas',()=>pending);rejectOld(new TaskPollingError('Remote cancelled','terminal'));await stalePoll;assert.equal(staleNode.failure,undefined);assert.equal(q.activeCount,0);q.stop()

	// Local writeback remains possible after a provider connection is removed.
	q=new TaskQueue();q.restore([{...snapshot(),filePath:'assets/downloaded.mp4',state:'needs-attention'}]);const local=makeCanvas()
	q.bindCanvas(local,'A.canvas',()=>null);q.resume();await q.pollAll();assert.equal(q.activeCount,0);assert.equal(local.getData().nodes[1].file,'assets/downloaded.mp4');q.stop()

	// Unload invalidates callbacks; malformed/auth errors remain recoverable.
	for(const unload of [false,true]){q=new TaskQueue();q.restore([snapshot()]);q.bindCanvas(makeCanvas(),'A.canvas',()=>({checkStatus:async()=>{if(unload)q.stop();throw new Error('Invalid API key')}}));await q.pollAll();assert.equal(q.activeCount,1);if(!unload)assert.equal(q.getSnapshots()[0].state,'needs-attention');q.stop()}
	for(const status of [408,429,503]){globalThis.__request=async()=>({status,headers:{'Retry-After':'15'}});await assert.rejects(()=>pollRequest('https://example.test/task'),e=>e.kind==='retryable'&&e.retryAfterMs===15000)}
	assert.equal(retryAfterMs('Thu, 24 Sep 2026 00:01:00 GMT',Date.parse('2026-09-24T00:00:00Z')),60000)
	globalThis.__request=async()=>({status:401,headers:{}});await assert.rejects(()=>pollRequest('https://example.test/task'),e=>e.kind==='attention')
	console.log('Task recovery: dormant snapshots, provider IDs, retry schedule, durable writeback, stale callbacks and HTTP classification passed.')
} finally {await cleanup()}

import assert from 'node:assert/strict'
import http from 'node:http'
import { testRuntime } from './test-runtime.mjs'
const {module:{BragiMcpServer},cleanup}=await testRuntime("export {BragiMcpServer} from './src/mcp-server';")
globalThis.window={setTimeout,clearTimeout}
const reservation=http.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r))
let token=''
const server=new BragiMcpServer(()=>null,{},undefined,()=>({mcpToken:token}))
const request=(headers={},body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}),options={})=>new Promise((resolve,reject)=>{
 const req=http.request({host:'127.0.0.1',port,path:'/mcp',method:'POST',headers:{'Content-Type':'application/json',...headers}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}))});req.on('error',reject)
 if(options.slow){req.flushHeaders();req.write(' ')}else req.end(body)
})
try{
 await server.start(port)
 const cli=await request();assert.equal(cli.status,200);assert.ok(JSON.parse(cli.body).result.tools.some(t=>t.name==='list_pending_tasks'));assert.equal(cli.headers['access-control-allow-origin'],undefined)
 const own=await request({Origin:`http://127.0.0.1:${port}`});assert.equal(own.status,200);assert.equal(own.headers['access-control-allow-origin'],`http://127.0.0.1:${port}`)
 for(const origin of ['https://untrusted.example','null',`http://localhost:${port}`,`http://127.0.0.1:${port+1}`]) assert.equal((await request({Origin:origin})).status,403)
 for(const host of ['evil.test',`evil.test:${port}`,`127.0.0.1:${port+1}`,`127.0.0.1:${port}.evil`])assert.equal((await request({Host:host})).status,403)
 assert.equal((await request({'Content-Type':'text/plain'})).status,415)
 assert.equal((await request({'Content-Length':String(64*1024*1024+1)},'')).status,413)
 assert.equal((await request({'Transfer-Encoding':'chunked'},Buffer.alloc(64*1024*1024+1,32))).status,413)
 token='test-token';assert.equal((await request()).status,401);assert.equal((await request({Authorization:'Bearer test-token'})).status,200)
 assert.equal((await request({},'',{slow:true})).status,408)
 console.log('MCP HTTP boundary: local CLI, exact origin, Host, JSON, streamed/declared limits, token and 30-second timeout passed.')
}finally{await server.stop();await cleanup()}

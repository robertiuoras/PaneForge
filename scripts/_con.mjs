const base='http://127.0.0.1:9333'
const list=await (await fetch(base+'/json/list')).json()
const page=list.find(t=>t.type==='page')
const ws=new WebSocket(page.webSocketDebuggerUrl)
const msgs=[]
ws.addEventListener('open',()=>{ws.send(JSON.stringify({id:1,method:'Runtime.enable'}));ws.send(JSON.stringify({id:2,method:'Log.enable'}));setTimeout(()=>{ws.send(JSON.stringify({id:3,method:'Page.reload'}))},300)})
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')msgs.push(m.params.exceptionDetails.exception?.description||JSON.stringify(m.params.exceptionDetails).slice(0,400));if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')msgs.push(m.params.args.map(a=>a.description||a.value).join(' ').slice(0,500))})
setTimeout(()=>{console.log(msgs.slice(0,6).join('\n---\n'));process.exit(0)},5000)

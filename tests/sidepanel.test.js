import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { parseHTML } from 'linkedom';
const root = resolve(import.meta.dirname, '..');
const selection = await import(`${root}/extension/selection.js`);
const flush = async () => { for (let i=0;i<12;i++) await new Promise(resolve=>setImmediate(resolve)); };
const file = { id:'f1', name:'课程.pdf', extension:'pdf', source:'当前页面', url:'https://school.example/f.pdf?signature=secret' };
async function app({ granted=true, cancel=false, external=false, hold=false, fail=false, cacheTab=3, deferScan=false, failProgress=false, deny=false, unsupported=false }={}) {
  const { window, document } = parseHTML(await readFile(`${root}/extension/sidepanel.html`,'utf8'));
  const calls=[]; const handlers={};
  window.location={href:'chrome-extension://test/sidepanel.html',hash:''};
  window.history={replaceState(_state,_unused,hash){calls.push({type:'replaceState',hash});window.location.hash=hash;window.location.href=`chrome-extension://test/sidepanel.html${hash}`;}};
  const activeTab={id:3,windowId:9,url:'https://school.example/course#week1',title:'测试课程'};
  const state={documentId:'panel-doc',scan:{sourceTabId:cacheTab,pageUrl:activeTab.url,title:activeTab.title,files:[file],warnings:[],scannedAt:22},batch:external?{id:'external',mode:'folder',ownerDocumentId:'other-panel',jobs:[{id:'ext-job',file,status:'queued'}]}:null};
  let finishScan; const scanGate=new Promise(resolve=>{finishScan=resolve;});
  let release; const pending=new Promise(resolve=>{release=resolve;}); let stopped=0;
  const directory={name:'本批目录',getFileHandle(){}};
  window.showDirectoryPicker=unsupported?undefined:options=>{calls.push({type:'picker',options});return cancel?Promise.reject(Object.assign(new Error('cancelled'),{name:'AbortError'})):Promise.resolve(directory);};
  window.close=()=>calls.push({type:'close'});
  class DirectoryWriter {
    constructor({onProgress}){this.onProgress=onProgress;}
    stop(){stopped++;}
    async run(jobs,dir){
      calls.push({type:'writer',dir});
      const running=jobs.map(job=>({...job,status:'in_progress'}));
      await this.onProgress(running,{stopped:false});
      if(hold) await pending;
      const finished=jobs.map(job=>({...job,status:fail?'interrupted':'complete',...(fail?{error:'fetch https://school.example/f.pdf?signature=secret failed'}:{savedName:job.file.name})}));
      await this.onProgress(finished,{stopped:false}); return finished;
    }
  }
  const chrome={
    runtime:{onMessage:{addListener:fn=>{handlers.message=fn;}},sendMessage:async message=>{
      calls.push({type:message.type,message});
      if(message.type==='GET_STATE')return {ok:true,...state};
      if(message.type==='SCAN_PAGE'){if(deferScan)await scanGate;state.scan={...state.scan,sourceTabId:message.tabId,pageUrl:activeTab.url};return {ok:true,scan:state.scan,batch:state.batch};}
      if(message.type==='PREPARE_PANEL_DOWNLOAD'){state.batch={id:'p1',mode:'folder',ownerDocumentId:'panel-doc',jobs:[{id:'j1',file,status:'queued'}],stopped:false};return {ok:true,plan:{id:'p1',files:[file]},batch:state.batch};}
      if(message.type==='FOLDER_PROGRESS'){if(failProgress)throw new Error('storage unavailable');state.batch={...state.batch,jobs:message.jobs.map(job=>({...state.batch.jobs.find(old=>old.id===job.id),...job})),stopped:message.stopped,folderName:message.folderName};return {ok:true,batch:state.batch};}
      if(message.type==='STOP_DOWNLOADS'){state.batch={...state.batch,stopped:true,jobs:state.batch.jobs.map(job=>job.status==='queued'?{...job,status:'cancelled'}:job)};return {ok:true,batch:state.batch};}
      return {ok:true,batch:state.batch};
    }},
    windows:{getCurrent:async()=>({id:9})},
    tabs:{query:async()=>[activeTab],get:async id=>({...activeTab,id}),onActivated:{addListener:fn=>{handlers.activated=fn;}},onUpdated:{addListener:fn=>{handlers.updated=fn;}}},
    permissions:{contains:async()=>granted,request:options=>{calls.push({type:'permission',options});return Promise.resolve(!deny);}},
    storage:{session:{get:async()=>({popupSelection:{pageUrl:activeTab.url,sourceTabId:cacheTab,fileIds:['f1']}}),set:async()=>{}}},
  };
  const source=await readFile(`${root}/extension/sidepanel.js`,'utf8');
  vm.runInNewContext(source.replace(/^import .*;\n/gm,''),{document,window,chrome,DirectoryWriter,URL,crypto:{randomUUID:()=> 'instance-123'},...selection,setInterval:fn=>{handlers.poll=fn;return 1;},clearInterval(){}});
  await flush();
  return {window,document,calls,handlers,state,activeTab,release,finishScan,stopped:()=>stopped};
}
test('panel selects a directory synchronously before preparing a validated same-tab plan',async()=>{
  const a=await app(); const start=a.document.getElementById('download-button');
  assert.equal(start.disabled,false);
  start.dispatchEvent(new a.window.Event('click'));
  assert.equal(a.calls.at(-1).type,'picker');
  assert.equal(a.calls.some(call=>call.type==='PREPARE_PANEL_DOWNLOAD'),false);
  await flush();
  const prepared=a.calls.find(call=>call.type==='PREPARE_PANEL_DOWNLOAD').message;
  assert.deepEqual(JSON.parse(JSON.stringify(prepared)),{type:'PREPARE_PANEL_DOWNLOAD',fileIds:['f1'],sourceTabId:3,scanTimestamp:22,panelUrl:'chrome-extension://test/sidepanel.html#instance-123'});
  assert.equal(a.calls.some(call=>call.type==='close'),false);
  assert.match(a.document.getElementById('batch-summary').textContent,/1\/1/);
  assert.equal(a.document.body.textContent.includes('signature=secret'),false);
});
test('permissions use a separate click and picker cancellation creates no plan',async()=>{
  const a=await app({granted:false,cancel:true}); const start=a.document.getElementById('download-button');
  assert.equal(start.textContent,'允许附件网站');
  start.dispatchEvent(new a.window.Event('click'));
  assert.equal(a.calls.at(-1).type,'permission');
  await flush();
  assert.equal(a.calls.some(call=>call.type==='picker'),false);
  start.dispatchEvent(new a.window.Event('click'));
  await flush();
  assert.equal(a.calls.some(call=>call.type==='PREPARE_PANEL_DOWNLOAD'),false);
  assert.equal(start.disabled,false);
});
test('source navigation preserves a running panel write and per-file failure is visible',async()=>{
  const a=await app({hold:true,fail:true});
  a.document.getElementById('download-button').dispatchEvent(new a.window.Event('click'));
  await flush();
  assert.ok(a.handlers.message);
  a.handlers.message({type:'PANEL_SOURCE',tabId:4,windowId:9});
  await flush();
  assert.equal(a.calls.some(call=>call.type==='SCAN_PAGE'),false);
  assert.equal(a.stopped(),0);
  const exit=new a.window.Event('beforeunload',{cancelable:true});a.window.dispatchEvent(exit);assert.equal(exit.defaultPrevented,true);
  a.release(); await flush();
  assert.match(a.document.getElementById('batch-files').textContent,/失败/);
  assert.equal(a.document.body.textContent.includes('signature=secret'),false);
});
test('another panel batch blocks new starts and polling preserves search and file nodes',async()=>{
  const a=await app({external:true});
  assert.equal(a.document.getElementById('download-button').disabled,true);
  const search=a.document.getElementById('search');search.value='课程';search.dispatchEvent(new a.window.Event('input'));
  const row=a.document.querySelector('.file-row');
  assert.ok(a.handlers.poll);await a.handlers.poll();await flush();
  assert.equal(search.value,'课程');assert.equal(a.document.querySelector('.file-row'),row);
  assert.equal(a.document.getElementById('batch-files').children.length,1);
});
test('a cached scan from a different tab cannot restore saved selections',async()=>{
  const a=await app({cacheTab:8});
  assert.ok(a.calls.some(call=>call.type==='SCAN_PAGE'));
  assert.equal(a.document.getElementById('selected-count').textContent,'0');
});
test('pagehide ends an owned plan without reporting false completion',async()=>{
  const a=await app({hold:true});a.document.getElementById('download-button').dispatchEvent(new a.window.Event('click'));await flush();
  a.window.dispatchEvent(new a.window.Event('pagehide'));await flush();
  assert.ok(a.calls.some(call=>call.type==='END_PANEL_DOWNLOAD'&&call.message.planId==='p1'));
  assert.ok(a.stopped()>0);
  a.release();await flush();
});


test('manual same-URL rescan always runs SCAN_PAGE rather than reusing the cache',async()=>{
  const a=await app();a.document.getElementById('scan-button').dispatchEvent(new a.window.Event('click'));await flush();
  assert.equal(a.calls.filter(call=>call.type==='SCAN_PAGE').length,1);
});
test('switching tabs invalidates a deferred old scan result',async()=>{
  const a=await app({cacheTab:8,deferScan:true});
  assert.equal(a.calls.filter(call=>call.type==='SCAN_PAGE').length,1);
  a.handlers.activated({tabId:4,windowId:9});
  a.finishScan();await flush();
  assert.equal(a.document.getElementById('total-count').textContent,'0');
  assert.equal(a.document.getElementById('download-button').disabled,true);
  assert.match(a.document.getElementById('notice').textContent,/页面已切换/);
});
test('the panel exposes only directory saving and removes both legacy download actions',async()=>{
  const a=await app();
  assert.equal(Boolean(a.document.querySelector('.fallbacks')),false);
  assert.equal(Boolean(a.document.getElementById('folder-tab-button')),false);
  assert.equal(Boolean(a.document.getElementById('browser-download-button')),false);
  assert.equal(a.document.getElementById('download-button').disabled,false);
});
test('a failed progress sync explicitly ends the still-owned plan',async()=>{
  const a=await app({failProgress:true});a.document.getElementById('download-button').dispatchEvent(new a.window.Event('click'));await flush();
  assert.ok(a.calls.some(call=>call.type==='END_PANEL_DOWNLOAD'&&call.message.planId==='p1'));
  assert.equal(a.document.getElementById('download-button').disabled,false);
});


test('switching back to the old tab invalidates a pending scan of a new tab',async()=>{
  const a=await app({deferScan:true});
  a.handlers.message({type:'PANEL_SOURCE',tabId:4,windowId:9});await flush();
  assert.equal(a.calls.filter(call=>call.type==='SCAN_PAGE').length,1);
  a.handlers.activated({tabId:3,windowId:9});a.finishScan();await flush();
  assert.equal(a.document.getElementById('total-count').textContent,'0');
  assert.equal(a.document.getElementById('download-button').disabled,true);
});
test('denied website permission leaves no picker or prepared plan and remains retryable',async()=>{
  const a=await app({granted:false,deny:true});const start=a.document.getElementById('download-button');
  start.dispatchEvent(new a.window.Event('click'));await flush();
  assert.equal(a.calls.some(call=>call.type==='picker'||call.type==='PREPARE_PANEL_DOWNLOAD'),false);
  assert.equal(start.disabled,false);assert.equal(start.textContent,'允许附件网站');
  assert.match(a.document.getElementById('notice').textContent,/尚未允许/);
  assert.doesNotMatch(a.document.getElementById('notice').textContent,/其他下载方式|独立下载页|浏览器下载/);
});

test('an unsupported directory picker asks for a browser upgrade without offering removed flows',async()=>{
  const a=await app({unsupported:true});
  assert.equal(a.document.getElementById('download-button').disabled,true);
  assert.match(a.document.getElementById('permission-hint').textContent,/升级.*Chrome.*Edge/);
  assert.doesNotMatch(a.document.body.textContent,/其他下载方式|独立下载页|浏览器下载/);
  assert.equal(a.calls.some(call=>call.type==='PREPARE_PANEL_DOWNLOAD'),false);
});


test('each panel load creates its own URL before its first backend request',async()=>{
  const a=await app();
  assert.equal(a.calls[0].type,'replaceState');
  assert.equal(a.calls[0].hash,'#instance-123');
  const state=a.calls.find(call=>call.type==='GET_STATE').message;
  assert.equal(state.panelUrl,'chrome-extension://test/sidepanel.html#instance-123');
  assert.equal('documentId' in state,false);
});

test('successful downloads show completion on the green action and hide the duplicate result section',async()=>{
  const a=await app();const button=a.document.getElementById('download-button');
  button.dispatchEvent(new a.window.Event('click'));await flush();
  assert.equal(button.textContent,'✓ 下载已完成');
  assert.equal(button.disabled,true);
  assert.equal(button.classList.contains('is-complete'),true);
  assert.equal(a.document.getElementById('batch-section').hidden,true);
  assert.equal(a.document.getElementById('notice').hidden,true);
  assert.match(a.document.getElementById('download-status').textContent,/下载已完成/);
  await a.handlers.poll();await flush();
  assert.equal(button.textContent,'✓ 下载已完成');
});

test('changing the selection resets completion and allows the same file to be downloaded again',async()=>{
  const a=await app();const button=a.document.getElementById('download-button');
  button.dispatchEvent(new a.window.Event('click'));await flush();
  const checkbox=a.document.querySelector('.file-row input');
  checkbox.checked=false;checkbox.dispatchEvent(new a.window.Event('change'));await flush();
  checkbox.checked=true;checkbox.dispatchEvent(new a.window.Event('change'));await flush();
  assert.equal(button.disabled,false);
  assert.match(button.textContent,/选择文件夹下载/);
  await a.handlers.poll();await flush();
  assert.equal(button.disabled,false);
});

test('rescanning the same page resets the completed action',async()=>{
  const a=await app();const button=a.document.getElementById('download-button');
  button.dispatchEvent(new a.window.Event('click'));await flush();
  a.document.getElementById('scan-button').dispatchEvent(new a.window.Event('click'));await flush();
  assert.equal(button.disabled,false);
  assert.match(button.textContent,/选择文件夹下载/);
});

test('failed downloads retain their details and never show successful completion on the action',async()=>{
  const a=await app({fail:true});const button=a.document.getElementById('download-button');
  button.dispatchEvent(new a.window.Event('click'));await flush();
  assert.equal(a.document.getElementById('batch-section').hidden,false);
  assert.match(a.document.getElementById('batch-files').textContent,/失败/);
  assert.doesNotMatch(button.textContent,/下载已完成/);
});

test('a stopped batch retains its details rather than showing the successful completion action',async()=>{
  const a=await app({hold:true});const button=a.document.getElementById('download-button');
  button.dispatchEvent(new a.window.Event('click'));await flush();
  a.state.batch.stopped=true;await a.handlers.poll();await flush();
  a.release();await flush();
  assert.equal(a.document.getElementById('batch-section').hidden,false);
  assert.match(a.document.getElementById('batch-title').textContent,/已停止/);
  assert.doesNotMatch(button.textContent,/下载已完成/);
});

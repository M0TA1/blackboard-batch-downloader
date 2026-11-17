import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Browser plugin not available. Exercise the native panel through Chromium CDP,
// using isolated profiles and a local fixture; never use the user's browser.
const root = resolve(import.meta.dirname, '..');
const output = '/tmp/bb-sidepanel-e2e-results';
await mkdir(output, { recursive: true });
const report = { result: 'RUNNING', nativeToolbarAction: true, nativeSidePanel: true, screenshots: [] };
const requests = [];
let responseDelay = 250;
let rejectFirstFile = false;
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname.startsWith('/course')) {
    const links = url.pathname === '/course-types'
      ? ['reference.wav', 'input.txt', 'reference.pdf'].map(name => `<li><a href="/files/${name}">${name}</a></li>`).join('')
      : Array.from({ length: 16 }, (_, index) => `<li><a href="/files/${index + 1}.pdf${index === 0 ? '?sig=a%2Fb' : ''}">${index < 2 ? '讲义.pdf' : `Lecture ${index + 1}.pdf`}</a></li>`).join('');
    // These paths are synthetic test helpers, not observed Blackboard URLs.
    // Playwright fulfills them locally below, so no external request is made.
    const helpers = `<style>.fixture-helper-hidden{display:none}</style>
      <iframe hidden src="https://developer.blackboard.com/fixture-helper?hidden=1" title="Synthetic hidden helper"></iframe>
      <div class="fixture-helper-hidden"><iframe src="https://developer.blackboard.com/fixture-helper?css=1" title="Synthetic CSS-hidden helper"></iframe></div>
      <iframe src="https://developer.blackboard.com/fixture-helper?zero=1" style="width:0;height:0;border:0" aria-hidden="true" title="Synthetic zero-size helper"></iframe>`;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'bb_session=sidepanel-fixture; Path=/; SameSite=Strict' });
    response.end(`<!doctype html><title>16 course files</title><h1>BB course stays open</h1><ul>${links}</ul>${helpers}`);
  } else if (url.pathname.startsWith('/files/')) {
    requests.push({ path: request.url, cookie: request.headers.cookie || '' });
    if (!request.headers.cookie?.includes('bb_session=sidepanel-fixture')) {
      response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<html>Log in</html>'); return;
    }
    if (rejectFirstFile && url.pathname === '/files/1.pdf') {
      response.writeHead(403, { 'Content-Type': 'text/plain' }); response.end('Fixture access denied'); return;
    }
    const extension = url.pathname.split('.').pop();
    response.writeHead(200, { 'Content-Type': {pdf:'application/pdf',txt:'text/plain',wav:'audio/wav'}[extension] });
    const prefix = extension === 'pdf' ? '%PDF-1.4\n' : extension === 'wav' ? 'RIFF-fixture-audio\n' : 'example input text\n';
    response.write(`${prefix}${'fixture-data '.repeat(60)}\n`);
    const timer = setTimeout(() => response.end(`fixture:${url.pathname}`), responseDelay);
    response.on('close', () => clearTimeout(timer));
  } else { response.writeHead(404); response.end(); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(read, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (value) return value;
    await pause(50);
  }
  throw new Error(`Timed out: ${description}; last value=${JSON.stringify(value)}`);
}

async function openNativePanel({ grantFixtureHost = false } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'bb-native-sidepanel-'));
  const extensionPath = join(profile, 'extension');
  await cp(join(root, 'extension'), extensionPath, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
  assert.ok(!manifest.permissions.includes('downloads'), 'The shipped extension must not request the browser downloads API');
  if (grantFixtureHost) manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(extensionPath, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(extensionPath, 'e2e-observer.html'), '<!doctype html><title>E2E state observer</title>');
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1100, height: 800 },
    args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  await context.route('https://developer.blackboard.com/fixture-helper*', route => route.fulfill({
    contentType:'text/html', body:'<!doctype html><title>Synthetic cross-origin helper fixture</title><p>Local interception only</p>',
  }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  // Evaluating after worker startup also ensures action.onClicked was registered.
  assert.equal(await worker.evaluate(() => chrome.action.onClicked.hasListeners()), true);
  const extensionId = new URL(worker.url()).hostname;
  const course = await context.newPage();
  await course.goto(`${baseUrl}/course`);
  for (const page of context.pages()) if (page !== course && page.url() === 'about:blank') await page.close();
  await course.bringToFront();
  const browser = await context.browser().newBrowserCDPSession();
  const version = await browser.send('Browser.getVersion');
  const tabsBefore = await worker.evaluate(() => chrome.tabs.query({}));
  // Default getTargets excludes type:'tab'. Extensions.triggerAction rejects a
  // type:'page' target, even when it is the page inside the intended browser tab.
  const targets = (await browser.send('Target.getTargets', { filter: [{ exclude: false }] })).targetInfos;
  const sourceTarget = targets.find(target => target.type === 'tab' && target.url === course.url());
  assert.ok(sourceTarget, 'Real browser tab target must exist');
  await browser.send('Extensions.triggerAction', { id: extensionId, targetId: sourceTarget.targetId });
  const target = await waitFor(async () => (await browser.send('Target.getTargets')).targetInfos.find(item => item.url.split('#')[0] === `chrome-extension://${extensionId}/sidepanel.html`), 'native side panel target');
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  let nextId = 0;
  const pending = new Map();
  const errors = [];
  const lifecycleEvents = [];
  browser.on('Target.receivedMessageFromTarget', event => {
    if (event.sessionId !== sessionId) return;
    const response = JSON.parse(event.message);
    if (response.method === 'Runtime.exceptionThrown') errors.push(response.params.exceptionDetails.exception?.description || response.params.exceptionDetails.text);
    if (response.method === 'Runtime.bindingCalled' && response.params.name === 'e2eLifecycle') lifecycleEvents.push(JSON.parse(response.params.payload));
    const item = pending.get(response.id);
    if (!item) return;
    pending.delete(response.id); clearTimeout(item.timer);
    if (response.error) item.reject(new Error(JSON.stringify(response.error))); else item.resolve(response.result);
  });
  const send = async (method, params = {}) => {
    const id = ++nextId;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
      pending.set(id, { resolve, reject, timer });
    });
    await browser.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) });
    return result;
  };
  await send('Runtime.enable');
  await send('Runtime.addBinding', { name: 'e2eLifecycle' });
  const evaluate = async expression => {
    const value = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
    return value.result.value;
  };
  const click = async selector => {
    const point = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Missing control'); element.scrollIntoView({block:'nearest'}); const r = element.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
  };
  const fill = async (selector, text) => {
    await click(selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).select()`);
    await send('Input.dispatchKeyEvent', { type:'keyDown', key:'Backspace', code:'Backspace',windowsVirtualKeyCode:8,nativeVirtualKeyCode:8 });
    await send('Input.dispatchKeyEvent', { type:'keyUp', key:'Backspace', code:'Backspace',windowsVirtualKeyCode:8,nativeVirtualKeyCode:8 });
    if (text) await send('Input.insertText', {text});
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).value`), text, 'CDP input must match the intended search query');
  };
  const screenshot = async name => {
    const path = join(output, name);
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path, Buffer.from(data, 'base64'));
    report.screenshots.push(path);
  };
  await waitFor(() => evaluate(`document.querySelectorAll('.file-row').length === 16 && !document.getElementById('scan-button').disabled`), 'sixteen activeTab-scanned files');
  assert.equal(await evaluate(`document.getElementById('notice').hidden`), true, 'Hidden cross-origin helpers must not produce a partial-scan notice');
  assert.equal(await evaluate(`Boolean(document.querySelector('#folder-tab-button,#browser-download-button,.fallbacks')) || document.body.innerText.includes('其他下载方式')`), false, 'Native panel must expose only the folder download flow');
  await evaluate(`window.addEventListener('pagehide', event => e2eLifecycle(JSON.stringify({event:'pagehide',persisted:event.persisted})))`);
  const state = () => worker.evaluate(async () => (await chrome.storage.session.get('folderBatch')).folderBatch);
  return { context, worker, course, browser, extensionId, target, evaluate, send, click, fill, screenshot, state, tabsBefore, version, errors, lifecycleEvents };
}

let active;
try {
  active = await openNativePanel();
  report.browser = active.version.product;
  report.panelTargetType = active.target.type;
  report.activeTabWithoutPersistentHostGrant = true;
  report.folderOnlyInterface = true;
  report.initialPermissions = await active.worker.evaluate(async () => ({containsFixtureHost:await chrome.permissions.contains({ origins:['http://127.0.0.1/*'] }),all:await chrome.permissions.getAll()}));
  assert.equal(report.initialPermissions.containsFixtureHost, false, 'activeTab must not become a persistent fixture host grant');
  assert.ok(!report.initialPermissions.all.permissions.includes('downloads'));
  report.downloadsPermissionAbsent = true;
  report.hiddenCrossOriginHelpersIgnored = {hiddenAttribute:true,cssHiddenAncestor:true,zeroSizeAriaHidden:true,scannedFiles:16};
  assert.equal(active.course.url(), `${baseUrl}/course`);
  assert.equal((await active.worker.evaluate(() => chrome.tabs.query({}))).length, active.tabsBefore.length);
  await active.course.evaluate(() => new Promise(resolve => {
    const frame=document.createElement('iframe'); frame.id='visible-cross-origin-helper';
    frame.title='Synthetic visible cross-origin content'; frame.width='300'; frame.height='120';
    frame.onload=resolve; frame.src='https://developer.blackboard.com/fixture-helper?visible=1';
    document.body.append(frame);
  }));
  await active.click('#scan-button');
  await waitFor(() => active.evaluate(`!document.getElementById('scan-button').disabled && !document.getElementById('notice').hidden && document.getElementById('notice').textContent.includes('部分内容未能扫描')`), 'visible cross-origin frame still warns');
  assert.equal(await active.evaluate(`document.querySelectorAll('.file-row').length`),16);
  report.visibleCrossOriginSameHostStillWarns = true;
  await active.screenshot('sidepanel-visible-cross-origin-warning.png');
  await active.course.evaluate(() => document.getElementById('visible-cross-origin-helper').remove());
  await active.click('#scan-button');
  await waitFor(() => active.evaluate(`!document.getElementById('scan-button').disabled && document.getElementById('notice').hidden && document.querySelectorAll('.file-row').length === 16`), 'removing visible frame clears warning without losing files');
  const pointer = await active.evaluate(`(() => { const r = document.querySelector('main').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.bottom-20}; })()`);
  await active.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pointer });
  await active.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...pointer, deltaX: 0, deltaY: 4000 });
  await waitFor(() => active.evaluate(`(() => { const row = document.querySelector('.file-row:last-child'); const r = row.getBoundingClientRect(); const main = document.querySelector('main').getBoundingClientRect(); const footer = document.querySelector('footer').getBoundingClientRect(); return r.top >= main.top-1 && r.bottom <= Math.min(main.bottom,footer.top)+1 && document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.file-row') === row; })()`), 'last row reachable by wheel without auto-scroll', 3000);
  await active.click('.file-row:last-child input');
  assert.equal(await active.evaluate(`document.getElementById('selected-count').textContent`), '1');
  await active.screenshot('sidepanel-last-row.png');
  report.lastRowReachableAndSelectable = true;
  report.layoutWidths = [];
  for (const width of [320, 460]) {
    await active.send('Emulation.setDeviceMetricsOverride', { width, height: 600, deviceScaleFactor: 1, mobile: false });
    const point = await active.evaluate(`(() => { const r=document.querySelector('main').getBoundingClientRect(); return {x:Math.min(r.x+r.width/2,300),y:r.bottom-20}; })()`);
    await active.send('Input.dispatchMouseEvent', {type:'mouseWheel',...point,deltaX:0,deltaY:4000});
    await waitFor(() => active.evaluate(`(() => {const r=document.querySelector('.file-row:last-child').getBoundingClientRect();const m=document.querySelector('main').getBoundingClientRect();const f=document.querySelector('footer').getBoundingClientRect();return r.top>=m.top-1&&r.bottom<=Math.min(m.bottom,f.top)+1&&document.documentElement.scrollWidth<=innerWidth;})()`), `last row reachable at emulated panel width ${width}`, 3000);
    report.layoutWidths.push({requested:width, actual:await active.evaluate('innerWidth'),lastRowReachable:true});
    await active.screenshot(`sidepanel-width-${width}.png`);
  }
  await active.send('Emulation.clearDeviceMetricsOverride');
  // No picker substitution: dispatch a trusted click to a probe button in the
  // real native panel, and call the browser's original API directly.
  await active.evaluate(`(() => { const button = document.createElement('button'); button.id = 'native-picker-probe'; button.textContent = 'Native directory picker probe'; document.querySelector('footer').prepend(button); window.nativePickerProbe = {status:'ready'}; button.addEventListener('click', async event => { window.nativePickerProbe = {status:'pending',trusted:event.isTrusted,active:navigator.userActivation.isActive,origin:location.origin,topIsSelf:top===self}; try { const directory = await showDirectoryPicker({mode:'readwrite'}); Object.assign(window.nativePickerProbe,{status:'selected',kind:directory.kind}); } catch(error) { Object.assign(window.nativePickerProbe,{status:'rejected',name:error.name,message:error.message}); } }); })()`);
  await active.click('#native-picker-probe');
  await waitFor(() => active.evaluate(`window.nativePickerProbe.status !== 'pending' && window.nativePickerProbe`), 'native picker result', 5000);
  report.nativePickerProbe = await active.evaluate('window.nativePickerProbe');
  assert.equal(report.nativePickerProbe.trusted, true);
  assert.equal(report.nativePickerProbe.active, true);
  assert.equal(report.nativePickerProbe.topIsSelf, true);
  assert.ok(['selected', 'rejected'].includes(report.nativePickerProbe.status));
  if (report.nativePickerProbe.status === 'rejected') assert.equal(report.nativePickerProbe.name, 'AbortError');
  assert.equal(active.errors.length, 0, active.errors.join('\n'));
  await active.context.close(); active = null;

  // Copy-only fixture host permission avoids a real browser permission prompt.
  // Production permissions are verified separately above and remain unchanged.
  active = await openNativePanel({ grantFixtureHost: true });
  report.nativePanelContexts = await active.worker.evaluate(() => chrome.runtime.getContexts({}));
  await active.click('#select-visible');
  assert.equal(await active.evaluate(`document.getElementById('selected-count').textContent`), '16');
  await waitFor(() => active.evaluate(`!document.getElementById('download-button').disabled`), 'directory action enabled after permission check');
  await active.click('#download-button');
  await waitFor(() => active.evaluate(`!document.getElementById('download-button').disabled`), 'native picker cancellation restores action');
  assert.equal(await active.state(), undefined, 'Cancelling the native picker must not create a batch');
  assert.equal(await active.worker.evaluate(async () => (await chrome.storage.session.get('folderPlan')).folderPlan), undefined, 'Cancelling the native picker must not create a directory plan');
  assert.equal(requests.length, 0, 'Cancelling the native picker must not start attachment fetches');
  report.nativeCancelCreatesNoPlanAndRetriable = true;
  await active.evaluate(`(async () => { const root = await navigator.storage.getDirectory(); const first = await root.getDirectoryHandle('batch-first',{create:true}); const existing = await first.getFileHandle('讲义.pdf',{create:true}); const writable = await existing.createWritable(); await writable.write('keep-existing'); await writable.close(); window.e2eDirectories = [first, await root.getDirectoryHandle('batch-second',{create:true}), await root.getDirectoryHandle('batch-partial',{create:true}), await root.getDirectoryHandle('batch-types',{create:true}), await root.getDirectoryHandle('batch-close',{create:true})]; window.e2ePickerCalls = 0; window.showDirectoryPicker = async options => { if(options.mode !== 'readwrite') throw new Error('Expected readwrite directory permission'); return window.e2eDirectories[window.e2ePickerCalls++]; }; })()`);
  await active.click('#download-button');
  const firstBatch = await waitFor(async () => { const batch = await active.state(); return batch?.jobs.some(job => job.status === 'in_progress') && batch; }, 'first streaming batch');
  assert.equal(firstBatch.surface, 'panel');
  await active.course.bringToFront();
  await active.course.goto(`${baseUrl}/course-next`);
  assert.equal((await active.worker.evaluate(() => chrome.tabs.query({}))).length, active.tabsBefore.length, 'Native panel must not create a downloader tab');
  await waitFor(async () => { const batch = await active.state(); return batch?.id === firstBatch.id && batch.jobs.every(job => job.status === 'complete') && batch; }, 'downloads continue after source-tab navigation', 15000);
  const saved = await active.evaluate(`(async () => { const files = {}; for await(const entry of window.e2eDirectories[0].values()) files[entry.name] = await(await entry.getFile()).text(); return {files,calls:window.e2ePickerCalls}; })()`);
  assert.equal(saved.calls, 1);
  assert.equal(saved.files['讲义.pdf'], 'keep-existing');
  assert.ok(saved.files['讲义 (1).pdf'].startsWith('%PDF-1.4'));
  assert.ok(saved.files['讲义 (2).pdf'].startsWith('%PDF-1.4'));
  assert.equal(Object.keys(saved.files).length, 17);
  assert.equal(requests.length, 16);
  assert.ok(requests.every(item => item.cookie.includes('bb_session=sidepanel-fixture')));
  assert.ok(requests.some(item => item.path.includes('sig=a%2Fb')));
  report.firstBatch = { completed: 16, directoryChoices: 1, strictCookiePreserved: true, signedUrlPreserved: true, existingFileUnchanged: true, duplicateNamesNumbered: true, sourceNavigationDidNotCancel: true };
  await waitFor(() => active.evaluate(`document.getElementById('batch-section').hidden && document.getElementById('download-button').disabled && document.getElementById('download-button').textContent === '✓ 下载已完成'`), 'successful batch collapses details into completed button');
  assert.equal(await active.evaluate(`/本批文件已保存|下载已完成|保存完成|已保存/.test(document.getElementById('notice').textContent)`), false, 'Completion must not be repeated in the notice');
  await waitFor(() => active.evaluate(`getComputedStyle(document.getElementById('download-button')).backgroundColor === 'rgb(17, 126, 107)'`), 'completed button green transition settles', 1000);
  const completedStyle = await active.evaluate(`(() => {const button=document.getElementById('download-button');const style=getComputedStyle(button);return {isComplete:button.classList.contains('is-complete'),background:style.backgroundColor,opacity:style.opacity};})()`);
  assert.equal(completedStyle.isComplete, true);
  assert.equal(completedStyle.background, 'rgb(17, 126, 107)');
  assert.equal(completedStyle.opacity, '1');
  report.successPresentation = {detailsHidden:true, completedButton:'✓ 下载已完成', completedButtonDisabled:true, noDuplicateNotice:true,...completedStyle};
  await active.screenshot('sidepanel-complete.png');

  // Rescan the current course and start a second batch from the same native
  // panel; a different directory handle is selected for this batch.
  await active.click('#scan-button');
  await waitFor(() => active.evaluate(`document.querySelectorAll('.file-row').length === 16 && !document.getElementById('scan-button').disabled`), 'rescan after source navigation');
  await active.click('#select-visible');
  await waitFor(() => active.evaluate(`!document.getElementById('download-button').disabled && document.getElementById('download-button').textContent !== '✓ 下载已完成'`), 'rescan and selection reset completed presentation');
  await active.click('#download-button');
  const secondBatch = await waitFor(async () => { const batch = await active.state(); return batch?.id !== firstBatch.id && batch; }, 'second independent batch');
  await waitFor(async () => { const batch = await active.state(); return batch?.id === secondBatch.id && batch.jobs.every(job => job.status === 'complete'); }, 'second batch completion', 15000);
  const second = await active.evaluate(`(async () => { const names=[]; for await(const entry of window.e2eDirectories[1].values()) names.push(entry.name); return {names,calls:window.e2ePickerCalls}; })()`);
  assert.equal(second.calls, 2);
  assert.equal(second.names.length, 16);
  assert.ok(second.names.includes('讲义.pdf'));
  report.secondBatchDifferentDirectory = true;
  await waitFor(() => active.evaluate(`document.getElementById('batch-section').hidden && document.getElementById('download-button').disabled && document.getElementById('download-button').textContent === '✓ 下载已完成'`), 'second batch completed presentation');

  // Partial failures and explicit queue stops must keep their useful details.
  await active.click('#clear-visible');
  for (let index = 1; index <= 8; index++) await active.click(`.file-row:nth-child(${index}) input`);
  rejectFirstFile = true; responseDelay = 750;
  await waitFor(() => active.evaluate(`!document.getElementById('download-button').disabled`), 'changed selection resets completion');
  await active.click('#download-button');
  const partialBatch = await waitFor(async () => { const batch = await active.state(); return batch?.id !== secondBatch.id && batch.jobs.some(job=>job.status==='interrupted') && batch.jobs.some(job=>job.status==='queued') && batch; }, 'partial failure with waiting jobs');
  await active.click('#stop-button');
  await waitFor(async () => { const batch = await active.state(); return batch?.id === partialBatch.id && batch.jobs.every(job=>['complete','interrupted','cancelled'].includes(job.status)); }, 'stopped partial batch completion');
  await waitFor(() => active.evaluate(`!document.getElementById('batch-section').hidden && document.querySelector('#batch-files .job-error')?.textContent.includes('403') && document.getElementById('batch-summary').textContent.includes('已取消')`), 'failed and stopped batches retain reasons');
  report.partialFailureAndStopKeepDetails = true;
  await active.evaluate(`document.querySelector('#batch-files .job-error').scrollIntoView({block:'center'})`);
  await active.screenshot('sidepanel-partial-stopped.png');
  rejectFirstFile = false;
  responseDelay = 250;
  await active.course.goto(`${baseUrl}/course-types`);
  await active.click('#scan-button');
  await waitFor(() => active.evaluate(`document.querySelectorAll('.file-row').length === 3 && !document.getElementById('scan-button').disabled`), 'mixed file types scanned');
  await active.click('[data-type="other"]');
  assert.deepEqual(await active.evaluate(`[...document.querySelectorAll('.file-name')].map(element=>element.textContent)`), ['reference.wav','input.txt']);
  await active.click('#select-visible');
  await active.fill('#search','input');
  assert.equal(await active.evaluate(`document.querySelectorAll('.file-row').length`), 1);
  assert.equal(await active.evaluate(`document.getElementById('selected-count').textContent`), '2');
  assert.equal(await active.evaluate(`!document.getElementById('hidden-selection').hidden && document.getElementById('hidden-selection').textContent.includes('1')`), true);
  await active.fill('#search','no matching course file');
  assert.equal(await active.evaluate(`document.querySelectorAll('.file-row').length`), 0);
  assert.equal(await active.evaluate(`document.getElementById('selected-count').textContent`), '2');
  await active.fill('#search','');
  await active.click('[data-type="all"]');
  assert.equal(await active.evaluate(`document.querySelectorAll('.file-row').length`), 3);
  await waitFor(() => active.evaluate(`!document.getElementById('download-button').disabled`), 'filtered selections remain downloadable');
  await active.click('#download-button');
  const typesBatch = await waitFor(async () => { const batch=await active.state(); return batch?.id !== partialBatch.id && batch?.jobs.length===2 && batch; }, 'TXT and WAV batch started');
  await waitFor(async () => { const batch=await active.state(); return batch?.id===typesBatch.id && batch.jobs.every(job=>job.status==='complete'); }, 'TXT and WAV files saved');
  const typedFiles = await active.evaluate(`(async()=>{const files={};for await(const entry of window.e2eDirectories[3].values())files[entry.name]=await(await entry.getFile()).text();return files;})()`);
  assert.deepEqual(Object.keys(typedFiles).sort(),['input.txt','reference.wav']);
  assert.ok(typedFiles['input.txt'].startsWith('example input text'));
  assert.ok(typedFiles['reference.wav'].startsWith('RIFF'));
  assert.ok(requests.filter(item=>/input\.txt|reference\.wav/.test(item.path)).every(item=>item.cookie.includes('bb_session=sidepanel-fixture')));
  report.filterSearchAndHiddenSelection = true;
  report.otherTypesSaved = ['input.txt','reference.wav'];
  await active.screenshot('sidepanel-other-types.png');

  await active.course.goto(`${baseUrl}/course`);
  await active.click('#scan-button');
  await waitFor(() => active.evaluate(`document.querySelectorAll('.file-row').length === 16 && !document.getElementById('scan-button').disabled`), 'rescan before native-close test');
  await active.click('#select-visible');
  responseDelay = 1500;
  await active.click('.file-row:first-child input');
  await active.click('.file-row:first-child input');
  await waitFor(() => active.evaluate(`!document.getElementById('download-button').disabled && document.getElementById('download-button').textContent !== '✓ 下载已完成'`), 'checkbox change resets completed presentation');
  report.completedStateResetsOnRescanAndSelectionChange = true;
  await active.click('#download-button');
  const closingBatch = await waitFor(async () => { const batch = await active.state(); return batch?.id !== secondBatch.id && batch.jobs.some(job => job.status === 'in_progress') && batch.jobs.some(job => job.status === 'queued') && batch; }, 'batch with active and queued writes before closing');
  const ownerDocumentId = closingBatch.ownerDocumentId;
  await active.worker.evaluate(async () => { const [tab] = await chrome.tabs.query({active:true,currentWindow:true}); await chrome.sidePanel.close({windowId:tab.windowId}); });
  report.contextsImmediatelyAfterClose = await active.worker.evaluate(id => chrome.runtime.getContexts({documentIds:[id]}), ownerDocumentId);
  const immediatelyAfterClose = await active.state();
  report.batchImmediatelyAfterClose = {id:immediatelyAfterClose?.id,stopped:immediatelyAfterClose?.stopped,statuses:immediatelyAfterClose?.jobs.map(job=>job.status)};
  await waitFor(async () => !(await active.worker.evaluate(id => chrome.runtime.getContexts({documentIds:[id]}), ownerDocumentId)).length, 'native panel document is closed');
  report.panelLifecycleEvents = active.lifecycleEvents;
  const observer = await active.context.newPage();
  await observer.goto(`chrome-extension://${active.extensionId}/e2e-observer.html`);
  const reconciled = await observer.evaluate(() => chrome.runtime.sendMessage({type:'GET_STATE'}));
  assert.equal(reconciled.ok, true);
  assert.equal(reconciled.batch.id, closingBatch.id);
  assert.equal(reconciled.batch.stopped, true);
  assert.ok(reconciled.batch.jobs.some(job => job.status === 'cancelled'));
  assert.ok(reconciled.batch.jobs.some(job => job.status === 'interrupted'));
  assert.ok(reconciled.batch.jobs.every(job => !['queued','starting','in_progress'].includes(job.status)));
  report.closedPanelReconciled = { cancelled: reconciled.batch.jobs.filter(job=>job.status==='cancelled').length, interrupted: reconciled.batch.jobs.filter(job=>job.status==='interrupted').length };
  assert.equal(active.errors.length, 0, active.errors.join('\n'));
  report.runtimeErrors = active.errors;
  report.result = 'PASS';
  report.limitation = 'Native OS picker invoked without replacement and cancelled by headless Chromium. Successful directory selection uses real OPFS handles; no real system directory selection is claimed.';
} catch (error) {
  report.result = 'FAIL'; report.error = { message: error.message, stack: error.stack };
  if (active) {
    try {
      report.failureStorage = await active.worker.evaluate(() => chrome.storage.session.get(['folderPlan','folderBatch']));
      report.failureContexts = await active.worker.evaluate(() => chrome.runtime.getContexts({}));
      report.failureDom = await active.evaluate(`(() => {const rect=selector=>{const n=document.querySelector(selector);const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scrollTop:n.scrollTop,clientHeight:n.clientHeight,scrollHeight:n.scrollHeight};};return {html:document.body.innerText,main:rect('main'),footer:rect('footer'),last:rect('.file-row:last-child'),viewport:{width:innerWidth,height:innerHeight}};})()`);
      await active.screenshot('sidepanel-failure.png');
    } catch { /* The panel may already be intentionally closed. */ }
  }
  process.exitCode = 1;
} finally {
  await writeFile(join(output, 'sidepanel-e2e.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (active) await active.context.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

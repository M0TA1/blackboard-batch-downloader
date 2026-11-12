import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, mkdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const profile = await mkdtemp(join(tmpdir(), 'bb-folder-e2e-'));
await mkdir(join(profile, 'Default'));
// The feature must work even when Chrome asks for a path for every native download.
await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { prompt_for_download: true } }));
const requests = [];
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/course') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'bb_session=folder-fixture; Path=/; SameSite=Strict' });
    response.end(`<html><title>一次选择文件夹测试</title>
      <a href="/files/one.pdf?sig=a%2Fb">讲义.pdf</a>
      <a href="/files/two.pdf">讲义.pdf</a>
      <a href="/files/input.txt">input.txt</a>
      <a href="/files/reference.wav">reference.wav</a></html>`);
  } else if (url.pathname.startsWith('/files/')) {
    requests.push({ url: request.url, cookie: request.headers.cookie || '' });
    if (!request.headers.cookie?.includes('bb_session=folder-fixture')) {
      response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<html>Log in</html>'); return;
    }
    const type = url.pathname.endsWith('.pdf') ? 'application/pdf' : url.pathname.endsWith('.txt') ? 'text/plain' : 'audio/wav';
    response.writeHead(200, { 'Content-Type': type });
    response.write(url.pathname.endsWith('.pdf') ? '%PDF-1.4\n' : url.pathname.endsWith('.wav') ? 'RIFF-fixture\n' : 'test-input\n');
    setTimeout(() => response.end(`fixture:${url.pathname}`), 300);
  } else { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const extensionPath = join(profile, 'extension');
await cp(join(root, 'extension'), extensionPath, { recursive: true });
const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
// Same fixture-only grant as the existing headless extension test; production retains optional per-site requests.
manifest.host_permissions = ['http://127.0.0.1/*'];
await writeFile(join(extensionPath, 'manifest.json'), JSON.stringify(manifest));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1100, height: 800 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const course = await context.newPage();
  await course.goto(`${baseUrl}/course`);
  const openPopup = async () => {
    await course.bringToFront();
    const next = context.waitForEvent('page');
    await worker.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html'), active: false }));
    const popup = await next;
    await popup.waitForSelector('.file-row');
    return popup;
  };
  const popup = await openPopup();
  await popup.locator('#select-visible').click();
  assert.equal(await popup.locator('#selected-count').textContent(), '4');
  const next = context.waitForEvent('page');
  await popup.locator('#download-button').click();
  const manager = await next;
  await manager.waitForSelector('#start-button');
  await manager.waitForFunction(() => !document.getElementById('start-button').disabled);
  assert.match(manager.url(), /downloader\.html#/);
  assert.equal(await manager.evaluate(() => typeof window.showDirectoryPicker), 'function');

  // Only OS picker selection is instrumented. Real FileSystemDirectoryHandle,
  // createWritable, fetch, cookies and extension messaging are exercised end to end.
  await manager.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle('chosen-folder', { create: true });
    const existing = await directory.getFileHandle('讲义.pdf', { create: true });
    const out = await existing.createWritable(); await out.write('keep-existing'); await out.close();
    window.testDirectory = directory;
    window.testPickerCalls = 0;
    window.testChosenCount = 0;
    window.testCancel = true;
    window.showDirectoryPicker = async options => {
      window.testPickerCalls++;
      if (options.mode !== 'readwrite') throw new Error('Directory must be writable from the initial selection');
      if (window.testCancel) { window.testCancel = false; throw new DOMException('Cancelled', 'AbortError'); }
      window.testChosenCount++;
      return directory;
    };
  });
  await manager.locator('#start-button').click();
  await manager.waitForFunction(() => window.testPickerCalls === 1 && !document.getElementById('start-button').disabled);
  assert.equal(requests.length, 0, 'Cancelling the folder picker must not start a network download');
  await manager.locator('#start-button').click();
  await manager.waitForFunction(() => document.getElementById('progress-summary').textContent.includes('已保存 4/4'));
  const saved = await manager.evaluate(async () => {
    const files = {};
    for await (const entry of window.testDirectory.values()) files[entry.name] = await (await entry.getFile()).text();
    return { files, calls: window.testPickerCalls, choices: window.testChosenCount };
  });
  assert.equal(saved.choices, 1);
  assert.equal(saved.calls, 2, 'One cancelled attempt and one successful directory choice');
  assert.equal(saved.files['讲义.pdf'], 'keep-existing');
  assert.ok(saved.files['讲义 (1).pdf'].startsWith('%PDF-1.4'));
  assert.ok(saved.files['讲义 (2).pdf'].startsWith('%PDF-1.4'));
  assert.ok(saved.files['input.txt'].includes('test-input'));
  assert.ok(saved.files['reference.wav'].startsWith('RIFF'));
  assert.equal(requests.length, 4);
  assert.ok(requests.every(item => item.cookie.includes('bb_session=folder-fixture')));
  assert.ok(requests.some(item => item.url.includes('sig=a%2Fb')));
  assert.equal((await worker.evaluate(() => chrome.downloads.search({}))).length, 0, 'Folder writes must not create native per-file Save As downloads');
  const screenshot = join(tmpdir(), 'blackboard-folder-download.png');
  await manager.screenshot({ path: screenshot });
  await manager.close();
  const status = await worker.evaluate(async () => (await chrome.storage.session.get('folderBatch')).folderBatch);
  assert.ok(status.jobs.every(job => job.status === 'complete'));
  const secondPopup = await openPopup();
  const nextManager = context.waitForEvent('page');
  await secondPopup.locator('#download-button').click();
  const leaving = await nextManager;
  await leaving.waitForFunction(() => !document.getElementById('start-button').disabled);
  await leaving.evaluate(async () => {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle('navigation-test', { create: true });
    window.showDirectoryPicker = async () => directory;
  });
  leaving.on('dialog', dialog => dialog.accept());
  await leaving.locator('#start-button').click();
  await leaving.waitForSelector('.file-status.active');
  await leaving.goto(`${baseUrl}/course`, { waitUntil: 'domcontentloaded' });
  let leftState;
  const deadline = Date.now() + 5000;
  do {
    leftState = await worker.evaluate(async () => (await chrome.storage.session.get('folderBatch')).folderBatch);
    if (leftState.stopped && leftState.jobs.every(job => !['queued', 'starting', 'in_progress'].includes(job.status))) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(leftState.stopped, true);
  assert.ok(leftState.jobs.some(job => job.status === 'interrupted'));
  assert.ok(leftState.jobs.every(job => !['queued', 'starting', 'in_progress'].includes(job.status)));
  await leaving.close();
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ result: 'PASS', files: Object.keys(saved.files), chosenDirectoryCount: saved.choices,
    cancelledPickerRetriable: true, nativePerFileDownloads: 0, strictCookiePreserved: true,
    signedUrlPreserved: true, existingFileUnchanged: true, navigationClearsUnfinishedBatch: true, pageErrors: errors, screenshot,
    limitation: 'Native OS picker selection instrumented; real OPFS directory handles and writes used.' }, null, 2));
} finally {
  if (context) await context.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

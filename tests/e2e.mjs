import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp, mkdir, readdir, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

// Browser plugin not available. Isolated Chromium profile; never touches the user's profile.
const root = resolve(import.meta.dirname, '..');
const profile = await mkdtemp(join(tmpdir(), 'bb-extension-e2e-'));
const downloads = join(profile, 'downloads');
await mkdir(downloads);
await mkdir(join(profile, 'Default'));
await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false, directory_upgrade: true } }));
const requests = [];
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/course' || url.pathname === '/assignment') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'bb_session=fixture; Path=/; SameSite=Lax' });
    response.end(await readFile(join(root, url.pathname === '/assignment' ? 'tests/fixtures/assignment.html' : 'tests/fixtures/course.html')));
  } else if (url.pathname === '/lectures') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const files = Array.from({ length: 16 }, (_, index) => `<li><a href="/files/lecture-${index + 1}.pdf">Lecture ${index + 1}.pdf</a></li>`).join('');
    const warning = url.searchParams.has('warning') ? `<iframe src="http://localhost:${server.address().port}/cross-frame" title="跨域内容"></iframe>` : '';
    response.end(`<html><title>16 个课程文件 · 滚动回归</title><ul>${files}</ul>${warning}</html>`);
  } else if (url.pathname === '/frame') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<html><title>工作表</title><a href="/files/worksheet.csv">练习表.csv</a></html>');
  } else if (url.pathname === '/cross-frame' || url.pathname === '/external-placeholder') {
    response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<p>Cross-origin fixture</p>');
  } else if (url.pathname.startsWith('/files/') || url.pathname.startsWith('/bbcswebdav/')) {
    requests.push({ path: request.url, cookie: request.headers.cookie || '' });
    if (!request.headers.cookie?.includes('bb_session=fixture')) {
      response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<html>Please log in</html>'); return;
    }
    const extension = url.pathname.endsWith('/xid-wav') ? 'wav' : url.searchParams.get('filename')?.split('.').pop() || url.pathname.split('.').pop();
    const mime = { pdf: 'application/pdf', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', wav: 'audio/wav', txt: 'text/plain' }[extension] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': mime, 'Content-Disposition': 'attachment' });
    response.write(extension === 'pdf' ? '%PDF-1.4\n' : extension === 'csv' ? 'fixture,example\n' : 'PK-fixture-');
    setTimeout(() => {
      response.end(extension === 'pdf' ? '%PDF-1.4\n% fixture only\n%%EOF' : 'fixture,example\n1,2');
    }, 1500);
  } else { response.writeHead(404); response.end('Not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const realAction = process.env.BB_REAL_ACTION === '1';
let extensionPath = join(root, 'extension');
if (!realAction) {
  // Automated headless Chrome cannot click its toolbar. Grant only the local fixture
  // origin in a temporary copy. The shipped manifest remains activeTab-only.
  extensionPath = join(profile, 'test-extension');
  await cp(join(root, 'extension'), extensionPath, { recursive: true });
  const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  await writeFile(join(extensionPath, 'manifest.json'), JSON.stringify(manifest));
}
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: !realAction, acceptDownloads: true, downloadsPath: downloads,
    viewport: { width: 1000, height: 800 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const browserSession = await context.browser().newBrowserCDPSession();
  // Restore normal Chrome filename handling. CDP's allow/allowAndName modes flatten
  // extension-specified subdirectories, so point browser preferences at the test folder.
  await browserSession.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
  const extensionId = new URL(worker.url()).hostname;
  const errors = [];
  const course = await context.newPage();
  course.on('pageerror', error => errors.push(error.message));
  await course.goto(`${baseUrl}/course`, { waitUntil: 'domcontentloaded' });
  await course.frameLocator('iframe[src="/frame"]').locator('a').waitFor();
  await course.bringToFront();
  if (realAction) {
    console.log('AWAITING_TOOLBAR_CLICK: click the Blackboard extension in the isolated test browser.');
    const deadline = Date.now() + 60000;
    while (!(await worker.evaluate(async () => Boolean((await chrome.storage.session.get('scan')).scan)))) {
      if (Date.now() > deadline) throw new Error('No real toolbar action received within 60s.');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  // Playwright does not expose Chromium's toolbar popup target as a Page.
  // Render the identical extension page in an inactive tab; it uses the real runtime APIs
  // and the real activeTab grant (or fixture-only test grant), with the course active.
  const popupReady = context.waitForEvent('page');
  await worker.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html'), active: false }));
  const popup = await popupReady;
  popup.on('pageerror', error => errors.push(error.message));
  try {
    await popup.waitForSelector('.file-row', { timeout: 10000 });
  } catch (error) {
    console.error(JSON.stringify({ popupUrl: popup.url(), body: await popup.locator('body').innerText(), state: await worker.evaluate(async () => ({ active: await chrome.tabs.query({ active: true, currentWindow: true }), storage: await chrome.storage.session.get('scan') })) }, null, 2));
    throw error;
  }
  assert.equal(await popup.title(), 'Blackboard 批量下载');
  assert.equal(await popup.locator('.file-row').count(), 5);
  assert.match(await popup.locator('#notice').textContent(), /其他站点|内嵌/);
  assert.equal(await popup.locator('#download-button').isDisabled(), true);

  await popup.locator('[data-type="pdf"]').click();
  assert.equal(await popup.locator('.file-row').count(), 1);
  await popup.locator('#select-visible').click();
  await popup.locator('[data-type="spreadsheet"]').click();
  assert.equal(await popup.locator('.file-row').count(), 2);
  await popup.locator('#select-visible').click();
  assert.equal(await popup.locator('#selected-count').textContent(), '3');
  await popup.locator('#search').fill('不存在的文件');
  assert.equal(await popup.locator('.file-row').count(), 0);
  assert.equal(await popup.locator('#selected-count').textContent(), '3');
  await popup.locator('#search').fill('');
  await popup.locator('[data-type="all"]').click();
  const screenshot = join(tmpdir(), 'blackboard-extension-selected.png');
  await popup.setViewportSize({ width: 460, height: 600 });
  await popup.screenshot({ path: screenshot, fullPage: true });

  await popup.locator('#download-button').click();
  await popup.waitForFunction(() => document.getElementById('batch-summary').textContent.includes('3'));
  await popup.close();
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const poll = async () => {
      try {
        const batch = await worker.evaluate(async () => (await chrome.storage.session.get('batch')).batch);
        if (batch?.jobs.every(job => job.status === 'complete')) resolve();
        else if (Date.now() > deadline) reject(new Error(`Downloads did not complete: ${JSON.stringify(batch)}`));
        else setTimeout(poll, 100);
      } catch (error) { reject(error); }
    };
    poll();
  });
  const state = await worker.evaluate(async () => ({ batch: (await chrome.storage.session.get('batch')).batch, records: await chrome.downloads.search({}) }));
  assert.equal(state.batch.jobs.length, 3);
  assert.ok(state.records.filter(item => item.byExtensionId === extensionId).every(item => item.state === 'complete'));
  assert.ok(requests.filter(request => /lecture|data.xlsx|worksheet/.test(request.path)).every(request => request.cookie.includes('bb_session=fixture')));
  assert.ok(requests.some(request => request.path.includes('token=signed-123')));
  assert.ok(state.records.filter(item => item.byExtensionId === extensionId).every(item => /Blackboard[/\\]/.test(item.filename)), 'Download folder and original filenames should be retained');
  const reopen = async () => {
    const pending = context.waitForEvent('page');
    await worker.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL('popup.html'), active: false }));
    const view = await pending;
    view.on('pageerror', error => errors.push(error.message));
    await view.waitForSelector('.file-row');
    return view;
  };
  const restored = await reopen();
  assert.equal(await restored.locator('#selected-count').textContent(), '3');
  await restored.locator('#select-visible').click();
  assert.equal(await restored.locator('#selected-count').textContent(), '5');
  await restored.locator('#download-button').click();
  await restored.locator('#stop-button').waitFor({ state: 'visible' });
  await restored.locator('#stop-button').click();
  await restored.waitForFunction(() => document.getElementById('batch-summary').textContent.includes('已取消'));
  const stopped = await worker.evaluate(async () => (await chrome.storage.session.get('batch')).batch);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.jobs.filter(job => job.status === 'cancelled').length, 2);
  await restored.close();
  await course.goto(`${baseUrl}/course#week2`, { waitUntil: 'domcontentloaded' });
  const switched = await reopen();
  assert.equal(await switched.locator('#selected-count').textContent(), '0');
  assert.ok((await worker.evaluate(async () => (await chrome.storage.session.get('scan')).scan.pageUrl)).endsWith('#week2'));
  await switched.close();
  await course.goto(`${baseUrl}/assignment`, { waitUntil: 'domcontentloaded' });
  const assignment = await reopen();
  assert.equal(await assignment.locator('.file-row').count(), 4);
  await assignment.locator('[data-type="other"]').click();
  assert.equal(await assignment.locator('.file-row').count(), 3);
  assert.deepEqual(await assignment.locator('.file-name').allTextContents(), ['reference.wav', 'input.txt', 'output.txt']);
  assert.equal(await assignment.locator('.type-badge.pdf').count(), 0);
  await assignment.locator('#select-visible').click();
  assert.equal(await assignment.locator('#selected-count').textContent(), '3');
  await assignment.setViewportSize({ width: 460, height: 600 });
  const otherScreenshot = join(tmpdir(), 'blackboard-extension-other.png');
  await assignment.screenshot({ path: otherScreenshot, fullPage: true });
  await assignment.locator('#download-button').click();
  await assignment.waitForFunction(() => document.getElementById('batch-summary').textContent.includes('已完成 3/3'));
  const otherState = await worker.evaluate(async () => ({ batch: (await chrome.storage.session.get('batch')).batch, records: await chrome.downloads.search({}) }));
  assert.deepEqual(otherState.batch.jobs.map(job => job.file.extension), ['wav', 'txt', 'txt']);
  assert.ok(otherState.batch.jobs.every(job => job.status === 'complete'));
  for (const name of ['reference.wav', 'input.txt', 'output.txt']) {
    const record = otherState.records.find(item => item.filename.endsWith(`/Blackboard/${name}`));
    assert.equal(record?.state, 'complete');
  }
  await assignment.close();
  const scrollScreenshots = [];
  for (const warning of [false, true]) {
    await course.goto(`${baseUrl}/lectures${warning ? '?warning=1' : ''}`, { waitUntil: 'domcontentloaded' });
    const longList = await reopen();
    await longList.setViewportSize({ width: 460, height: 600 });
    assert.equal(await longList.locator('.file-row').count(), 16);
    const pointer = await longList.evaluate(() => {
      const list = document.getElementById('file-list').getBoundingClientRect();
      const main = document.querySelector('main').getBoundingClientRect();
      return { x: list.left + list.width / 2, y: Math.min(list.bottom, main.bottom) - 20 };
    });
    await longList.mouse.move(pointer.x, pointer.y);
    await longList.mouse.wheel(0, 4000);
    try {
      await longList.waitForFunction(() => {
        const last = document.querySelector('.file-row:last-child');
        const row = last.getBoundingClientRect();
        const main = document.querySelector('main').getBoundingClientRect();
        const footer = document.querySelector('footer').getBoundingClientRect();
        const hit = document.elementFromPoint(row.left + row.width / 2, row.top + row.height / 2);
        return row.top >= main.top && row.bottom <= Math.min(main.bottom, footer.top)
          && hit?.closest('.file-row') === last;
      }, null, { timeout: 2000 });
    } catch (error) {
      console.error('LAST_ROW_CLIPPED', await longList.evaluate(() => {
        const geometry = selector => {
          const node = document.querySelector(selector), rect = node.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop };
        };
        return { main: geometry('main'), list: geometry('#file-list'), last: geometry('.file-row:last-child'), footer: geometry('footer') };
      }));
      await longList.screenshot({ path: join(tmpdir(), 'blackboard-scroll-before.png') });
      throw error;
    }
    // Geometry is verified before check() so Playwright's auto-scroll cannot hide a regression.
    await longList.locator('.file-row').last().locator('input').check();
    assert.equal(await longList.locator('#selected-count').textContent(), '1');
    assert.equal(await longList.locator('#download-button').isEnabled(), true);
    const lastRowShot = join(tmpdir(), `blackboard-scroll-last-row${warning ? '-warning' : ''}.png`);
    await longList.screenshot({ path: lastRowShot });
    scrollScreenshots.push(lastRowShot);
    await longList.close();
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ result: 'PASS', scanned: 5, selectedAndDownloaded: 3, closedPopup: true,
    authenticatedCookies: true, signedUrlPreserved: true, stoppedWaitingJobs: 2, restoredSelection: true,
    hashRouteRescanned: true, otherCategoryDownloaded: ['reference.wav', 'input.txt', 'output.txt'],
    lastRowReachableAndSelectable: true, scrollScreenshots,
    realToolbarAction: realAction, consoleErrors: errors, screenshot, otherScreenshot, downloadedFiles: await readdir(downloads) }, null, 2));
} finally {
  if (context) await context.close();
  await new Promise(resolve => server.close(resolve));
}

import { fileCategory, filterFiles, setVisibleSelection, validSelection, isBatchActive, samePage } from './selection.js';
import { DirectoryWriter } from './directory-writer.js';

// Native side-panel senders may omit documentId. This public instance URL lets
// the background resolve the live SIDE_PANEL context instead of trusting an ID.
window.history.replaceState(null, '', `#${crypto.randomUUID()}`);

const $ = id => document.getElementById(id);
const ui = {
  pageTitle: $('page-title'), scan: $('scan-button'), notice: $('notice'), search: $('search'),
  total: $('total-count'), visible: $('visible-count'), files: $('file-list'), empty: $('empty-state'),
  emptyTitle: $('empty-title'), emptyDescription: $('empty-description'), select: $('select-visible'),
  clear: $('clear-visible'), selected: $('selected-count'), hidden: $('hidden-selection'),
  download: $('download-button'),
  permissionHint: $('permission-hint'), batchSection: $('batch-section'), batchTitle: $('batch-title'),
  downloadStatus: $('download-status'),
  owner: $('batch-owner'), folder: $('folder-name'), progress: $('batch-progress'), fill: $('progress-fill'),
  summary: $('batch-summary'), jobs: $('batch-files'), stop: $('stop-button'),
};
const filters = [...document.querySelectorAll('[data-type]')];
const labels = { queued: '等待', starting: '正在连接', in_progress: '进行中', complete: '已保存', interrupted: '失败', cancelled: '已取消' };
const terminal = new Set(['complete', 'interrupted', 'cancelled']);
let windowId;
let documentId;
let sourceTab = null;
let pendingSourceTabId = null;
let scan = null;
let scanValid = false;
let sourceChanged = false;
let selected = new Set();
let type = 'all';
let batch = null;
let dismissedCompletionId = null;
let scanning = true;
let busy = 'none';
let permissionLoading = false;
let missingOrigins = [];
let permissionRevision = 0;
let noticeText = '';
let noticeError = false;
let writer = null;
let localRunning = false;
let ownedPlanId = null;
let folderName = '';
let stopRequested = false;
let stopping = false;
let polling = false;
let closed = false;
let timer;
let saveTail = Promise.resolve();
let sourceRevision = 0;
let stateRevision = 0;
let batchRowsId = '';
const jobRows = new Map();

async function request(message) {
  const result = await chrome.runtime.sendMessage({ ...message, panelUrl: window.location.href });
  if (!result?.ok) throw new Error(result?.error || '扩展后台未能完成操作，请重试。');
  return result;
}

function safeText(value) {
  return String(value || '').replace(/https?:\/\/[^\s<>"']+/gi, value => {
    try { return `${new URL(value).origin}/…`; } catch { return '附件网站'; }
  });
}

function domain(url) {
  try { return new URL(url).hostname; } catch { return '附件网站'; }
}

function setNotice(message = '', error = false) {
  noticeText = message;
  noticeError = error;
  renderNotice();
}

function renderNotice() {
  const warnings = scanValid ? scan?.warnings || [] : [];
  const parts = [noticeText, warnings.length ? `部分内容未能扫描：\n${warnings.join('\n')}` : ''].filter(Boolean);
  ui.notice.hidden = !parts.length;
  ui.notice.textContent = safeText(parts.join('\n'));
  ui.notice.classList.toggle('error', noticeError);
}

function visibleFiles() { return filterFiles(scan?.files || [], ui.search.value, type); }
function selectedFiles() { return (scan?.files || []).filter(file => selected.has(file.id)); }
function batchCompleted() {
  return Boolean(batch?.jobs?.length && !batch.stopped && batch.jobs.every(job => job.status === 'complete'));
}
function selectionCompleted() {
  if (!batchCompleted() || dismissedCompletionId === batch.id || selected.size !== batch.jobs.length) return false;
  const files = new Map(selectedFiles().map(file => [file.id, file.url]));
  return batch.jobs.every(job => files.get(job.file.id) === job.file.url);
}
function sourceMatches(result, tab) {
  return Boolean(result && tab && result.sourceTabId === tab.id && samePage(result.pageUrl, tab.url));
}

function persistSelection() {
  if (!scanValid || !scan) return;
  const value = { sourceTabId: sourceTab.id, pageUrl: scan.pageUrl, fileIds: [...selected] };
  const previous = saveTail;
  saveTail = (async () => {
    try { await previous; } catch { /* The newest choice should still be saved. */ }
    await chrome.storage.session.set({ popupSelection: value });
  })();
  void (async () => { try { await saveTail; } catch { /* Selection remains usable in this panel. */ } })();
}

async function updatePermissions() {
  const revision = ++permissionRevision;
  const files = selectedFiles();
  permissionLoading = files.length > 0;
  missingOrigins = [];
  renderControls();
  try {
    const origins = [...new Set(files.map(file => {
      const url = new URL(file.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('附件地址不受支持，请重新扫描。');
      return `${url.protocol}//${url.hostname}/*`;
    }))];
    const granted = await Promise.all(origins.map(origin => chrome.permissions.contains({ origins: [origin] })));
    if (revision !== permissionRevision || closed) return;
    missingOrigins = origins.filter((origin, index) => !granted[index]);
  } catch (error) {
    if (revision !== permissionRevision || closed) return;
    setNotice(`无法检查附件网站权限：${error.message || '请重新勾选文件后重试。'}`, true);
    permissionLoading = true;
    renderControls();
    return;
  }
  if (revision === permissionRevision) {
    permissionLoading = false;
    renderControls();
  }
}

function renderControls() {
  const visible = visibleFiles();
  const visibleSelected = visible.filter(file => selected.has(file.id)).length;
  const hidden = selected.size - visibleSelected;
  const active = isBatchActive(batch);
  const completed = !scanning && busy === 'none' && !localRunning && selectionCompleted();
  const blocked = !scanValid || sourceChanged || scanning || busy !== 'none' || active || !selected.size;
  ui.selected.textContent = String(selected.size);
  ui.hidden.hidden = hidden === 0;
  ui.hidden.textContent = `另有 ${hidden} 个筛选外文件`;
  ui.download.disabled = completed || blocked || permissionLoading || typeof window.showDirectoryPicker !== 'function';
  ui.download.classList.toggle('is-complete', completed);
  ui.download.textContent = busy === 'authorizing' ? '请确认网站授权…' : busy === 'picking' ? '正在选择文件夹…'
    : busy === 'preparing' ? '正在准备下载…' : localRunning ? '正在保存文件…'
    : active ? '下载进行中' : completed ? '✓ 下载已完成' : permissionLoading ? '正在检查权限…' : missingOrigins.length ? '允许附件网站'
    : `选择文件夹下载${selected.size ? ` (${selected.size})` : ''}`;
  const completionStatus = completed ? `下载已完成，共 ${batch.jobs.length} 个文件。` : '';
  if (ui.downloadStatus.textContent !== completionStatus) ui.downloadStatus.textContent = completionStatus;
  ui.scan.disabled = scanning || busy !== 'none';
  ui.scan.textContent = scanning ? '扫描中…' : '重新扫描';
  ui.search.disabled = !scan;
  for (const button of filters) button.disabled = !scan;
  const selectionBlocked = !scanValid || busy !== 'none';
  ui.select.disabled = selectionBlocked || !visible.length || visibleSelected === visible.length;
  ui.clear.disabled = selectionBlocked || !visibleSelected;
  for (const checkbox of ui.files.querySelectorAll('input[type="checkbox"]')) checkbox.disabled = selectionBlocked;
  ui.visible.textContent = scanning ? '正在读取…' : scan ? `显示 ${visible.length} / ${scan.files.length} 个文件` : '尚无可下载文件';
  ui.permissionHint.hidden = !selected.size;
  ui.permissionHint.textContent = completed ? '更改勾选或重新扫描后，可开始下一批下载。' : typeof window.showDirectoryPicker !== 'function'
    ? '当前浏览器不支持选择文件夹，请升级 Chrome 或 Edge 后重试。'
    : missingOrigins.length ? `需要允许 ${missingOrigins.length} 个附件网站；授权后再点击选择文件夹。`
    : '每批重新选择文件夹，不沿用上批目录。';
}

function renderFiles() {
  ui.files.replaceChildren();
  const files = visibleFiles();
  const fragment = document.createDocumentFragment();
  for (const file of files) {
    const row = document.createElement('label');
    row.className = 'file-row';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = file.id;
    checkbox.checked = selected.has(file.id);
    checkbox.setAttribute('aria-label', `选择 ${file.name}`);
    checkbox.addEventListener('change', () => {
      dismissedCompletionId = batch?.id || null;
      if (checkbox.checked) selected.add(file.id); else selected.delete(file.id);
      persistSelection();
      void updatePermissions();
    });
    const badge = document.createElement('span');
    badge.className = `type-badge ${fileCategory(file.extension)}`;
    badge.textContent = file.extension ? file.extension.toUpperCase() : '文件';
    badge.title = badge.textContent;
    badge.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span');
    copy.className = 'file-copy';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    const source = document.createElement('span');
    source.className = 'file-source';
    source.textContent = `${domain(file.url)} · ${safeText(file.source || '当前页面')}`;
    copy.append(name, source);
    row.append(checkbox, badge, copy);
    fragment.append(row);
  }
  ui.files.append(fragment);
  ui.total.textContent = String(scan?.files.length || 0);
  ui.empty.hidden = files.length > 0;
  ui.emptyTitle.textContent = scanning ? '正在读取课程页面' : !scanValid ? '等待可读取的课程页面' : !scan.files.length ? '未找到附件' : '没有匹配的文件';
  ui.emptyDescription.textContent = scanning ? '查找页面中的附件链接和内嵌文件…'
    : !scanValid ? '请进入已登录的课程页，再点击浏览器工具栏中的插件图标。'
    : !scan.files.length ? '先展开课程内容，再重新扫描。子文件夹需要进入后扫描。'
    : '试试其他文件名或类型。筛选不会取消已选文件。';
  renderControls();
}

function renderBatch() {
  const jobs = batch?.jobs || [];
  ui.batchSection.hidden = !jobs.length || batchCompleted();
  const key = batch ? `${batch.id}:${jobs.map(job => job.id).join('|')}` : '';
  if (key !== batchRowsId) {
    batchRowsId = key;
    jobRows.clear();
    ui.jobs.replaceChildren();
    for (const job of jobs) {
      const row = document.createElement('li'); row.className = 'job-row';
      const copy = document.createElement('span'); copy.className = 'job-copy';
      const name = document.createElement('span'); name.className = 'job-name'; name.textContent = job.file.name;
      const meta = document.createElement('span'); meta.className = 'job-meta';
      const error = document.createElement('span'); error.className = 'job-error';
      const status = document.createElement('span'); status.className = 'job-status';
      copy.append(name, meta, error); row.append(copy, status); ui.jobs.append(row);
      jobRows.set(job.id, { meta, error, status });
    }
  }
  const counts = { queued: 0, starting: 0, in_progress: 0, complete: 0, interrupted: 0, cancelled: 0 };
  for (const job of jobs) {
    counts[job.status] = (counts[job.status] || 0) + 1;
    const row = jobRows.get(job.id);
    row.status.textContent = labels[job.status] || '等待';
    row.status.className = `job-status ${['starting', 'in_progress'].includes(job.status) ? 'active' : job.status}`;
    row.meta.textContent = `${domain(job.file.url)}${job.savedName ? ` · 保存为 ${job.savedName}` : ''}`;
    row.error.textContent = safeText(job.error);
    row.error.hidden = !job.error;
  }
  const active = isBatchActive(batch);
  const running = counts.starting + counts.in_progress;
  const finished = counts.complete + counts.interrupted + counts.cancelled;
  const percent = jobs.length ? Math.round(finished / jobs.length * 100) : 0;
  ui.batchTitle.textContent = active ? localRunning ? '正在保存文件' : '下载进行中' : counts.interrupted ? '本批次已结束，部分失败' : batch?.stopped ? '本批次已停止' : '本批次已完成';
  const summary = [`已完成 ${counts.complete}/${jobs.length}`];
  if (running) summary.push(`进行中 ${running}`);
  if (counts.queued) summary.push(`等待 ${counts.queued}`);
  if (counts.interrupted) summary.push(`失败 ${counts.interrupted}`);
  if (counts.cancelled) summary.push(`已取消 ${counts.cancelled}`);
  const text = summary.join(' · ');
  if (ui.summary.textContent !== text) ui.summary.textContent = text;
  ui.progress.setAttribute('aria-valuenow', String(percent)); ui.fill.style.width = `${percent}%`;
  const otherOwner = active && batch?.ownerDocumentId !== documentId;
  ui.owner.hidden = !active;
  ui.owner.textContent = localRunning ? '请保持此侧边栏打开；浏览课程页面不会中断本批保存。'
    : otherOwner ? '另一侧边栏正在保存。你可以查看进度或停止等待项。'
    : '此侧边栏拥有进行中的批次；如无法继续，请停止等待项后重新选择。';
  const destination = batch?.folderName || (localRunning ? folderName : '');
  ui.folder.hidden = !destination;
  ui.folder.textContent = destination ? `目标文件夹：${destination}` : '';
  ui.stop.hidden = !active;
  ui.stop.disabled = stopping || !counts.queued || Boolean(batch?.stopped);
  ui.stop.textContent = stopping ? '正在停止…' : '停止等待项';
  renderControls();
}

async function readActiveTab(tabId) {
  const tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId)
    : (await chrome.tabs.query({ active: true, windowId }))[0];
  if (!tab?.id || (tab.windowId !== undefined && tab.windowId !== windowId)) throw new Error('找不到当前窗口的课程页面，请打开课程页后点击插件图标。');
  if (!tab.url) throw new Error('请在课程页面再次点击工具栏中的插件图标，授权读取当前页。');
  if (!/^https?:\/\//i.test(tab.url)) throw new Error('此页面不支持扫描。请打开 HTTP 或 HTTPS 课程内容页。');
  return tab;
}

async function refreshSource(tabId, initialState = null, forceScan = false) {
  if (localRunning || busy !== 'none') {
    sourceChanged = true;
    setNotice('页面已变化，本批保存会继续。完成后点击“重新扫描”读取新页面。');
    renderControls();
    return;
  }
  const revision = ++sourceRevision;
  if (forceScan) dismissedCompletionId = batch?.id || null;
  ++stateRevision;
  pendingSourceTabId = Number.isInteger(tabId) ? tabId : null;
  const previousScan = scan;
  const previousIds = [...selected];
  scanning = true; scanValid = false; scan = null; selected.clear();
  ++permissionRevision; permissionLoading = false; missingOrigins = [];
  setNotice(); renderFiles();
  try {
    const tab = await readActiveTab(tabId);
    if (closed || revision !== sourceRevision) return;
    pendingSourceTabId = tab.id;
    const saved = (await chrome.storage.session.get('popupSelection')).popupSelection;
    const state = initialState || await request({ type: 'GET_STATE' });
    if (closed || revision !== sourceRevision) return;
    if (state.documentId) documentId = state.documentId;
    const result = !forceScan && sourceMatches(state.scan, tab) ? state : await request({ type: 'SCAN_PAGE', tabId: tab.id });
    if (closed || revision !== sourceRevision) return;
    if (!sourceMatches(result.scan, tab)) throw new Error('扫描结果与当前页面不一致，请再次点击插件图标后重试。');
    sourceTab = tab; scan = result.scan; scanValid = true; sourceChanged = false;
    batch = result.batch ?? state.batch ?? null;
    const samePrevious = sourceMatches(previousScan, tab);
    const savedMatches = saved && samePage(saved.pageUrl, tab.url) && (saved.sourceTabId === undefined || saved.sourceTabId === tab.id);
    selected = validSelection(scan.files, samePrevious ? previousIds : savedMatches ? saved.fileIds : []);
    ui.pageTitle.textContent = scan.title || tab.title || '当前页面';
    ui.pageTitle.title = ui.pageTitle.textContent;
    persistSelection();
    void updatePermissions();
  } catch (error) {
    if (closed || revision !== sourceRevision) return;
    scan = null; scanValid = false; selected.clear(); sourceChanged = true;
    ui.pageTitle.textContent = '尚未读取课程页面';
    ui.pageTitle.removeAttribute('title');
    setNotice(`${error.message || '页面扫描失败。'} 若页面已切换，请在目标页面再点击工具栏中的插件图标。`, true);
  } finally {
    if (!closed && revision === sourceRevision) {
      scanning = false;
      pendingSourceTabId = null;
      renderNotice(); renderFiles(); renderBatch();
    }
  }
}

function mergeJobs(updates) {
  const previous = new Map((batch?.jobs || []).map(job => [job.id, job]));
  return updates.map(job => ({ ...previous.get(job.id), ...job }));
}

async function publishProgress(jobs, { stopped = false } = {}) {
  if (closed || !ownedPlanId) return;
  batch = { ...batch, jobs: mergeJobs(jobs), stopped: Boolean(stopped || stopRequested || batch.stopped), folderName };
  renderBatch();
  const updates = batch.jobs.map(({ id, status, error, savedName }) => ({ id, status, ...(error ? { error } : {}), ...(savedName ? { savedName } : {}) }));
  try {
    const result = await request({ type: 'FOLDER_PROGRESS', planId: ownedPlanId, jobs: updates, folderName, stopped: batch.stopped });
    if (closed) return;
    if (result.batch?.id !== batch.id) throw new Error('下载批次已变化，请检查已保存的文件。');
    batch = { ...result.batch, jobs: mergeJobs(result.batch.jobs) };
    if (batch.stopped) { stopRequested = true; writer?.stop(); }
    renderBatch();
  } catch (error) {
    stopRequested = true; writer?.stop();
    setNotice(`进度同步失败，已停止等待项。${error.message || ''}`, true);
    renderBatch();
    throw error;
  }
}

async function authorize(permissionResult) {
  busy = 'authorizing'; setNotice(); renderControls();
  try {
    if (await permissionResult) {
      missingOrigins = [];
      setNotice('网站授权已完成，请再次点击“选择文件夹下载”。');
    } else setNotice('尚未允许附件网站访问。请再次点击“允许附件网站”重试授权。');
  } catch (error) { setNotice(`未能取得网站授权：${error.message || '请重试。'}`, true); }
  finally { busy = 'none'; renderControls(); }
}

async function useDirectory(pickerResult, selectionSnapshot) {
  ++stateRevision;
  busy = 'picking'; setNotice(); renderControls();
  let prepared = false;
  try {
    const directory = await pickerResult;
    if (closed) return;
    if (!directory?.getFileHandle) throw new Error('未能读取所选文件夹，请重新选择。');
    busy = 'preparing'; renderControls();
    const result = await request({ type: 'PREPARE_PANEL_DOWNLOAD', ...selectionSnapshot });
    ownedPlanId = result.plan?.id || result.batch?.id;
    if (!ownedPlanId || !result.batch?.jobs?.length) throw new Error('下载计划无效，请重新选择。');
    batch = result.batch; prepared = true;
    if (closed) { void endOwnedPlan(); return; }
    if (batch.stopped) throw new Error('此批次已经停止，请重新发起下载。');
    folderName = directory.name || '所选文件夹'; stopRequested = false;
    localRunning = true; busy = 'running';
    writer = new DirectoryWriter({ onProgress: publishProgress });
    renderBatch();
    const finished = await writer.run(batch.jobs, directory);
    if (closed) return;
    if (Array.isArray(finished)) await publishProgress(finished, { stopped: stopRequested });
    if (batch.jobs.some(job => !terminal.has(job.status))) {
      await publishProgress(batch.jobs.map(job => terminal.has(job.status) ? job : {
        ...job, status: job.status === 'queued' && stopRequested ? 'cancelled' : 'interrupted',
        error: job.status === 'queued' && stopRequested ? undefined : '文件未报告保存完成，请重新发起下载。',
      }), { stopped: stopRequested });
    }
    const failures = batch.jobs.filter(job => job.status === 'interrupted').length;
    const outcome = failures ? `本批保存已结束，${failures} 个文件失败。请查看逐项原因。`
      : stopRequested ? '本批已停止；已经开始的文件已处理完毕。' : '';
    setNotice([outcome, sourceChanged ? '课程页面已变化，请重新扫描后开始下一批。' : ''].filter(Boolean).join('\n'), failures > 0);
  } catch (error) {
    if (closed) return;
    if (prepared) {
      stopRequested = true; writer?.stop();
      try {
        await publishProgress(batch.jobs.map(job => terminal.has(job.status) ? job : {
          ...job, status: job.status === 'queued' ? 'cancelled' : 'interrupted',
          error: job.status === 'queued' ? undefined : safeText(error.message || '文件保存中断。'),
        }), { stopped: true });
      } catch {
        await endOwnedPlan();
      }
    }
    setNotice(!prepared && error.name === 'AbortError' ? '已取消文件夹选择，尚未创建下载任务。可再次选择。'
      : `${prepared ? '保存已中断' : '无法开始保存'}：${error.message || '请重新扫描后重试。'}`, error.name !== 'AbortError');
  } finally {
    ++stateRevision;
    localRunning = false; busy = 'none'; writer = null;
    if (!closed) { renderBatch(); void updatePermissions(); }
  }
}

ui.download.addEventListener('click', () => {
  if (ui.download.disabled) return;
  if (missingOrigins.length) {
    try {
      const permissionResult = chrome.permissions.request({ origins: [...missingOrigins] });
      void authorize(permissionResult);
    } catch (error) { setNotice(`未能请求网站授权：${error.message || '请重试。'}`, true); }
    return;
  }
  const selectionSnapshot = { fileIds: [...selected], sourceTabId: sourceTab.id, scanTimestamp: scan.scannedAt };
  try {
    const pickerResult = window.showDirectoryPicker({ mode: 'readwrite', id: 'blackboard-batch', startIn: 'downloads' });
    void useDirectory(pickerResult, selectionSnapshot);
  } catch (error) { setNotice(`无法打开文件夹选择器：${error.message || '请重试；若仍无法打开，请升级 Chrome 或 Edge。'}`, true); }
});

ui.stop.addEventListener('click', async () => {
  if (ui.stop.disabled) return;
  ++stateRevision;
  stopping = true;
  if (localRunning) { stopRequested = true; writer?.stop(); }
  renderBatch();
  try {
    const result = await request({ type: 'STOP_DOWNLOADS' });
    if (localRunning) { if (batch?.id === result.batch?.id) batch.stopped = true; }
    else batch = result.batch ?? batch;
    setNotice('已停止等待项。已经开始的文件会继续保存，请保持负责下载的侧边栏打开。');
  } catch (error) { setNotice(`无法同步停止状态：${error.message || '请重试。'}`, true); }
  finally { stopping = false; renderBatch(); }
});

async function pollState() {
  if (closed || polling || scanning || ['picking', 'preparing'].includes(busy)) return;
  polling = true;
  const revision = stateRevision;
  try {
    const result = await request({ type: 'GET_STATE' });
    if (closed || revision !== stateRevision || scanning) return;
    if (result.documentId) documentId = result.documentId;
    if (localRunning) {
      if (result.batch?.id !== batch?.id || result.batch.stopped) {
        stopRequested = true; writer?.stop();
        if (result.batch?.id === batch?.id) batch.stopped = true;
      }
    } else {
      batch = result.batch ?? null;
      if (scanValid && (!sourceMatches(result.scan, sourceTab) || result.scan.scannedAt !== scan.scannedAt)) {
        scanValid = false; sourceChanged = true;
        setNotice('扫描缓存已变化，请点击“重新扫描”读取当前页面。');
      }
    }
    renderBatch();
  } catch { /* Keep the last known file rows and focus; the next poll retries. */ }
  finally { polling = false; }
}

function sourceChangedNotice() {
  ++sourceRevision;
  ++stateRevision;
  const wasScanning = scanning;
  scanning = false;
  pendingSourceTabId = null;
  sourceChanged = true;
  if (localRunning || busy !== 'none') {
    setNotice('课程页面已变化，本批保存会继续。完成后点击“重新扫描”读取新页面。');
  } else {
    scanValid = false;
    setNotice('页面已切换。请在目标课程页再次点击工具栏中的插件图标，授权并扫描当前页。');
  }
  if (wasScanning) { ui.pageTitle.textContent = '页面已切换'; renderFiles(); } else renderControls();
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.type !== 'PANEL_SOURCE' || message.windowId !== windowId) return;
  if (localRunning || busy !== 'none') sourceChangedNotice();
  else void refreshSource(message.tabId, null, true);
});
chrome.tabs.onActivated.addListener(info => {
  if (info.windowId === windowId && (scanning || info.tabId !== sourceTab?.id)) sourceChangedNotice();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if ((tabId === sourceTab?.id || tabId === pendingSourceTabId) && (changeInfo.status === 'loading' || changeInfo.url)) sourceChangedNotice();
});
ui.scan.addEventListener('click', () => { if (!ui.scan.disabled) void refreshSource(undefined, null, true); });
ui.search.addEventListener('input', renderFiles);
for (const button of filters) button.addEventListener('click', () => {
  type = button.dataset.type;
  for (const filter of filters) filter.setAttribute('aria-pressed', String(filter === button));
  renderFiles();
});
function chooseVisible(checked) {
  const next = setVisibleSelection(selected, visibleFiles(), checked);
  if (next.size !== selected.size || [...next].some(id => !selected.has(id))) dismissedCompletionId = batch?.id || null;
  selected = next;
  for (const checkbox of ui.files.querySelectorAll('input[type="checkbox"]')) checkbox.checked = selected.has(checkbox.value);
  persistSelection(); void updatePermissions();
}
ui.select.addEventListener('click', () => chooseVisible(true));
ui.clear.addEventListener('click', () => chooseVisible(false));

async function endOwnedPlan() {
  if (!ownedPlanId) return;
  try { await chrome.runtime.sendMessage({ type: 'END_PANEL_DOWNLOAD', planId: ownedPlanId, panelUrl: window.location.href }); }
  catch { /* Context reconciliation also cleans up a destroyed panel. */ }
}
window.addEventListener('beforeunload', event => {
  if (localRunning && isBatchActive(batch)) { event.preventDefault(); event.returnValue = ''; }
});
window.addEventListener('pagehide', () => {
  closed = true; clearInterval(timer); ++permissionRevision; ++sourceRevision;
  writer?.stop(); void endOwnedPlan();
});

async function initialize() {
  renderControls();
  try {
    const [state, currentWindow] = await Promise.all([request({ type: 'GET_STATE' }), chrome.windows.getCurrent()]);
    windowId = currentWindow.id; documentId = state.documentId; batch = state.batch ?? null;
    await refreshSource(undefined, state);
  } catch (error) {
    scanning = false; scanValid = false;
    setNotice(error.message || '无法读取当前窗口，请在课程页重新点击插件图标。', true);
    renderFiles(); renderBatch();
  }
  if (!closed) timer = setInterval(pollState, 1000);
}
initialize();

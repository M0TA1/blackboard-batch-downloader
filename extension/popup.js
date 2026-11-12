import { fileCategory, filterFiles, setVisibleSelection, validSelection, isBatchActive, samePage } from './selection.js';

const $ = id => document.getElementById(id);
const ui = {
  pageTitle: $('page-title'), scanButton: $('scan-button'), notice: $('notice'), search: $('search'),
  totalCount: $('total-count'), visibleCount: $('visible-count'), list: $('file-list'),
  selectVisible: $('select-visible'), clearVisible: $('clear-visible'), empty: $('empty-state'),
  emptyTitle: $('empty-title'), emptyDescription: $('empty-description'), emptySymbol: $('empty-symbol'),
  selectedCount: $('selected-count'), hiddenSelection: $('hidden-selection'), download: $('download-button'),
  batchSection: $('batch-section'), batchTitle: $('batch-title'), batchSummary: $('batch-summary'),
  batchDetail: $('batch-detail'), batchErrors: $('batch-errors'), progress: $('batch-progress'),
  progressFill: $('progress-fill'), stop: $('stop-button'),
};
const filters = [...document.querySelectorAll('[data-type]')];
const statusLabels = {
  queued: '等待', starting: '正在启动', in_progress: '下载中', complete: '已完成',
  interrupted: '失败', cancelled: '已取消',
};
let scan = null;
let batch = null;
let activeTab = null;
let selected = new Set();
let type = 'all';
let scanValid = false;
let scanning = true;
let starting = false;
let stopping = false;
let errorMessage = '';
let polling = false;
let closed = false;
let timer;
let selectionSave = Promise.resolve();
const rowStatuses = new Map();

async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '扩展后台未能完成操作，请重试。');
  return result;
}

function visibleFiles() {
  return filterFiles(scan?.files || [], ui.search.value, type);
}

function persistSelection() {
  if (!scanValid || !scan) return;
  const value = { pageUrl: scan.pageUrl, fileIds: [...selected] };
  // Serialize writes so rapid checkbox changes cannot restore an older selection.
  selectionSave = selectionSave.catch(() => {}).then(() => chrome.storage.session.set({ popupSelection: value }));
  selectionSave.catch(() => {});
}

function renderNotice() {
  const warnings = scanValid ? scan?.warnings || [] : [];
  ui.notice.hidden = !errorMessage && warnings.length === 0;
  ui.notice.classList.toggle('error', Boolean(errorMessage));
  ui.notice.textContent = errorMessage || (warnings.length ? `部分内容未能扫描：\n${warnings.join('\n')}` : '');
}

function renderControls() {
  const visible = visibleFiles();
  const visibleSelected = visible.filter(file => selected.has(file.id)).length;
  const hiddenCount = selected.size - visibleSelected;
  const active = isBatchActive(batch);
  ui.selectedCount.textContent = String(selected.size);
  ui.hiddenSelection.hidden = hiddenCount === 0;
  ui.hiddenSelection.textContent = `包含 ${hiddenCount} 个筛选外的文件`;
  ui.download.disabled = !scanValid || scanning || starting || active || selected.size === 0;
  ui.download.textContent = starting ? '正在创建队列…' : active ? '下载进行中' : `↓  下载所选${selected.size ? ` (${selected.size})` : ''}`;
  ui.scanButton.disabled = scanning || starting;
  ui.scanButton.textContent = scanning ? '扫描中…' : '重新扫描';
  ui.search.disabled = !scanValid;
  filters.forEach(button => { button.disabled = !scanValid; });
  ui.selectVisible.disabled = !scanValid || !visible.length || visibleSelected === visible.length;
  ui.clearVisible.disabled = !scanValid || visibleSelected === 0;
  ui.visibleCount.textContent = scanning ? '正在扫描…' : scanValid ? `显示 ${visible.length} / ${scan.files.length} 个文件` : '尚无可下载文件';
}

function renderFiles() {
  ui.list.replaceChildren();
  rowStatuses.clear();
  const files = visibleFiles();
  ui.totalCount.textContent = String(scan?.files.length || 0);
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
      if (checkbox.checked) selected.add(file.id);
      else selected.delete(file.id);
      renderControls();
      persistSelection();
    });
    const badge = document.createElement('span');
    const group = fileCategory(file.extension);
    badge.className = `type-badge ${group}`;
    badge.textContent = file.extension ? file.extension.toUpperCase() : '文件';
    badge.title = badge.textContent;
    badge.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span');
    copy.className = 'file-copy';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    name.title = file.name;
    const source = document.createElement('span');
    source.className = 'file-source';
    source.textContent = file.source || '当前页面';
    source.title = file.source || '当前页面';
    copy.append(name, source);
    const status = document.createElement('span');
    status.className = 'file-job';
    rowStatuses.set(file.id, status);
    row.append(checkbox, badge, copy, status);
    fragment.append(row);
  }
  ui.list.append(fragment);
  ui.empty.hidden = files.length > 0;
  if (scanning) {
    ui.emptySymbol.textContent = '↓';
    ui.emptyTitle.textContent = '正在扫描页面';
    ui.emptyDescription.textContent = '查找页面中的文件链接和内嵌附件…';
  } else if (!scanValid) {
    ui.emptySymbol.textContent = '!';
    ui.emptyTitle.textContent = '暂时无法扫描此页面';
    ui.emptyDescription.textContent = '请进入已登录的课程内容页，再点击重新扫描。';
  } else if (!scan.files.length) {
    ui.emptySymbol.textContent = '↓';
    ui.emptyTitle.textContent = '未找到支持的文件';
    ui.emptyDescription.textContent = '支持 PDF、PPT、Word、表格、文本、音频、压缩包等文件。先展开课程内容，再重新扫描；子文件夹需要进入后扫描。';
  } else {
    ui.emptySymbol.textContent = '⌕';
    ui.emptyTitle.textContent = '没有匹配的文件';
    ui.emptyDescription.textContent = '试试其他文件名或类型。筛选不会取消已选的文件。';
  }
  renderControls();
  renderRowStatuses();
}

function renderRowStatuses() {
  const jobs = new Map((batch?.jobs || []).map(job => [job.file.id, job]));
  for (const [id, element] of rowStatuses) {
    const job = jobs.get(id);
    element.textContent = job ? statusLabels[job.status] || '' : '';
    element.classList.toggle('failed', job?.status === 'interrupted');
    element.title = job?.error || '';
  }
}

function renderBatch() {
  const jobs = batch?.jobs || [];
  ui.batchSection.hidden = jobs.length === 0;
  if (!jobs.length) {
    renderControls();
    renderRowStatuses();
    return;
  }
  const counts = { queued: 0, starting: 0, in_progress: 0, complete: 0, interrupted: 0, cancelled: 0 };
  for (const job of jobs) counts[job.status] = (counts[job.status] || 0) + 1;
  const active = isBatchActive(batch);
  const running = counts.starting + counts.in_progress;
  const finished = counts.complete + counts.interrupted + counts.cancelled;
  const progress = Math.round(finished / jobs.length * 100);
  ui.batchTitle.textContent = active ? '下载进行中' : counts.interrupted ? '下载已结束，部分失败' : batch.stopped ? '下载队列已停止' : '下载已完成';
  ui.progress.setAttribute('aria-valuenow', String(progress));
  ui.progressFill.style.width = `${progress}%`;
  const summary = [`已完成 ${counts.complete}/${jobs.length}`];
  if (running) summary.push(`进行中 ${running}`);
  if (counts.queued) summary.push(`等待 ${counts.queued}`);
  if (counts.interrupted) summary.push(`失败 ${counts.interrupted}`);
  if (counts.cancelled) summary.push(`已取消 ${counts.cancelled}`);
  const summaryText = summary.join(' · ');
  if (ui.batchSummary.textContent !== summaryText) ui.batchSummary.textContent = summaryText;
  ui.batchDetail.textContent = batch.stopped && active
    ? '已停止等待项。已经开始的下载会继续，请在浏览器下载列表查看。'
    : active ? '以浏览器报告的状态为准。已创建下载任务不代表文件已完成。'
    : counts.interrupted ? '请查看失败原因；若需要登录，请重新登录课程页面后重试。'
    : '可在浏览器下载列表中查看文件。';
  ui.stop.hidden = !active;
  ui.stop.disabled = stopping || counts.queued === 0;
  ui.stop.textContent = stopping ? '正在停止…' : '停止等待项';
  ui.batchErrors.replaceChildren();
  const failures = jobs.filter(job => job.status === 'interrupted');
  ui.batchErrors.hidden = failures.length === 0;
  for (const job of failures) {
    const item = document.createElement('li');
    item.textContent = `${job.file.name}：${job.error || '下载中断，请在浏览器下载列表查看。'}`;
    ui.batchErrors.append(item);
  }
  renderControls();
  renderRowStatuses();
}

function acceptScan(result, savedIds = [...selected]) {
  if (!result || !Array.isArray(result.files) || !samePage(result.pageUrl, activeTab?.url)) {
    throw new Error('扫描结果与当前页面不一致，请重新扫描。');
  }
  scan = result;
  selected = validSelection(scan.files, savedIds);
  scanValid = true;
  errorMessage = '';
  ui.pageTitle.textContent = scan.title || activeTab.title || '当前页面';
  ui.pageTitle.title = scan.title || activeTab.title || '当前页面';
}

async function scanCurrentPage() {
  if (scanning && scanValid) return;
  const previousPage = scan?.pageUrl;
  const previousIds = [...selected];
  scanning = true;
  scanValid = false;
  scan = null;
  selected.clear();
  errorMessage = '';
  renderNotice();
  renderFiles();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:\/\//i.test(tab.url || '')) {
      throw new Error('此页面不支持扫描。请打开 HTTP 或 HTTPS 课程内容页。');
    }
    activeTab = tab;
    ui.pageTitle.textContent = tab.title || '当前页面';
    const result = await request({ type: 'SCAN_PAGE', tabId: tab.id });
    acceptScan(result.scan, samePage(previousPage, tab.url) ? previousIds : []);
    batch = result.batch ?? batch;
    persistSelection();
  } catch (error) {
    errorMessage = error.message || '页面扫描失败，请重试。';
    // Keep the cached background scan inaccessible after a failed scan.
    scanValid = false;
    scan = null;
    selected.clear();
  } finally {
    scanning = false;
    renderNotice();
    renderFiles();
    renderBatch();
  }
}

async function pollState() {
  if (polling || scanning || starting || stopping || closed) return;
  polling = true;
  try {
    const result = await request({ type: 'GET_STATE' });
    if (closed) return;
    batch = result.batch ?? null;
    // A failed scan cannot regain access to an older scan through polling.
    if (scanValid && (!result.scan || !samePage(result.scan.pageUrl, scan.pageUrl))) {
      scanValid = false;
      scan = null;
      selected.clear();
      errorMessage = '扫描缓存已变更，请重新扫描当前页面。';
      renderNotice();
      renderFiles();
    } else if (scanValid && result.scan.scannedAt !== scan.scannedAt) {
      acceptScan(result.scan);
      persistSelection();
      renderNotice();
      renderFiles();
    }
    renderBatch();
  } catch {
    // Leave the last known download state visible; the next poll retries.
  } finally {
    polling = false;
  }
}

ui.search.addEventListener('input', renderFiles);
for (const button of filters) {
  button.addEventListener('click', () => {
    type = button.dataset.type;
    filters.forEach(filter => filter.setAttribute('aria-pressed', String(filter === button)));
    renderFiles();
  });
}
function chooseVisible(checked) {
  selected = setVisibleSelection(selected, visibleFiles(), checked);
  for (const checkbox of ui.list.querySelectorAll('input[type="checkbox"]')) checkbox.checked = selected.has(checkbox.value);
  renderControls();
  persistSelection();
}
ui.selectVisible.addEventListener('click', () => chooseVisible(true));
ui.clearVisible.addEventListener('click', () => chooseVisible(false));
ui.scanButton.addEventListener('click', scanCurrentPage);
ui.download.addEventListener('click', async () => {
  if (ui.download.disabled || !scanValid) return;
  starting = true;
  errorMessage = '';
  renderNotice();
  renderControls();
  try {
    batch = (await request({ type: 'START_DOWNLOADS', fileIds: [...selected] })).batch;
  } catch (error) {
    errorMessage = error.message || '无法启动下载，请重试。';
  } finally {
    starting = false;
    renderNotice();
    renderBatch();
  }
});
ui.stop.addEventListener('click', async () => {
  if (ui.stop.disabled) return;
  stopping = true;
  renderBatch();
  try {
    batch = (await request({ type: 'STOP_DOWNLOADS' })).batch;
  } catch (error) {
    errorMessage = error.message || '无法停止等待项，请重试。';
  } finally {
    stopping = false;
    renderNotice();
    renderBatch();
  }
});

async function initialize() {
  renderControls();
  try {
    const [stateResult, tabsResult, savedResult] = await Promise.allSettled([
      request({ type: 'GET_STATE' }),
      chrome.tabs.query({ active: true, currentWindow: true }),
      chrome.storage.session.get('popupSelection'),
    ]);
    if (stateResult.status === 'rejected') throw stateResult.reason;
    if (tabsResult.status === 'rejected') throw tabsResult.reason;
    const state = stateResult.value;
    activeTab = tabsResult.value[0];
    batch = state.batch ?? null;
    if (!activeTab) throw new Error('找不到活动页面，请打开课程页面后重试。');
    ui.pageTitle.textContent = activeTab.title || '当前页面';
    const saved = savedResult.status === 'fulfilled' ? savedResult.value.popupSelection : null;
    if (state.scan && samePage(state.scan.pageUrl, activeTab.url)) {
      acceptScan(state.scan, samePage(saved?.pageUrl, state.scan.pageUrl) ? saved.fileIds : []);
      scanning = false;
      renderNotice();
      renderFiles();
      renderBatch();
    } else {
      await scanCurrentPage();
    }
  } catch (error) {
    scanning = false;
    scanValid = false;
    errorMessage = error.message || '无法读取扩展状态，请重新打开弹窗。';
    renderNotice();
    renderFiles();
    renderBatch();
  }
  if (!closed) timer = setInterval(pollState, 1000);
}
window.addEventListener('pagehide', () => {
  closed = true;
  clearInterval(timer);
});
initialize();

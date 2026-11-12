import { DirectoryWriter } from './directory-writer.js';

const $ = id => document.getElementById(id);
const ui = {
  title: $('page-title'), count: $('file-count'), notice: $('notice'), start: $('start-button'),
  folder: $('folder-name'), destinationHint: $('destination-hint'), permissions: $('permission-section'),
  domains: $('permission-domains'), permissionHint: $('permission-hint'), list: $('file-list'),
  progressTitle: $('progress-title'), summary: $('progress-summary'), progress: $('batch-progress'),
  fill: $('progress-fill'), stop: $('stop-button'),
};
const labels = { queued: '等待', starting: '正在连接', in_progress: '保存中', complete: '已保存', interrupted: '失败', cancelled: '已取消' };
const terminal = new Set(['complete', 'interrupted', 'cancelled']);
let planId = '';
let plan = null;
let batch = null;
let phase = 'loading';
let missingOrigins = [];
let folderName = '';
let writer = null;
let started = false;
let stopRequested = false;
let stopping = false;
let polling = false;
let closed = false;
let timer;
const rows = new Map();

async function request(message) {
  const result = await chrome.runtime.sendMessage(message);
  if (!result?.ok) throw new Error(result?.error || '扩展后台未能完成操作，请重试。');
  return result;
}

function safeMessage(value) {
  // A failed signed request must not expose its query in the page or a tooltip.
  return String(value || '').replace(/https?:\/\/[^\s<>"']+/gi, text => {
    try { return `${new URL(text).origin}/…`; } catch { return '附件网站'; }
  });
}

function notice(message = '', error = false) {
  ui.notice.textContent = safeMessage(message);
  ui.notice.hidden = !message;
  ui.notice.classList.toggle('error', error);
}

function mergeJobs(updates) {
  const current = new Map((batch?.jobs || []).map(job => [job.id, job]));
  return updates.map(update => ({ ...current.get(update.id), ...update }));
}

function renderFiles() {
  ui.list.replaceChildren();
  rows.clear();
  const fragment = document.createDocumentFragment();
  for (const [index, job] of batch.jobs.entries()) {
    const row = document.createElement('li');
    row.className = 'file-row';
    const number = document.createElement('span');
    number.className = 'file-index';
    number.textContent = String(index + 1).padStart(2, '0');
    number.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span');
    copy.className = 'file-copy';
    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = job.file.name;
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    const domain = new URL(job.file.url).hostname;
    meta.textContent = `${job.file.extension ? job.file.extension.toUpperCase() : '文件'} · ${domain}`;
    const error = document.createElement('span');
    error.className = 'file-error';
    error.hidden = true;
    copy.append(name, meta, error);
    const status = document.createElement('span');
    status.className = 'file-status';
    rows.set(job.id, { status, error, meta, domain });
    row.append(number, copy, status);
    fragment.append(row);
  }
  ui.list.append(fragment);
}

function render() {
  const jobs = batch?.jobs || [];
  const counts = { queued: 0, starting: 0, in_progress: 0, complete: 0, interrupted: 0, cancelled: 0 };
  for (const job of jobs) {
    counts[job.status] = (counts[job.status] || 0) + 1;
    const row = rows.get(job.id);
    if (!row) continue;
    row.status.textContent = labels[job.status] || '等待';
    row.status.className = `file-status ${['starting', 'in_progress'].includes(job.status) ? 'active' : job.status}`;
    row.error.hidden = !job.error;
    row.error.textContent = safeMessage(job.error);
    row.meta.textContent = job.savedName ? `${row.domain} · 保存为 ${job.savedName}` : `${job.file.extension ? job.file.extension.toUpperCase() : '文件'} · ${row.domain}`;
  }
  const finished = counts.complete + counts.interrupted + counts.cancelled;
  const percent = jobs.length ? Math.round(finished / jobs.length * 100) : 0;
  ui.count.textContent = `${jobs.length} 个文件`;
  ui.progress.setAttribute('aria-valuenow', String(percent));
  ui.fill.style.width = `${percent}%`;
  const summary = [`已保存 ${counts.complete}/${jobs.length}`];
  const running = counts.starting + counts.in_progress;
  if (running) summary.push(`保存中 ${running}`);
  if (counts.queued) summary.push(`等待 ${counts.queued}`);
  if (counts.interrupted) summary.push(`失败 ${counts.interrupted}`);
  if (counts.cancelled) summary.push(`已取消 ${counts.cancelled}`);
  const text = phase === 'loading' ? '正在载入…' : summary.join(' · ');
  if (ui.summary.textContent !== text) ui.summary.textContent = text;
  ui.progressTitle.textContent = phase === 'running' ? stopRequested ? '正在完成已开始的文件' : '正在保存文件' : phase === 'finished' ? counts.interrupted ? '保存已结束，部分失败' : stopRequested ? '本批次已停止' : '本批次已结束' : '待保存文件';
  ui.folder.textContent = folderName || '尚未选择文件夹';
  ui.destinationHint.textContent = phase === 'running' ? '请保持此页面打开，已开始的文件会继续保存。'
    : phase === 'finished' ? '如需再下载，请回到课程页面重新选择文件。'
    : '只需选择一次；已有同名文件会自动加序号。';
  ui.start.disabled = !plan || phase !== 'ready' || started || stopRequested;
  ui.start.textContent = phase === 'loading' ? '正在准备…' : phase === 'authorizing' ? '请确认网站授权…'
    : phase === 'picking' ? '正在选择文件夹…' : phase === 'running' ? '正在保存…'
    : phase === 'finished' ? '本批次已结束' : phase === 'error' ? '暂时无法开始'
    : missingOrigins.length ? '允许附件网站' : '选择文件夹并开始';
  ui.stop.disabled = !plan || !counts.queued || stopping || stopRequested || phase === 'loading' || phase === 'finished';
  ui.stop.textContent = stopping ? '正在停止…' : '停止等待项';
}

async function publishProgress(jobs, { stopped = false } = {}) {
  if (closed) return;
  batch = { ...batch, jobs: mergeJobs(jobs), stopped: Boolean(stopped || stopRequested || batch.stopped) };
  render();
  const updates = batch.jobs.map(({ id, status, error, savedName }) => ({
    id, status, ...(error ? { error } : {}), ...(savedName ? { savedName } : {}),
  }));
  try {
    const result = await request({ type: 'FOLDER_PROGRESS', planId, jobs: updates, folderName, stopped: batch.stopped });
    if (closed) return;
    if (result.batch?.id === batch.id) {
      batch = { ...result.batch, jobs: mergeJobs(result.batch.jobs) };
      if (batch.stopped) {
        stopRequested = true;
        writer?.stop();
      }
      render();
    }
  } catch (error) {
    stopRequested = true;
    writer?.stop();
    notice(`进度同步失败，已停止等待项。${error.message || ''}`, true);
    render();
  }
}

async function finishPermissionRequest(permissionResult) {
  phase = 'authorizing';
  notice();
  render();
  try {
    const allowed = await permissionResult;
    if (allowed) {
      missingOrigins = [];
      ui.permissionHint.textContent = '所需网站已获授权。点击“选择文件夹并开始”继续。';
      notice('网站授权已完成，请再次点击“选择文件夹并开始”。');
    } else {
      notice('尚未允许附件网站访问。可重试授权，或先停止此批次，再回到课程页使用浏览器下载。');
    }
  } catch (error) {
    notice(`未能取得网站授权：${error.message || '请重试。'}`, true);
  } finally {
    phase = stopRequested ? 'finished' : 'ready';
    render();
  }
}

async function usePickedDirectory(pickerResult) {
  phase = 'picking';
  notice();
  render();
  try {
    const directory = await pickerResult;
    if (closed) return;
    if (stopRequested || batch.stopped) {
      phase = 'finished';
      notice('此批次已停止，未开始保存文件。请回到课程页重新选择。');
      return;
    }
    if (!directory || typeof directory.getFileHandle !== 'function') throw new Error('未能读取所选文件夹，请重新选择。');
    folderName = directory.name || '所选文件夹';
    started = true;
    phase = 'running';
    writer = new DirectoryWriter({ onProgress: publishProgress });
    render();
    const result = await writer.run(batch.jobs, directory);
    if (closed) return;
    if (Array.isArray(result)) await publishProgress(result, { stopped: stopRequested });
    else if (Array.isArray(result?.jobs)) await publishProgress(result.jobs, { stopped: stopRequested || result.stopped });
    // A resolved run alone is not evidence that a file's writable stream closed.
    if (batch.jobs.some(job => !terminal.has(job.status))) {
      const jobs = batch.jobs.map(job => terminal.has(job.status) ? job : {
        ...job, status: job.status === 'queued' && stopRequested ? 'cancelled' : 'interrupted',
        error: job.status === 'queued' && stopRequested ? undefined : '文件未报告保存完成，请重新发起下载。',
      });
      await publishProgress(jobs, { stopped: stopRequested });
    }
    phase = 'finished';
    if (!stopRequested && !batch.jobs.some(job => job.status === 'interrupted')) notice('所选文件已保存。现在可以关闭此页面。');
  } catch (error) {
    if (!started) {
      phase = stopRequested ? 'finished' : 'ready';
      notice(stopRequested ? '此批次已停止，尚未保存文件。请回到课程页重新选择。'
        : error.name === 'AbortError' ? '已取消文件夹选择，尚未保存文件。可再次选择。'
        : `无法打开文件夹：${error.message || '请重试。'}`, error.name !== 'AbortError');
    } else {
      stopRequested = true;
      writer?.stop();
      const jobs = batch.jobs.map(job => terminal.has(job.status) ? job : {
        ...job, status: job.status === 'queued' ? 'cancelled' : 'interrupted',
        error: job.status === 'queued' ? undefined : safeMessage(error.message || '文件保存中断。'),
      });
      await publishProgress(jobs, { stopped: true });
      phase = 'finished';
      notice(`保存已中断：${error.message || '请回到课程页重新发起下载。'}`, true);
    }
  } finally {
    render();
  }
}

ui.start.addEventListener('click', () => {
  if (ui.start.disabled || phase !== 'ready') return;
  if (missingOrigins.length) {
    try {
      // Keep request() in the direct click stack; do not await before it.
      const permissionResult = chrome.permissions.request({ origins: [...missingOrigins] });
      void finishPermissionRequest(permissionResult);
    } catch (error) {
      notice(`未能请求网站授权：${error.message || '请重试。'}`, true);
    }
    return;
  }
  try {
    // The picker must run before any async work consumes transient activation.
    const pickerResult = window.showDirectoryPicker({ mode: 'readwrite', id: 'blackboard-batch', startIn: 'downloads' });
    void usePickedDirectory(pickerResult);
  } catch (error) {
    notice(`无法打开文件夹选择器：${error.message || '请使用浏览器下载。'}`, true);
  }
});

async function finishUnstartedBatch() {
  stopRequested = true;
  phase = 'finished';
  await publishProgress(batch.jobs.map(job => job.status === 'queued' ? { ...job, status: 'cancelled' } : job), { stopped: true });
  render();
}

ui.stop.addEventListener('click', async () => {
  if (ui.stop.disabled) return;
  stopping = true;
  stopRequested = true;
  writer?.stop();
  render();
  try {
    const result = await request({ type: 'STOP_DOWNLOADS' });
    if (result.batch?.id === batch.id) batch = { ...result.batch, jobs: mergeJobs(result.batch.jobs) };
    if (!started) await finishUnstartedBatch();
    notice('已停止等待项。已经开始的文件会继续保存，请保持此页面打开。');
  } catch (error) {
    notice(`无法同步停止状态：${error.message || '本页已停止等待项。'}`, true);
    if (!started) await finishUnstartedBatch();
  } finally {
    stopping = false;
    render();
  }
});

async function pollState() {
  if (polling || !batch || closed || phase === 'finished' || phase === 'error') return;
  polling = true;
  try {
    const result = await request({ type: 'GET_STATE' });
    if (closed) return;
    if (result.batch?.id !== batch.id) {
      stopRequested = true;
      writer?.stop();
      if (!started) phase = 'finished';
      notice('此下载计划已不再活动。请回到课程页重新选择文件。', true);
      render();
      return;
    }
    if (result.batch.stopped && !stopRequested) {
      stopRequested = true;
      writer?.stop();
      batch.stopped = true;
      if (!started) await finishUnstartedBatch();
      notice('等待项已由插件停止。已经开始的文件会继续保存。');
      render();
    }
  } catch {
    notice('暂时无法读取后台状态。本页会继续重试，停止操作也可在此页面执行。', true);
  } finally {
    polling = false;
  }
}

async function initialize() {
  try {
    planId = decodeURIComponent(window.location.hash.slice(1));
    if (!planId) throw new Error('缺少下载计划，请回到课程页面重新选择文件。');
    const result = await request({ type: 'GET_FOLDER_PLAN', planId });
    plan = result.plan;
    batch = result.batch;
    if (!plan?.files?.length || !batch?.jobs?.length) throw new Error('下载计划为空或已失效，请重新选择文件。');
    ui.title.textContent = plan.title || '课程文件';
    document.title = `${plan.title || '课程文件'} · 文件夹下载`;
    folderName = batch.folderName || '';
    renderFiles();
    if (batch.stopped || batch.jobs.some(job => job.status !== 'queued')) {
      stopRequested = Boolean(batch.stopped);
      phase = 'finished';
      notice('此计划已执行或已停止。刷新页面后无法恢复文件夹授权，请回到课程页重新选择文件。');
      render();
      return;
    }
    if (typeof window.showDirectoryPicker !== 'function') {
      throw new Error('当前浏览器不支持选择文件夹保存。请先点击“停止等待项”，再回到课程页面，在插件中选择“使用浏览器下载”。');
    }
    const origins = [...new Set(plan.files.map(file => {
      const url = new URL(file.url);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('附件地址不受支持，请重新扫描课程页。');
      return `${url.protocol}//${url.hostname}/*`;
    }))];
    const granted = await Promise.all(origins.map(origin => chrome.permissions.contains({ origins: [origin] })));
    missingOrigins = origins.filter((origin, index) => !granted[index]);
    for (const origin of origins) {
      const item = document.createElement('li');
      item.textContent = new URL(origin.slice(0, -1)).hostname;
      ui.domains.append(item);
    }
    ui.permissions.hidden = origins.length === 0;
    if (!missingOrigins.length) ui.permissionHint.textContent = '所需附件网站已获授权。请选择本地保存文件夹。';
    phase = 'ready';
    render();
    timer = setInterval(pollState, 1000);
  } catch (error) {
    phase = 'error';
    notice(error.message || '下载页无法初始化，请回到课程页重试。', true);
    render();
  }
}

window.addEventListener('beforeunload', event => {
  if (phase === 'running' && batch?.jobs.some(job => !terminal.has(job.status))) {
    event.preventDefault();
    event.returnValue = '';
  }
});
window.addEventListener('pagehide', () => {
  closed = true;
  clearInterval(timer);
  // No final progress report: the background tab lifecycle marks unfinished jobs.
});
initialize();

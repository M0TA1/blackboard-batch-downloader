import './file-types.js';

const ACTIVE = new Set(['queued', 'starting', 'in_progress']);
const TERMINAL = new Set(['complete', 'interrupted', 'cancelled']);
const RANK = { queued: 0, starting: 1, in_progress: 2, complete: 3, interrupted: 3, cancelled: 3 };
export const isActiveBatch = batch => Boolean(batch?.jobs?.some(job => ACTIVE.has(job.status)));

/** Keeps folder jobs visible across popup/worker lifetimes. Directory handles stay in the tab. */
export class FolderSession {
  constructor(api) { this.api = api; }
  async current() { return (await this.api.storage.session.get('folderBatch')).folderBatch || null; }
  async clear() { await this.api.storage.session.set({ folderPlan: null, folderBatch: null }); }

  async prepare(files, scan) {
    if (isActiveBatch(await this.current())) throw new Error('当前文件夹下载尚未结束，请先完成或停止该批次。');
    if (!Array.isArray(files) || !files.length) throw new Error('请选择要下载的文件。');
    for (const file of files) {
      const url = new URL(file.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !globalThis.BBFileTypes.isDownloadExtension(file.extension)) throw new Error('文件地址或类型无效，请重新扫描。');
    }
    const id = crypto.randomUUID();
    const plan = { id, files: structuredClone(files), sourceTabId: scan.sourceTabId, pageUrl: scan.pageUrl, title: scan.title || '课程附件', createdAt: Date.now() };
    const batch = { id, mode: 'folder', createdAt: plan.createdAt, stopped: false,
      jobs: plan.files.map((file, index) => ({ id: `${id}-${index}`, file, status: 'queued' })) };
    await this.api.storage.session.set({ folderPlan: plan, folderBatch: batch });
    try {
      const tab = await this.api.tabs.create({ url: this.api.runtime.getURL(`downloader.html#${id}`), active: true });
      if (!Number.isInteger(tab.id)) throw new Error('无法打开下载页面。');
      plan.tabId = tab.id;
      batch.tabId = tab.id;
      await this.api.storage.session.set({ folderPlan: plan, folderBatch: batch });
      return { planId: id, tabId: tab.id, batch };
    } catch (error) { await this.clear(); throw error; }
  }

  async owned(planId, sender) {
    const plan = (await this.api.storage.session.get('folderPlan')).folderPlan;
    const batch = await this.current();
    if (!plan || plan.id !== planId || batch?.id !== planId) throw new Error('下载计划已失效，请回到课程页面重新选择文件。');
    if (sender?.tab?.id !== plan.tabId || sender.url !== this.api.runtime.getURL(`downloader.html#${planId}`)) throw new Error('此下载计划属于另一个页面。');
    return { plan, batch };
  }

  async get(planId, sender) {
    const { plan, batch } = await this.owned(planId, sender);
    // This request is made once on page load. A second claim while writing means
    // that the old page and its directory handle were lost through a reload.
    if (batch.jobs.some(job => ['starting', 'in_progress'].includes(job.status))) {
      await this.closeTab(plan.tabId, '下载页已刷新，文件夹连接已中断，请检查已保存文件后重新选择下载。');
      return { plan, batch: await this.current() };
    }
    plan.claimed = true;
    await this.api.storage.session.set({ folderPlan: plan });
    return { plan, batch };
  }

  async update(message, sender) {
    const { batch } = await this.owned(message.planId, sender);
    if (!Array.isArray(message.jobs) || message.jobs.length !== batch.jobs.length) throw new Error('下载状态条目不完整。');
    const incoming = new Map(message.jobs.map(job => [job.id, job]));
    if (incoming.size !== batch.jobs.length || batch.jobs.some(job => !incoming.has(job.id))) throw new Error('下载状态包含未知文件。');
    const jobs = batch.jobs.map(previous => {
      const next = incoming.get(previous.id);
      if (!(next.status in RANK)) throw new Error('下载状态无效。');
      if (previous.status === 'cancelled' && batch.stopped && ['queued', 'cancelled', 'interrupted'].includes(next.status)) return previous;
      if ((TERMINAL.has(previous.status) && next.status !== previous.status) || RANK[next.status] < RANK[previous.status]) throw new Error('下载任务已经结束或状态已过期。');
      const job = { ...previous, status: next.status };
      if (typeof next.error === 'string') job.error = next.error.slice(0, 1200);
      else delete job.error;
      if (typeof next.savedName === 'string') job.savedName = next.savedName.slice(0, 250);
      return job;
    });
    batch.jobs = jobs;
    batch.stopped = batch.stopped || message.stopped === true;
    if (batch.stopped) for (const job of batch.jobs) if (job.status === 'queued') job.status = 'cancelled';
    if (typeof message.folderName === 'string') batch.folderName = message.folderName.slice(0, 200);
    await this.api.storage.session.set({ folderBatch: batch });
    return batch;
  }

  async stop() {
    const batch = await this.current();
    if (!batch) return null;
    batch.stopped = true;
    for (const job of batch.jobs) if (job.status === 'queued') job.status = 'cancelled';
    await this.api.storage.session.set({ folderBatch: batch });
    return batch;
  }

  async closeTab(tabId, reason = '下载页已关闭，尚未完成的文件未保存成功；请检查文件夹后重新下载。') {
    const batch = await this.current();
    if (!batch || batch.tabId !== tabId || !isActiveBatch(batch)) return;
    batch.stopped = true;
    for (const job of batch.jobs) {
      if (job.status === 'queued') job.status = 'cancelled';
      else if (['starting', 'in_progress'].includes(job.status)) { job.status = 'interrupted'; job.error = reason; }
    }
    await this.api.storage.session.set({ folderBatch: batch });
  }

  async navigateTab(tabId) {
    const plan = (await this.api.storage.session.get('folderPlan')).folderPlan;
    if (plan?.tabId === tabId && plan.claimed) {
      await this.closeTab(tabId, '下载页已离开或刷新，未完成的文件已中断；请检查文件夹后重新下载。');
    }
  }
}

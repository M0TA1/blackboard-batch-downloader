import './file-types.js';

const ACTIVE = new Set(['queued', 'starting', 'in_progress']);
const TERMINAL = new Set(['complete', 'interrupted', 'cancelled']);
const RANK = { queued: 0, starting: 1, in_progress: 2, complete: 3, interrupted: 3, cancelled: 3 };
export const isActiveBatch = batch => Boolean(batch?.jobs?.some(job => ACTIVE.has(job.status)));

/** Keeps folder jobs visible across UI/worker lifetimes. Handles stay in their owning document. */
export class FolderSession {
  constructor(api) { this.api = api; }
  async current() {
    const batch = (await this.api.storage.session.get('folderBatch')).folderBatch || null;
    if (batch && batch.surface !== 'panel') {
      await this.clear();
      return null;
    }
    return batch;
  }
  async clear() { await this.api.storage.session.set({ folderPlan: null, folderBatch: null }); }

  async resolvePanelSender(sender, panelUrl) {
    const base = this.api.runtime.getURL('sidepanel.html');
    // Native side panels omit MessageSender.documentId, and their sender URL
    // omits same-document fragments. Resolve the UI's unique instance URL in
    // the browser's live SIDE_PANEL contexts instead of trusting a supplied ID.
    if (sender.url !== base) return sender;
    if (typeof panelUrl !== 'string' || !panelUrl.startsWith(`${base}#`) || !/^#[0-9a-f-]{36}$/i.test(new URL(panelUrl).hash)) throw new Error('侧边栏实例无效，请关闭后重新打开插件。');
    const contexts = await this.api.runtime.getContexts({ contextTypes: ['SIDE_PANEL'], documentUrls: [panelUrl] });
    const matches = contexts.filter(context => context.contextType === 'SIDE_PANEL' && context.documentUrl === panelUrl && context.documentId);
    if (matches.length !== 1) throw new Error('侧边栏已失效，请关闭后重新打开插件。');
    if (sender.documentId && sender.documentId !== matches[0].documentId) throw new Error('侧边栏身份不一致，请重新打开插件。');
    return { ...sender, documentId: matches[0].documentId };
  }

  async preparePanel(files, scan, sender) {
    await this.reconcilePanel();
    if (isActiveBatch(await this.current())) throw new Error('当前批次仍在保存，请先等待完成或停止等待项。');
    if (!sender?.documentId || sender.url !== this.api.runtime.getURL('sidepanel.html')) throw new Error('请在插件侧边栏中开始下载。');
    if (typeof this.api.runtime.getContexts !== 'function') throw new Error('当前浏览器不支持侧边栏下载，请更新浏览器后重试。');
    if (!Array.isArray(files) || !files.length) throw new Error('请选择要下载的文件。');
    for (const file of files) {
      const url = new URL(file.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !globalThis.BBFileTypes.isDownloadExtension(file.extension)) throw new Error('文件地址或类型无效，请重新扫描。');
    }
    const id = crypto.randomUUID();
    const plan = { id, surface: 'panel', ownerDocumentId: sender.documentId, files: structuredClone(files), sourceTabId: scan.sourceTabId, pageUrl: scan.pageUrl, title: scan.title || '课程附件', createdAt: Date.now() };
    const batch = { id, mode: 'folder', surface: 'panel', ownerDocumentId: sender.documentId, sourceTabId: scan.sourceTabId, title: plan.title, createdAt: plan.createdAt, stopped: false,
      jobs: plan.files.map((file, index) => ({ id: `${id}-${index}`, file, status: 'queued' })) };
    await this.api.storage.session.set({ folderPlan: plan, folderBatch: batch });
    return { plan, batch };
  }

  async owned(planId, sender) {
    const plan = (await this.api.storage.session.get('folderPlan')).folderPlan;
    const batch = await this.current();
    if (!plan || plan.id !== planId || batch?.id !== planId) throw new Error('下载计划已失效，请回到课程页面重新选择文件。');
    if (plan.surface !== 'panel' || sender?.documentId !== plan.ownerDocumentId || sender.url !== this.api.runtime.getURL('sidepanel.html')) throw new Error('此下载计划属于另一个侧边栏。');
    return { plan, batch };
  }

  async update(message, sender) {
    const { batch } = await this.owned(message.planId, sender);
    if (!Array.isArray(message.jobs) || message.jobs.length !== batch.jobs.length) throw new Error('下载状态条目不完整。');
    const incoming = new Map(message.jobs.map(job => [job.id, job]));
    if (incoming.size !== batch.jobs.length || batch.jobs.some(job => !incoming.has(job.id))) throw new Error('下载状态包含未知文件。');
    const jobs = batch.jobs.map(previous => {
      const next = incoming.get(previous.id);
      if (!Object.hasOwn(RANK, next.status)) throw new Error('下载状态无效。');
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

  async finishUnfinished(batch, reason) {
    if (!isActiveBatch(batch)) return batch;
    batch.stopped = true;
    for (const job of batch.jobs) {
      if (job.status === 'queued') job.status = 'cancelled';
      else if (['starting', 'in_progress'].includes(job.status)) { job.status = 'interrupted'; job.error = reason; }
    }
    await this.api.storage.session.set({ folderBatch: batch });
    return batch;
  }

  async endPanel(planId, sender) {
    const { plan, batch } = await this.owned(planId, sender);
    if (plan.surface !== 'panel') throw new Error('此操作仅适用于侧边栏下载。');
    return this.finishUnfinished(batch, '侧边栏已关闭或刷新，未完成的文件已中断，请检查目标文件夹后重试。');
  }

  async reconcilePanel() {
    const batch = await this.current();
    if (batch?.surface !== 'panel' || !isActiveBatch(batch)) return;
    const contexts = await this.api.runtime.getContexts({ documentIds: [batch.ownerDocumentId] });
    if (!contexts.some(context => context.documentId === batch.ownerDocumentId)) {
      await this.finishUnfinished(batch, '原侧边栏已关闭或刷新，未完成的文件未报告保存成功，请检查目标文件夹后重试。');
    }
  }

}

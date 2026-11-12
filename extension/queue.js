import './file-types.js';

const ACTIVE = new Set(['queued', 'starting', 'in_progress']);
const { isDownloadExtension, officeExtensions } = globalThis.BBFileTypes;

export function safeFilename(file) {
  const extension = isDownloadExtension(file.extension?.toLowerCase()) ? file.extension.toLowerCase() : '';
  let name = String(file.name || '文件').normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_')
    .replace(/^\.+/, '').replace(/[.\s]+$/, '').trim() || '文件';
  if (extension && !name.toLowerCase().endsWith(`.${extension}`)) name += `.${extension}`;
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  const suffix = extension ? name.slice(-extension.length - 1) : '';
  let stem = suffix ? name.slice(0, -suffix.length) : name;
  const encoder = new TextEncoder();
  while (encoder.encode(stem + suffix).length > 220) stem = Array.from(stem).slice(0, -1).join('');
  return `Blackboard/${stem}${suffix}`;
}

/** Event-driven queue: every state mutation is serialized and saved before launching I/O. */
export class DownloadQueue {
  constructor(adapter, concurrency = 3) {
    this.adapter = adapter;
    this.concurrency = concurrency;
    this.batch = null;
    this.serial = Promise.resolve();
  }

  snapshot() { return this.batch ? structuredClone(this.batch) : null; }
  run(action) {
    const result = this.serial.then(action);
    this.serial = result.catch(() => {});
    return result;
  }
  save() { return this.adapter.save(this.snapshot()); }

  restore() {
    return this.run(async () => {
      this.batch = await this.adapter.load() || null;
      if (!this.batch) return null;
      for (const job of this.batch.jobs) {
        if (job.status === 'starting') {
          job.status = 'interrupted';
          job.error = '后台在启动下载时中断，请先检查浏览器下载记录，确认后再重新选择下载。';
        } else if (job.status === 'in_progress') {
          await this.reconcile(job);
        }
      }
      await this.save();
      await this.pump();
      return this.snapshot();
    });
  }

  start(files) {
    return this.run(async () => {
      if (this.batch?.jobs.some(job => ACTIVE.has(job.status))) throw new Error('当前批次仍有下载任务，请等待完成或停止等待任务。');
      if (!Array.isArray(files) || !files.length) throw new Error('请先选择文件。');
      const unique = new Map();
      for (const file of files) {
        const url = new URL(file.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !isDownloadExtension(file.extension)) {
          throw new Error('文件地址或类型无效，请重新扫描页面。');
        }
        unique.set(file.id, structuredClone(file));
      }
      const id = crypto.randomUUID();
      this.batch = { id, createdAt: Date.now(), stopped: false,
        jobs: [...unique.values()].map((file, index) => ({ id: `${id}-${index}`, file, status: 'queued' })) };
      await this.save();
      await this.pump();
      return this.snapshot();
    });
  }

  stop() {
    return this.run(async () => {
      if (!this.batch) return null;
      this.batch.stopped = true;
      for (const job of this.batch.jobs) if (job.status === 'queued') job.status = 'cancelled';
      await this.save();
      return this.snapshot();
    });
  }

  async reconcile(job, delta) {
    try {
      const [item] = await this.adapter.search({ id: job.downloadId });
      const state = delta?.state?.current || item?.state;
      if (state === 'complete') {
        const mime = (item?.mime || '').split(';')[0].trim().toLowerCase();
        if (['text/html', 'application/xhtml+xml'].includes(mime)) {
          job.status = 'interrupted';
          job.error = '服务器返回了网页而非文件，可能登录已过期。请重新登录，并检查下载目录中的该文件。';
        } else if (mime === 'application/pdf' && officeExtensions.has(job.file.extension)) {
          job.status = 'interrupted';
          job.error = '服务器返回了 PDF 预览副本，未获取到原始 Office 文件。请使用课程中的原始附件下载入口，并检查下载目录中的该文件。';
        } else {
          job.status = 'complete';
          delete job.error;
        }
      } else if (state === 'interrupted') {
        job.status = 'interrupted';
        job.error = delta?.error?.current || item?.error || '下载已中断，请在浏览器下载记录中检查原因。';
      } else if (!item) {
        job.status = 'interrupted';
        job.error = '下载记录已不存在，请检查下载目录后重试。';
      }
    } catch (error) {
      // A transient API failure must not turn an active download into a false success.
      job.error = `暂时无法读取下载状态：${error.message}`;
    }
  }

  handleChanged(delta) {
    return this.run(async () => {
      const job = this.batch?.jobs.find(job => job.downloadId === delta.id && job.status === 'in_progress');
      if (!job) return this.snapshot();
      await this.reconcile(job, delta);
      await this.save();
      await this.pump();
      return this.snapshot();
    });
  }

  async pump() {
    if (!this.batch || this.batch.stopped) return;
    while (this.batch.jobs.filter(job => ['starting', 'in_progress'].includes(job.status)).length < this.concurrency) {
      const job = this.batch.jobs.find(job => job.status === 'queued');
      if (!job) break;
      job.status = 'starting';
      await this.save();
      try {
        job.downloadId = await this.adapter.download({ url: job.file.url, filename: safeFilename(job.file), conflictAction: 'uniquify', saveAs: false });
        job.status = 'in_progress';
        await this.save();
        // An onChanged event may precede resolution of download(); query actual state too.
        await this.reconcile(job);
      } catch (error) {
        job.status = 'interrupted';
        job.error = error.message || '无法启动下载。';
      }
      await this.save();
    }
  }
}

import { safeFilename } from './queue.js';

const { officeExtensions } = globalThis.BBFileTypes;
const encoder = new TextEncoder();

function numberedName(base, number) {
  const dot = base.lastIndexOf('.');
  const extension = dot > 0 ? base.slice(dot) : '';
  const suffix = `${number ? ` (${number})` : ''}${extension}`;
  const stem = Array.from(dot > 0 ? base.slice(0, dot) : base);
  while (encoder.encode(stem.join('') + suffix).length > 220) stem.pop();
  return stem.join('') + suffix;
}

/** Owns one tab-lifetime batch. No directory handles or credentials are persisted. */
export class DirectoryWriter {
  constructor({ fetch = globalThis.fetch, onProgress = async () => {}, concurrency = 3 } = {}) {
    this.fetch = fetch.bind(globalThis);
    this.onProgress = onProgress;
    this.concurrency = Math.max(1, Math.min(3, Math.floor(Number(concurrency)) || 3));
    this.running = false;
    this.notificationTail = Promise.resolve();
    this.nameTail = Promise.resolve();
  }

  async notify() {
    const snapshot = structuredClone(this.jobs);
    const meta = { stopped: this.stopped };
    const previous = this.notificationTail;
    let release;
    this.notificationTail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      await this.onProgress(snapshot, meta);
    } catch (error) {
      // Finish active writes before surfacing a failed persistence/UI callback.
      this.progressError ||= error;
      this.stopped = true;
      for (const job of this.jobs) if (job.status === 'queued') job.status = 'cancelled';
    } finally {
      release();
    }
  }

  stop() {
    if (!this.running || this.stopped) return;
    this.stopped = true;
    for (const job of this.jobs) if (job.status === 'queued') job.status = 'cancelled';
    // Synchronous cancellation also permits calls from inside onProgress itself.
    void this.notify();
  }

  async run(jobs, directory) {
    if (this.running) throw new Error('当前批次仍在写入，请等待完成。');
    if (!Array.isArray(jobs) || !directory?.getFileHandle) throw new TypeError('下载任务或目标目录无效。');
    this.running = true;
    this.jobs = structuredClone(jobs);
    this.directory = directory;
    this.reserved = new Set();
    this.stopped = false;
    this.progressError = null;
    try {
      await this.notify();
      const workers = Array.from({ length: this.concurrency }, () => this.work());
      await Promise.all(workers);
      await this.notificationTail;
      if (this.progressError) throw this.progressError;
      return structuredClone(this.jobs);
    } finally {
      this.running = false;
      this.directory = null;
    }
  }

  async reserveFile(file) {
    const previous = this.nameTail;
    let release;
    this.nameTail = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      // safeFilename always returns Blackboard/<basename>; never write a child path.
      const base = safeFilename(file).slice('Blackboard/'.length);
      if (!base || /[\\/]/.test(base)) throw new Error('文件名无效。');
      for (let number = 0; ; number++) {
        const name = numberedName(base, number);
        const key = name.normalize('NFC').toLowerCase();
        if (this.reserved.has(key)) continue;
        try {
          await this.directory.getFileHandle(name);
          continue;
        } catch (error) {
          // A same-name directory is also a collision; permission errors are not.
          if (error.name === 'TypeMismatchError') continue;
          if (error.name !== 'NotFoundError') throw error;
        }
        this.reserved.add(key);
        const handle = await this.directory.getFileHandle(name, { create: true });
        return { handle, name };
      }
    } finally {
      release();
    }
  }

  async work() {
    while (!this.stopped) {
      const job = this.jobs.find(candidate => candidate.status === 'queued');
      if (!job) return;
      job.status = 'starting';
      await this.notify();
      if (this.stopped) {
        job.status = 'cancelled';
        await this.notify();
        return;
      }
      let response;
      let reader;
      let writable;
      try {
        const url = new URL(job.file.url);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('文件地址无效。');
        response = await this.fetch(job.file.url, { credentials: 'include' });
        if (!response.ok) throw new Error(`服务器返回 HTTP ${response.status}，未保存文件。`);
        const mime = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const office = officeExtensions.has(job.file.extension?.toLowerCase());
        if (['text/html', 'application/xhtml+xml'].includes(mime)) throw new Error('服务器返回登录网页，未保存文件。请重新登录后重试。');
        if (office && mime === 'application/pdf') throw new Error('服务器返回 PDF 预览，未获取原始 Office 文件。');

        reader = response.body?.getReader();
        // Sniff a bounded prefix before creating a file, retaining original chunks.
        const prefix = new Uint8Array(512);
        let length = 0;
        const buffered = [];
        if (reader) {
          while (length < prefix.length) {
            const { value, done } = await reader.read();
            if (done) break;
            buffered.push(value);
            const count = Math.min(value.byteLength, prefix.length - length);
            prefix.set(value.subarray(0, count), length);
            length += count;
          }
        }
        const heading = new TextDecoder().decode(prefix.subarray(0, length)).replace(/^\uFEFF/, '').trimStart();
        if (/^<(?:!doctype\s+html|html\b|head\b|body\b)/i.test(heading)) throw new Error('服务器返回 HTML 网页，未保存文件。请检查登录状态。');
        if (office && heading.startsWith('%PDF-')) throw new Error('服务器返回 PDF 预览，未获取原始 Office 文件。');

        const { handle, name } = await this.reserveFile(job.file);
        writable = await handle.createWritable();
        job.status = 'in_progress';
        await this.notify();
        for (const chunk of buffered) await writable.write(chunk);
        if (reader) {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            await writable.write(value);
          }
        }
        await writable.close();
        writable = null;
        job.savedName = name;
        job.status = 'complete';
        delete job.error;
      } catch (error) {
        if (writable) {
          try { await writable.abort(); } catch { /* Preserve the original failure. */ }
        }
        try {
          if (reader) await reader.cancel();
          else if (response?.body) await response.body.cancel();
        } catch { /* The stream may already be errored or closed. */ }
        job.status = 'interrupted';
        job.error = error.message || '文件写入失败。';
        delete job.savedName;
      } finally {
        reader?.releaseLock();
      }
      await this.notify();
    }
  }
}

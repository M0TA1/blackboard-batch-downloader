import test from 'node:test';
import assert from 'node:assert/strict';

const { DirectoryWriter } = await import('../extension/directory-writer.js').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const encoder = new TextEncoder();
const pause = () => new Promise(resolve => setImmediate(resolve));
function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function jobs(names) {
  return names.map((name, index) => ({ id: `job-${index}`, status: 'queued', file: {
    id: `file-${index}`, url: `https://school.example/attachment/${index}?sig=a%2Fb&token=keep`,
    name, extension: name.split('.').pop().toLowerCase(), source: '课程'
  } }));
}
function writer(options) {
  assert.equal(typeof DirectoryWriter, 'function', 'DirectoryWriter must be implemented');
  return new DirectoryWriter(options);
}

class MemoryDirectory {
  constructor(existing = {}) {
    this.files = new Map(Object.entries(existing).map(([name, content]) => [name, encoder.encode(content)]));
    this.created = [];
    this.aborted = [];
    this.writes = [];
    this.failWrite = new Set();
    this.closeGate = null;
  }
  async getFileHandle(name, { create = false } = {}) {
    assert.ok(!name.includes('/') && !name.includes('\\'), 'only basenames may be written');
    if (!this.files.has(name)) {
      if (!create) throw new DOMException('not found', 'NotFoundError');
      this.files.set(name, new Uint8Array());
      this.created.push(name);
    }
    return { createWritable: async () => {
      const chunks = [];
      return {
        write: async chunk => {
          if (this.failWrite.has(name)) throw new Error('disk write failed');
          this.writes.push({ name, chunk });
          chunks.push(Uint8Array.from(chunk));
        },
        close: async () => {
          if (this.closeGate) await this.closeGate.promise;
          const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
          const bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          this.files.set(name, bytes);
        },
        abort: async () => { this.aborted.push(name); }
      };
    } };
  }
  read(name) { return new TextDecoder().decode(this.files.get(name)); }
}

test('writes a three-file batch into the same chosen directory with credentialed signed URLs', async () => {
  const directory = new MemoryDirectory();
  const input = jobs(['课件.pdf', '讲义.docx', '数据.csv']);
  const calls = [];
  const output = await writer({ fetch: async (url, options) => {
    calls.push([url, options.credentials]);
    return new Response(`contents:${url}`, { headers: { 'Content-Type': 'application/octet-stream' } });
  } }).run(input, directory);
  assert.deepEqual(output.map(job => job.id), ['job-0', 'job-1', 'job-2']);
  assert.deepEqual(output.map(job => job.status), ['complete', 'complete', 'complete']);
  assert.deepEqual(output.map(job => job.savedName), ['课件.pdf', '讲义.docx', '数据.csv']);
  assert.deepEqual(calls, input.map(job => [job.file.url, 'include']));
  assert.equal(directory.read('课件.pdf'), 'contents:https://school.example/attachment/0?sig=a%2Fb&token=keep');
  assert.equal(input[0].status, 'queued', 'caller-owned jobs remain unchanged');
});

test('calls a browser-style fetch with the global receiver rather than the writer instance', async () => {
  const directory = new MemoryDirectory();
  const output = await writer({ fetch: async function (url, options) {
    assert.equal(this, globalThis, 'Window.fetch requires its global receiver');
    assert.equal(options.credentials, 'include');
    return new Response(`received:${url}`);
  } }).run(jobs(['browser.pdf']), directory);
  assert.equal(output[0].status, 'complete', output[0].error);
  assert.equal(directory.read('browser.pdf'), 'received:https://school.example/attachment/0?sig=a%2Fb&token=keep');
});

test('preserves existing files and gives concurrent duplicate Chinese filenames unique suffixes', async () => {
  const directory = new MemoryDirectory({ '课件.pdf': 'old', '课件 (1).pdf': 'older' });
  const output = await writer({ fetch: async () => new Response('new') }).run(jobs(['课件.pdf', '课件.pdf', '课件.pdf']), directory);
  assert.deepEqual(output.map(job => job.savedName).sort(), ['课件 (2).pdf', '课件 (3).pdf', '课件 (4).pdf']);
  assert.equal(directory.read('课件.pdf'), 'old');
  assert.equal(directory.read('课件 (1).pdf'), 'older');
  assert.equal(directory.created.length, 3);
});

test('sanitizes path characters and limits numbered Unicode filenames in UTF-8 bytes', async () => {
  const directory = new MemoryDirectory();
  const name = `${'课'.repeat(100)}.pdf`;
  const output = await writer({ fetch: async () => new Response('ok') }).run(jobs([name, name, '../evil\\name.pdf']), directory);
  assert.ok(output.every(job => job.status === 'complete'));
  assert.ok(output.every(job => encoder.encode(job.savedName).length <= 220));
  assert.ok(output.every(job => !/[\\/]/.test(job.savedName)));
  assert.equal(new Set(output.map(job => job.savedName)).size, 3);
});

test('rejects HTML login pages and converted Office PDFs before creating a file', async () => {
  const directory = new MemoryDirectory();
  const input = jobs(['html.pdf', 'mime.docx', 'sniff.pptx', 'sniff-login.xlsx']);
  const responses = [
    new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    new Response('%PDF-converted', { headers: { 'Content-Type': 'application/pdf' } }),
    new Response('%PDF-converted', { headers: { 'Content-Type': 'application/octet-stream' } }),
    new Response(new ReadableStream({ start(controller) {
      for (const chunk of ['  <!DOC', 'TYPE html><html>Login</html>']) controller.enqueue(encoder.encode(chunk));
      controller.close();
    } }))
  ];
  const output = await writer({ fetch: async () => responses.shift() }).run(input, directory);
  assert.ok(output.every(job => job.status === 'interrupted' && job.error));
  assert.deepEqual(directory.created, []);
});

test('HTTP, fetch and writable failures interrupt their jobs and allow later jobs to finish', async () => {
  const directory = new MemoryDirectory();
  directory.failWrite.add('write.pdf');
  const input = jobs(['http.pdf', 'fetch.pdf', 'write.pdf', 'good.pdf']);
  const output = await writer({ fetch: async url => {
    const index = Number(new URL(url).pathname.split('/').pop());
    if (index === 0) return new Response('error', { status: 403 });
    if (index === 1) throw new Error('network unavailable');
    return new Response('good');
  } }).run(input, directory);
  assert.deepEqual(output.map(job => job.status), ['interrupted', 'interrupted', 'interrupted', 'complete']);
  assert.ok(output.slice(0, 3).every(job => typeof job.error === 'string'));
  assert.deepEqual(directory.aborted, ['write.pdf']);
  assert.equal(directory.read('good.pdf'), 'good');
});

test('streams chunks before the response finishes and waits for close before reporting complete', async () => {
  const directory = new MemoryDirectory();
  directory.closeGate = gate();
  let stream;
  const snapshots = [];
  const runner = writer({ fetch: async () => new Response(new ReadableStream({ start(controller) { stream = controller; } })),
    onProgress: async state => { snapshots.push(state); } });
  const pending = runner.run(jobs(['stream.pdf']), directory);
  while (!stream) await pause();
  stream.enqueue(encoder.encode('a'.repeat(2048)));
  while (!directory.writes.length) await pause();
  assert.equal(directory.writes[0].chunk.byteLength, 2048);
  stream.enqueue(encoder.encode('end'));
  stream.close();
  await pause();
  assert.ok(!snapshots.some(state => state[0].status === 'complete'));
  directory.closeGate.resolve();
  assert.equal((await pending)[0].status, 'complete');
  assert.equal(directory.read('stream.pdf'), `${'a'.repeat(2048)}end`);
});

test('caps concurrency at three and stop cancels only jobs that have not started', async () => {
  const directory = new MemoryDirectory();
  const release = gate();
  let active = 0;
  let peak = 0;
  let fetched = 0;
  const runner = writer({ concurrency: 99, fetch: async () => {
    fetched++;
    active++;
    peak = Math.max(active, peak);
    await release.promise;
    active--;
    return new Response('ok');
  } });
  const pending = runner.run(jobs(['1.pdf', '2.pdf', '3.pdf', '4.pdf', '5.pdf']), directory);
  while (fetched < 3) await pause();
  await runner.stop();
  release.resolve();
  const output = await pending;
  assert.equal(peak, 3);
  assert.equal(fetched, 3);
  assert.deepEqual(output.map(job => job.status), ['complete', 'complete', 'complete', 'cancelled', 'cancelled']);
});

test('serializes asynchronous progress notifications and emits independent snapshots', async () => {
  const directory = new MemoryDirectory();
  let callbacks = 0;
  let peak = 0;
  const persisted = [];
  const runner = writer({ fetch: async () => new Response('ok'), onProgress: async (snapshot, meta) => {
    callbacks++;
    peak = Math.max(peak, callbacks);
    await pause();
    persisted.push({ snapshot, meta });
    callbacks--;
  } });
  await runner.run(jobs(['1.pdf', '2.pdf', '3.pdf']), directory);
  assert.equal(peak, 1);
  assert.ok(persisted[0].snapshot.every(job => job.status === 'queued'));
  assert.ok(persisted.at(-1).snapshot.every(job => job.status === 'complete'));
  assert.deepEqual(persisted.at(-1).meta, { stopped: false });
});

test('stop during the starting notification prevents requests that have not begun and is idempotent', async () => {
  const directory = new MemoryDirectory();
  let fetched = 0;
  let runner;
  runner = writer({ fetch: async () => { fetched++; return new Response('ok'); }, onProgress: async snapshot => {
    if (snapshot.some(job => job.status === 'starting')) {
      void runner.stop();
      void runner.stop();
    }
  } });
  const output = await runner.run(jobs(['1.pdf', '2.pdf', '3.pdf', '4.pdf']), directory);
  assert.equal(fetched, 0);
  assert.ok(output.every(job => job.status === 'cancelled'));
});

test('a failed progress callback stops pending work, finishes active writes and rejects run visibly', async () => {
  const directory = new MemoryDirectory();
  const runner = writer({ concurrency: 1, fetch: async () => new Response('saved'), onProgress: async snapshot => {
    if (snapshot.some(job => job.status === 'in_progress')) throw new Error('progress persistence failed');
  } });
  await assert.rejects(runner.run(jobs(['active.pdf', 'pending.pdf']), directory), /progress persistence failed/);
  assert.equal(directory.read('active.pdf'), 'saved');
  assert.equal(directory.files.has('pending.pdf'), false);
});

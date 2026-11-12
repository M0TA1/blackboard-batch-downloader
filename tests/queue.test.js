import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DownloadQueue, safeFilename } from '../extension/queue.js';

const file = (id) => ({ id: String(id), name: `讲义 ${id}.pdf`, extension: 'pdf', url: `https://school.example/files/${id}.pdf`, source: 'Week 1' });
function setup(saved = null, downloadImpl) {
  let store = structuredClone(saved);
  let id = 10;
  const records = new Map();
  const calls = [];
  const adapter = {
    load: async () => structuredClone(store),
    save: async (value) => { store = structuredClone(value); },
    download: async (options) => {
      calls.push(options);
      if (downloadImpl) return downloadImpl(options, records, ++id);
      records.set(++id, { id, state: 'in_progress', mime: 'application/pdf' });
      return id;
    },
    search: async ({ id }) => records.has(id) ? [records.get(id)] : [],
  };
  return { queue: new DownloadQueue(adapter), records, calls, saved: () => store, adapter };
}

test('filenames cannot escape Blackboard directory and preserve Chinese extension', () => {
  assert.equal(safeFilename({ name: '../../课程:一?.PDF', extension: 'pdf' }), 'Blackboard/_.._课程_一_.PDF');
  assert.equal(safeFilename({ name: 'CON', extension: 'xlsx' }), 'Blackboard/_CON.xlsx');
  assert.ok(new TextEncoder().encode(safeFilename({ name: '课'.repeat(200), extension: 'docx' }).split('/')[1]).length <= 220);
});

test('starts at most three downloads and advances after completion', async () => {
  const { queue, records, calls } = setup();
  await queue.restore();
  await queue.start([1, 2, 3, 4, 5].map(file));
  assert.equal(calls.length, 3);
  assert.deepEqual(queue.snapshot().jobs.map(j => j.status), ['in_progress', 'in_progress', 'in_progress', 'queued', 'queued']);
  records.set(11, { id: 11, state: 'complete', mime: 'application/pdf' });
  await queue.handleChanged({ id: 11, state: { current: 'complete' } });
  assert.equal(calls.length, 4);
  assert.equal(queue.snapshot().jobs[0].status, 'complete');
  assert.equal(calls[0].conflictAction, 'uniquify');
  assert.equal(calls[0].saveAs, false);
});

test('stopping cancels waiting files and leaves active downloads with browser', async () => {
  const { queue, calls } = setup();
  await queue.restore();
  await queue.start([1, 2, 3, 4, 5].map(file));
  await queue.stop();
  await queue.handleChanged({ id: 11, state: { current: 'complete' } });
  assert.equal(calls.length, 3);
  assert.deepEqual(queue.snapshot().jobs.slice(3).map(j => j.status), ['cancelled', 'cancelled']);
});

test('cannot replace an active batch or launch non-http URLs', async () => {
  const { queue } = setup();
  await queue.restore();
  await assert.rejects(queue.start([{ ...file(1), url: 'javascript:alert(1)' }]));
  await queue.start([file(1)]);
  await assert.rejects(queue.start([file(2)]));
  assert.equal(queue.snapshot().jobs[0].file.id, '1');
});

test('a start failure does not prevent later downloads and duplicate events do not double launch', async () => {
  const { queue, calls } = setup(null, async (options, records, id) => {
    if (options.url.endsWith('/1.pdf')) throw new Error('NETWORK_FAILED');
    records.set(id, { id, state: 'in_progress', mime: 'application/pdf' });
    return id;
  });
  await queue.restore();
  await queue.start([1, 2, 3, 4].map(file));
  assert.equal(calls.length, 4);
  assert.equal(queue.snapshot().jobs[0].status, 'interrupted');
  await Promise.all([queue.handleChanged({ id: 12, state: { current: 'complete' } }), queue.handleChanged({ id: 12, state: { current: 'complete' } })]);
  assert.equal(calls.length, 4);
});

test('fast completion is reconciled and HTML login responses are reported as failed', async () => {
  const { queue } = setup(null, async (_options, records, id) => {
    records.set(id, { id, state: 'complete', mime: 'text/html', finalUrl: 'https://school.example/login' });
    return id;
  });
  await queue.restore();
  await queue.start([file(1)]);
  assert.equal(queue.snapshot().jobs[0].status, 'interrupted');
  assert.match(queue.snapshot().jobs[0].error, /登录|网页/);
});

test('worker restart reconciles stored active downloads and resumes waiting files', async () => {
  const old = setup();
  await old.queue.restore();
  await old.queue.start([1, 2, 3, 4].map(file));
  old.records.set(11, { id: 11, state: 'complete', mime: 'application/pdf' });
  const restarted = new DownloadQueue(old.adapter);
  await restarted.restore();
  assert.equal(restarted.snapshot().jobs[0].status, 'complete');
  assert.equal(restarted.snapshot().jobs[3].status, 'in_progress');
  assert.equal(old.calls.length, 4);
});

test('an interrupted launch is not retried automatically after restart', async () => {
  const { queue, calls } = setup({ id: 'batch', jobs: [{ id: 'job', file: file(1), status: 'starting' }], stopped: false });
  await queue.restore();
  assert.equal(queue.snapshot().jobs[0].status, 'interrupted');
  assert.equal(calls.length, 0);
});

test('converted PDF response cannot be reported as a successful Office original', async () => {
  const { queue } = setup(null, async (_options, records, id) => {
    records.set(id, { id, state: 'complete', mime: 'application/pdf' });
    return id;
  });
  await queue.restore();
  await queue.start([{ ...file(1), name: '讲义.pptx', extension: 'pptx' }]);
  assert.equal(queue.snapshot().jobs[0].status, 'interrupted');
  assert.match(queue.snapshot().jobs[0].error, /预览|PDF/);
});

test('other attachments can download without changing original extension or signed URL', async () => {
  const { queue, calls } = setup(null, async (_options, records, id) => {
    records.set(id, { id, state: 'complete', mime: 'application/octet-stream' });
    return id;
  });
  await queue.restore();
  await queue.start(['wav', 'txt', 'zip', 'coursemodel'].map(extension => ({
    id: extension, name: `实验.${extension}`, extension, url: `https://school.example/attachment/${extension}?sig=a%2Fb`, source: '作业附件',
  })));
  assert.equal(calls.length, 4);
  assert.equal(calls[0].filename, 'Blackboard/实验.wav');
  assert.equal(calls[1].filename, 'Blackboard/实验.txt');
  assert.equal(calls[3].filename, 'Blackboard/实验.coursemodel');
  assert.equal(calls[0].url, 'https://school.example/attachment/wav?sig=a%2Fb');
  assert.ok(queue.snapshot().jobs.every(job => job.status === 'complete'));
});

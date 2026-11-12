import test from 'node:test';
import assert from 'node:assert/strict';
import { FolderSession } from '../extension/folder-session.js';

const file = { id: 'pdf', name: '课程.pdf', extension: 'pdf', url: 'https://school.example/a.pdf?sig=keep', source: '课程' };
const second = { ...file, id: 'txt', name: 'input.txt', extension: 'txt', url: 'https://school.example/input.txt' };
function setup() {
  const state = {};
  const api = {
    runtime: { getURL: path => `chrome-extension://test/${path}` },
    storage: { session: { get: async key => ({ [key]: structuredClone(state[key]) }), set: async data => Object.assign(state, structuredClone(data)) } },
    tabs: { create: async () => ({ id: 123 }) },
  };
  const session = new FolderSession(api);
  const sender = id => ({ tab: { id: 123 }, url: `chrome-extension://test/downloader.html#${id}` });
  return { session, state, sender };
}

test('folder plan keeps selected signed URLs and belongs to one download tab', async () => {
  const { session, sender } = setup();
  const result = await session.prepare([file, second], { sourceTabId: 1, pageUrl: 'https://school.example/course', title: '课程' });
  assert.equal(result.tabId, 123);
  const current = await session.get(result.planId, sender(result.planId));
  assert.equal(current.plan.files[0].url, file.url);
  assert.equal(current.batch.mode, 'folder');
  assert.deepEqual(current.batch.jobs.map(job => job.status), ['queued', 'queued']);
  await assert.rejects(session.get(result.planId, { ...sender(result.planId), tab: { id: 999 } }));
});

test('progress cannot introduce files or move a completed job backwards', async () => {
  const { session, sender } = setup();
  const { planId, batch } = await session.prepare([file], {});
  await assert.rejects(session.update({ planId, jobs: [{ id: 'invented', status: 'complete' }] }, sender(planId)));
  await session.update({ planId, jobs: [{ id: batch.jobs[0].id, status: 'in_progress' }], folderName: '课程资料' }, sender(planId));
  const done = await session.update({ planId, jobs: [{ id: batch.jobs[0].id, status: 'complete', savedName: '课程.pdf' }], folderName: '课程资料' }, sender(planId));
  assert.equal(done.jobs[0].file.url, file.url);
  assert.equal(done.jobs[0].status, 'complete');
  await assert.rejects(session.update({ planId, jobs: [{ id: batch.jobs[0].id, status: 'in_progress' }] }, sender(planId)));
});

test('stop cancels waiting jobs and preserves an already writing job', async () => {
  const { session, sender } = setup();
  const { planId, batch } = await session.prepare([file, second], {});
  await session.update({ planId, jobs: batch.jobs.map((job, index) => ({ id: job.id, status: index ? 'queued' : 'in_progress' })) }, sender(planId));
  const stopped = await session.stop();
  assert.equal(stopped.stopped, true);
  assert.deepEqual(stopped.jobs.map(job => job.status), ['in_progress', 'cancelled']);
  const updated = await session.update({ planId, jobs: batch.jobs.map((job, index) => ({ id: job.id, status: index ? 'queued' : 'complete' })) }, sender(planId));
  assert.deepEqual(updated.jobs.map(job => job.status), ['complete', 'cancelled']);
});

test('closing the owning tab marks unfinished files interrupted or cancelled', async () => {
  const { session, sender } = setup();
  const { planId, batch } = await session.prepare([file, second], {});
  await session.update({ planId, jobs: batch.jobs.map((job, index) => ({ id: job.id, status: index ? 'queued' : 'in_progress' })) }, sender(planId));
  await session.closeTab(999);
  assert.equal((await session.current()).stopped, false);
  await session.closeTab(123);
  assert.deepEqual((await session.current()).jobs.map(job => job.status), ['interrupted', 'cancelled']);
});

test('a refreshed download tab cannot leave lost file handles running forever', async () => {
  const { session, sender } = setup();
  const { planId, batch } = await session.prepare([file], {});
  await session.get(planId, sender(planId));
  await session.update({ planId, jobs: [{ id: batch.jobs[0].id, status: 'in_progress' }] }, sender(planId));
  const reloaded = await session.get(planId, sender(planId));
  assert.equal(reloaded.batch.stopped, true);
  assert.equal(reloaded.batch.jobs[0].status, 'interrupted');
});

test('an active folder batch cannot be replaced or populated with invalid URLs', async () => {
  const { session } = setup();
  await assert.rejects(session.prepare([{ ...file, url: 'javascript:alert(1)' }], {}));
  await session.prepare([file], {});
  await assert.rejects(session.prepare([second], {}));
});

test('navigation cancels a claimed download page without mistaking its first load for leaving', async () => {
  const { session, sender } = setup();
  const { planId, batch } = await session.prepare([file, second], {});
  await session.navigateTab(123);
  assert.equal((await session.current()).stopped, false);
  await session.get(planId, sender(planId));
  await session.update({ planId, jobs: batch.jobs.map((job, index) => ({ id: job.id, status: index ? 'queued' : 'in_progress' })) }, sender(planId));
  await session.navigateTab(123);
  assert.deepEqual((await session.current()).jobs.map(job => job.status), ['interrupted', 'cancelled']);
  assert.equal((await session.current()).stopped, true);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { FolderSession } from '../extension/folder-session.js';

const file = { id: 'pdf', name: '课程.pdf', extension: 'pdf', url: 'https://school.example/a.pdf?sig=keep', source: '课程' };
const second = { ...file, id: 'txt', name: 'input.txt', extension: 'txt', url: 'https://school.example/input.txt' };
function setup() {
  const state = {};
  const contexts = new Set(['panel-a']);
  const api = {
    runtime: { getURL: path => `chrome-extension://test/${path}`, getContexts: async ({ documentIds }) => documentIds.filter(id => contexts.has(id)).map(documentId => ({ documentId })) },
    storage: { session: { get: async key => ({ [key]: structuredClone(state[key]) }), set: async data => Object.assign(state, structuredClone(data)) } },
  };
  const session = new FolderSession(api);
  const panel = documentId => ({ documentId, url: 'chrome-extension://test/sidepanel.html' });
  return { session, state, panel, contexts };
}

test('legacy standalone state is discarded so upgrades cannot block panel downloads', async () => {
  const { session, state, panel } = setup();
  state.folderPlan = { id: 'legacy', tabId: 123 };
  state.folderBatch = { id: 'legacy', mode: 'folder', tabId: 123, jobs: [{ id: 'legacy-0', file, status: 'in_progress' }] };
  assert.equal(await session.current(), null);
  assert.equal(state.folderBatch, null);
  assert.equal(state.folderPlan, null);
  assert.equal((await session.preparePanel([file], {}, panel('panel-a'))).batch.surface, 'panel');
});

test('panel plans retain signed URLs and bind progress to their document', async () => {
  const { session, panel } = setup();
  const { plan, batch } = await session.preparePanel([file, second], { sourceTabId: 7 }, panel('panel-a'));
  assert.equal(plan.surface, 'panel');
  assert.equal(plan.files[0].url, file.url);
  assert.equal(batch.ownerDocumentId, 'panel-a');
  assert.equal(batch.tabId, undefined);
  await assert.rejects(session.update({ planId: plan.id, jobs: batch.jobs }, panel('panel-b')));
  assert.deepEqual((await session.current()).jobs.map(job => job.status), ['queued', 'queued']);
});

test('progress rejects unknown jobs, invalid states and backwards or changed terminal states', async () => {
  const { session, panel } = setup();
  const { plan, batch } = await session.preparePanel([file], {}, panel('panel-a'));
  const update = status => session.update({ planId: plan.id, jobs: [{ id: batch.jobs[0].id, status }] }, panel('panel-a'));
  await assert.rejects(session.update({ planId: plan.id, jobs: [{ id: 'invented', status: 'complete' }] }, panel('panel-a')));
  await assert.rejects(update('toString'));
  await update('in_progress');
  await assert.rejects(update('queued'));
  const done = await session.update({ planId: plan.id, jobs: [{ id: batch.jobs[0].id, status: 'complete', savedName: '课程.pdf' }], folderName: '课程资料' }, panel('panel-a'));
  assert.equal(done.jobs[0].file.url, file.url);
  assert.equal(done.jobs[0].savedName, '课程.pdf');
  await assert.rejects(update('in_progress'));
  await assert.rejects(update('interrupted'));
});

test('stop preserves active writes and absorbs older queued snapshots for cancelled jobs', async () => {
  const { session, panel } = setup();
  const { plan, batch } = await session.preparePanel([file, second], {}, panel('panel-a'));
  const updates = first => batch.jobs.map((job, index) => ({ id: job.id, status: index ? 'queued' : first }));
  await session.update({ planId: plan.id, jobs: updates('in_progress') }, panel('panel-a'));
  const stopped = await session.stop();
  assert.equal(stopped.stopped, true);
  assert.deepEqual(stopped.jobs.map(job => job.status), ['in_progress', 'cancelled']);
  const updated = await session.update({ planId: plan.id, jobs: updates('complete') }, panel('panel-a'));
  assert.deepEqual(updated.jobs.map(job => job.status), ['complete', 'cancelled']);
});

test('active panel batches cannot be replaced and invalid addresses cannot create a plan', async () => {
  const { session, panel } = setup();
  await assert.rejects(session.preparePanel([{ ...file, url: 'javascript:alert(1)' }], {}, panel('panel-a')));
  await session.preparePanel([file], {}, panel('panel-a'));
  await assert.rejects(session.preparePanel([second], {}, panel('panel-a')));
});

test('a missing panel document interrupts active jobs, cancels pending jobs and releases the next batch', async () => {
  const { session, panel, contexts } = setup();
  const { plan, batch } = await session.preparePanel([file, second], {}, panel('panel-a'));
  await session.update({ planId: plan.id, jobs: batch.jobs.map((job, index) => ({ id: job.id, status: index ? 'queued' : 'in_progress' })) }, panel('panel-a'));
  contexts.delete('panel-a');
  await session.reconcilePanel();
  assert.deepEqual((await session.current()).jobs.map(job => job.status), ['interrupted', 'cancelled']);
  contexts.add('panel-b');
  assert.equal((await session.preparePanel([second], {}, panel('panel-b'))).batch.ownerDocumentId, 'panel-b');
});

test('only the owning panel can explicitly end its batch', async () => {
  const { session, panel } = setup();
  const { plan } = await session.preparePanel([file], {}, panel('panel-a'));
  await assert.rejects(session.endPanel(plan.id, panel('panel-b')));
  assert.equal((await session.current()).stopped, false);
  await session.endPanel(plan.id, panel('panel-a'));
  assert.equal((await session.current()).jobs[0].status, 'cancelled');
});

test('native panel senders without documentId resolve only through one live SIDE_PANEL instance URL', async () => {
  const base = 'chrome-extension://test/sidepanel.html';
  const panelUrl = `${base}#11111111-1111-4111-8111-111111111111`;
  const context = { contextType: 'SIDE_PANEL', documentUrl: panelUrl, documentId: 'actual-browser-id' };
  let contexts = [context];
  const session = new FolderSession({ runtime: { getURL: () => base, getContexts: async filter => {
    assert.deepEqual(filter, { contextTypes: ['SIDE_PANEL'], documentUrls: [panelUrl] });
    return contexts;
  } } });
  const sender = { id: 'test', url: base };
  assert.equal((await session.resolvePanelSender(sender, panelUrl)).documentId, 'actual-browser-id');
  for (const invalid of [base, `${base}?other=1#11111111-1111-4111-8111-111111111111`, 'https://evil.example/sidepanel.html#11111111-1111-4111-8111-111111111111']) {
    await assert.rejects(session.resolvePanelSender(sender, invalid));
  }
  await assert.rejects(session.resolvePanelSender({ ...sender, documentId: 'forged' }, panelUrl));
  contexts = [context, { ...context, documentId: 'ambiguous' }];
  await assert.rejects(session.resolvePanelSender(sender, panelUrl));
  contexts = [{ ...context, contextType: 'TAB' }];
  await assert.rejects(session.resolvePanelSender(sender, panelUrl));
  contexts = [];
  await assert.rejects(session.resolvePanelSender(sender, panelUrl));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler, installBackground } from '../extension/background.js';

const file = { id: 'f1', url: 'https://school.example/notes.pdf?token=abc', name: '课程.pdf', extension: 'pdf', source: '课程页' };
const sender = { id: 'our-extension', url: 'chrome-extension://our-extension/sidepanel.html' };
const panelUrl = `${sender.url}#11111111-1111-4111-8111-111111111111`;
function setup() {
  const state = {};
  let url = 'https://school.example/course';
  let contexts = [{ documentId: 'panel-a', contextType: 'SIDE_PANEL', documentUrl: panelUrl }];
  const api = {
    runtime: {
      id: sender.id, getURL: path => `chrome-extension://our-extension/${path}`,
      getContexts: async ({ documentIds, documentUrls } = {}) => contexts.filter(context =>
        (!documentIds || documentIds.includes(context.documentId)) && (!documentUrls || documentUrls.includes(context.documentUrl))),
    },
    storage: { session: { get: async key => ({ [key]: structuredClone(state[key]) }), set: async values => Object.assign(state, structuredClone(values)) } },
    tabs: { get: async id => ({ id, url, title: '课程内容' }) },
    scripting: { executeScript: async () => [{ result: { files: [file], pageUrl: url, title: '课程内容', warnings: [], scannedAt: 1 } }] },
  };
  const handle = createMessageHandler(api);
  const send = (message, from = sender) => handle({ ...message, panelUrl }, from);
  const prepare = (values = {}) => send({ type: 'PREPARE_PANEL_DOWNLOAD', fileIds: ['f1'], sourceTabId: 12, scanTimestamp: 1, ...values });
  return { api, send, prepare, state, navigate: value => { url = value; }, closePanel: () => { contexts = []; } };
}

test('scan and panel preparation preserve selected IDs, signed URLs and browser-owned identity', async () => {
  const { send, prepare, state } = setup();
  assert.equal((await send({ type: 'SCAN_PAGE', tabId: 12 })).ok, true);
  const result = await prepare();
  assert.equal(result.ok, true);
  assert.equal(result.plan.surface, 'panel');
  assert.equal(result.plan.files[0].url, file.url);
  assert.equal(state.folderBatch.tabId, undefined);
  assert.equal((await send({ type: 'GET_STATE' })).documentId, 'panel-a');
  assert.equal((await send({ type: 'END_PANEL_DOWNLOAD', planId: result.plan.id }, { ...sender, documentId: 'panel-b' })).ok, false);
  assert.equal((await send({ type: 'END_PANEL_DOWNLOAD', planId: result.plan.id })).batch.jobs[0].status, 'cancelled');
});

test('removed native and standalone download messages are unsupported', async () => {
  const { send, state } = setup();
  await send({ type: 'SCAN_PAGE', tabId: 12 });
  for (const type of ['START_DOWNLOADS', 'PREPARE_FOLDER_DOWNLOAD', 'GET_FOLDER_PLAN']) {
    const result = await send({ type, fileIds: ['f1'] });
    assert.equal(result.ok, false, `${type} must not start an old download flow`);
    assert.match(result.error, /不支持此操作/);
  }
  assert.equal(state.folderBatch, undefined);
});

test('panel preparation cannot add unscanned URLs or accept changed or missing source identity', async () => {
  const { send, prepare, state } = setup();
  await send({ type: 'SCAN_PAGE', tabId: 12 });
  for (const change of [{ fileIds: ['unknown'], url: 'https://evil.example' }, { sourceTabId: 13 }, { scanTimestamp: 2 }, { sourceTabId: undefined }, { scanTimestamp: undefined }]) {
    assert.equal((await prepare(change)).ok, false);
  }
  state.scan.scannedAt = 2;
  assert.equal((await prepare()).ok, false);
  assert.equal(state.folderBatch, undefined);
});

test('source navigation blocks new preparations but does not cancel an existing panel writer', async () => {
  const { send, prepare, navigate, state } = setup();
  await send({ type: 'SCAN_PAGE', tabId: 12 });
  const result = await prepare();
  navigate('https://school.example/next');
  const jobs = result.batch.jobs.map(job => ({ id: job.id, status: 'in_progress' }));
  assert.equal((await send({ type: 'FOLDER_PROGRESS', planId: result.plan.id, jobs })).ok, true);
  assert.equal((await send({ type: 'GET_STATE' })).batch.jobs[0].status, 'in_progress');
  await send({ type: 'END_PANEL_DOWNLOAD', planId: result.plan.id });
  assert.equal((await prepare()).ok, false);
  assert.equal(state.folderBatch.jobs[0].status, 'interrupted');
});

test('restricted pages, outside senders and missing panel contexts are rejected', async () => {
  const { send, navigate, closePanel } = setup();
  navigate('chrome://extensions');
  assert.equal((await send({ type: 'SCAN_PAGE', tabId: 12 })).ok, false);
  assert.equal((await send({ type: 'GET_STATE' }, { id: 'different' })).ok, false);
  assert.equal((await send({ type: 'GET_STATE' }, { ...sender, url: 'https://school.example/course' })).ok, false);
  closePanel();
  assert.equal((await send({ type: 'GET_STATE' })).ok, false);
});

test('concurrent preparations create only one batch and stop cancels its pending jobs', async () => {
  const { send, prepare } = setup();
  await send({ type: 'SCAN_PAGE', tabId: 12 });
  const results = await Promise.all([prepare(), prepare()]);
  assert.deepEqual(results.map(result => result.ok), [true, false]);
  const stopped = await send({ type: 'STOP_DOWNLOADS' });
  assert.equal(stopped.batch.jobs[0].status, 'cancelled');
  assert.equal((await prepare()).ok, true);
});

test('state ignores native legacy jobs and discards standalone legacy plans', async () => {
  const { send, prepare, state } = setup();
  state.batch = { id: 'native', jobs: [{ status: 'queued' }] };
  state.folderPlan = { id: 'standalone', tabId: 99 };
  state.folderBatch = { id: 'standalone', jobs: [{ status: 'in_progress' }] };
  assert.equal((await send({ type: 'GET_STATE' })).batch, null);
  assert.equal(state.folderPlan, null);
  assert.equal(state.folderBatch, null);
  await send({ type: 'SCAN_PAGE', tabId: 12 });
  assert.equal((await prepare()).ok, true);
});

test('outdated scan-policy caches are invalidated without disturbing an active panel batch', async () => {
  const { send, prepare, state } = setup();
  await send({ type: 'SCAN_PAGE', tabId: 12 });
  const fresh = structuredClone(state.scan);
  const started = await prepare();
  delete state.scan.scanPolicyVersion;
  assert.equal((await send({ type: 'GET_STATE' })).scan, null);
  assert.equal(state.scan, null);
  assert.equal(state.folderBatch.id, started.batch.id);
  state.scan = { ...fresh, scanPolicyVersion: -1 };
  assert.equal((await prepare()).ok, false);
  state.scan = fresh;
  assert.equal((await send({ type: 'GET_STATE' })).scan.scannedAt, fresh.scannedAt);
});

test('background startup needs no downloads API, restores no legacy jobs and opens the panel inside the click gesture', async () => {
  const { api, state } = setup();
  state.batch = { id: 'old-native', jobs: [{ status: 'queued', file }] };
  const events = [];
  let click;
  let messageListener;
  api.runtime.onMessage = { addListener(listener) { messageListener = listener; } };
  api.runtime.sendMessage = async message => events.push(message);
  api.action = { onClicked: { addListener(listener) { click = listener; } } };
  api.sidePanel = { open(options) { events.push({ open: options }); return Promise.resolve(); } };
  await installBackground(api).ready;
  assert.equal(state.batch, null);
  assert.equal(typeof messageListener, 'function');
  click({ id: 42, windowId: 7 });
  assert.deepEqual(events, [{ open: { windowId: 7 } }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events[1], { type: 'PANEL_SOURCE', tabId: 42, windowId: 7 });
});
